/**
 * Bridges the ASYNC JMAP blob download to the SYNC `resolveCid` the sanitizer needs (M1.8, FR-RD-03).
 * On the body's `cid:` inline parts it pre-downloads each blob (Authorization-header fetch, SP.4 — no
 * `<img src=downloadUrl>`) into a `blob:` URL, so once `ready` is true the sanitizer can resolve
 * every `cid:` synchronously. All object URLs are revoked on unmount / body change.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSession } from '../app/session/context'
import type { EmailBodyRow } from '../sync'
import { collectCidParts } from './message-body'

export interface InlineImages {
  /** Synchronous `cid` (content-id, no `cid:` prefix) → `blob:` URL, or null. */
  readonly resolveCid: (cid: string) => string | null
  /** True once every inline blob has been downloaded (or there are none) — gate the sanitize pass. */
  readonly ready: boolean
}

export function useInlineImages(accountId: string, body: EmailBodyRow | undefined): InlineImages {
  const { getClient } = useSession()
  const mapRef = useRef(new Map<string, string>())
  const [ready, setReady] = useState(false)
  const parts = useMemo(() => (body ? collectCidParts(body) : []), [body])

  useEffect(() => {
    const client = getClient()
    if (body === undefined || parts.length === 0 || client === null) {
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
          const bytes = await client.download(
            accountId,
            part.blobId,
            part.type,
            part.name ?? 'image',
          )
          if (cancelled) return
          const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: part.type }))
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
  }, [accountId, body, parts, getClient])

  const resolveCid = useCallback((cid: string) => mapRef.current.get(cid) ?? null, [])
  return { resolveCid, ready }
}
