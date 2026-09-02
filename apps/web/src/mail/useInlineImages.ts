/**
 * Bridges the ASYNC JMAP blob download to the SYNC `resolveCid` the sanitizer needs (M1.8, FR-RD-03).
 * On the body's `cid:` inline parts it pre-downloads each blob (Authorization-header fetch, SP.4 — no
 * `<img src=downloadUrl>`) into a `blob:` URL, so once `ready` is true the sanitizer can resolve
 * every `cid:` synchronously. All object URLs are revoked on unmount / body change.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { EmailBodyRow } from '../sync'
import { collectCidParts } from './message-body'
import { useBlobFetcher } from './use-blob'

export interface InlineImages {
  /** Synchronous `cid` (content-id, no `cid:` prefix) → `blob:` URL, or null. */
  readonly resolveCid: (cid: string) => string | null
  /** True once every inline blob has been downloaded (or there are none) — gate the sanitize pass. */
  readonly ready: boolean
}

export function useInlineImages(accountId: string, body: EmailBodyRow | undefined): InlineImages {
  const fetchBlob = useBlobFetcher(accountId)
  const mapRef = useRef(new Map<string, string>())
  const [ready, setReady] = useState(false)
  const walked = useMemo(() => (body ? collectCidParts(body) : []), [body])

  /*
   * The pipeline below is keyed on WHAT the parts are, not on which object they arrived in (R-46).
   *
   * Opening a cached message runs `useEmailBody` (a liveQuery read) and `fetchBody` at the same
   * time, and `fetchBody` writes an LRU stamp onto the very row the liveQuery is watching. The
   * `readwrite` transaction can only commit after the `readonly` one, so the row is emitted twice:
   * first as it was, then again — byte-identical — with a new object identity. Keyed on identity,
   * the effect tore its own run down on that second emission, revoked every object URL it had
   * already made and re-read every `cid:` blob out of IndexedDB. `engine.ts` no longer writes the
   * pointless stamp, but a duplicate emission is a thing a liveQuery is allowed to produce, and this
   * hook should not care.
   *
   * `parts` is therefore re-derived only when the fingerprint changes; between two emissions of the
   * same body it is the SAME array, so the effect below does not re-run at all.
   */
  const partsKey =
    body === undefined
      ? ''
      : `${body.id}\u0000${walked.map((part) => `${part.cid}:${part.blobId}:${part.type}`).join('|')}`
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the CONTENT fingerprint on purpose — `walked` is a fresh array per body identity, which is exactly what must not drive this (R-46).
  const parts = useMemo(() => walked, [partsKey])
  const hasBody = body !== undefined

  useEffect(() => {
    // "No body yet" is not "no images to load", and conflating the two produced a real transient.
    // `ready` used to be set TRUE here while the body was still being fetched; on the commit where
    // the body arrives, `loading` flips false while `ready` is still that stale true — so for one
    // commit `bodyReady` (`!loading && ready`, MessageView) claimed the message was quotable before
    // this effect had even looked for a `cid:` part. That is precisely the window the compose gate
    // exists to close: reply in it and the draft is seeded from an unsanitized body. Caught by CI as
    // a one-in-many flake in the gate's own test, which is the only way a single-commit state gets
    // noticed at all.
    if (!hasBody) {
      mapRef.current = new Map()
      setReady(false)
      return
    }
    if (parts.length === 0) {
      mapRef.current = new Map()
      setReady(true)
      return
    }
    let cancelled = false
    const urls: string[] = []
    const map = new Map<string, string>()
    setReady(false)
    void (async () => {
      for (const part of parts) {
        try {
          // M3.4: through the write-through cache, so re-opening the message (or opening it offline)
          // resolves every `cid:` from the replica instead of re-downloading each image.
          const blob = await fetchBlob({
            blobId: part.blobId,
            type: part.type,
            name: part.name ?? 'image',
            size: part.size,
          })
          if (cancelled) return
          if (blob === null) continue
          const url = URL.createObjectURL(blob)
          urls.push(url)
          map.set(part.cid, url)
        } catch {
          // Skip an inline image that fails to download; the sanitizer drops the unresolved cid.
        }
      }
      if (cancelled) return
      mapRef.current = map
      setReady(true)
    })()
    return () => {
      cancelled = true
      for (const url of urls) URL.revokeObjectURL(url)
    }
  }, [hasBody, parts, fetchBlob])

  const resolveCid = useCallback((cid: string) => mapRef.current.get(cid) ?? null, [])
  return { resolveCid, ready }
}
