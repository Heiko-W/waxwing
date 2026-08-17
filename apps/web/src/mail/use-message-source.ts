/**
 * The raw RFC 5322 source of one message (M3.9, FR-RD-06) — the bytes behind "View source" and
 * "Save as .eml". An Email's own `blobId` addresses the whole message (RFC 8621 §4.1.1), so this is a
 * plain authenticated download of that blob as `message/rfc822`.
 *
 * ## Three things here are deliberate, and each has a trap behind it
 *
 * **1. It does NOT go through `use-blob` / `blob-cache`, and must never be "unified" with them.**
 * The cache's orphan reaper (`sync/engine/eviction.ts`) deletes any `blobsMeta` row whose `ownerIds`
 * are empty, with no budget check — and ownership is derived by `collectBodyBlobIds`, which walks
 * bodyStructure/textBody/htmlBody/attachments and therefore NEVER contains the Email's own blobId. A
 * cached .eml would be written and then reaped as an orphan on the next maintenance pass: pure churn.
 * `use-message-source.test.ts` guards this by reading this file, because no behavioural test can see it.
 *
 * **2. It downloads rather than linking.** `<a href={downloadUrl} download>` cannot work: the JMAP
 * download endpoint is header-authenticated, and a browser navigation carries no Authorization
 * header. `downloadUrl` is mandatory in every RFC 8620 session, so this needs no capability gate.
 * (RFC 9404 `Blob/get` would be strictly worse — base64-in-JSON bounded by `maxSizeRequest`.)
 *
 * **3. The text is clamped.** A 50 MB message must never be laid out in a `<pre>`; past
 * {@link MAX_SOURCE_TEXT_BYTES} the head is shown and `truncated` is set. `save()` still writes the
 * WHOLE message — the clamp is a rendering limit, not a data limit.
 */

import type { Id } from '@waxwing/jmap'
import { JmapHttpError, JmapProblemError } from '@waxwing/jmap'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSession } from '../app/session/context'
import type { EmailRow } from '../sync'
import { safeFilenameStem } from './safe-filename'

/** How much of the source is rendered. Beyond this the head is shown and `truncated` is set. */
export const MAX_SOURCE_TEXT_BYTES = 1_000_000

/** Longest sanitized subject kept as a filename stem, before `.eml` is appended. */
export const MAX_FILENAME_STEM = 100

/** Filename when the subject sanitizes to nothing (empty, all-punctuation, missing). */
export const FALLBACK_FILENAME = 'message.eml'

export type MessageSourceError = 'offline' | 'notFound' | 'failed'

export interface MessageSource {
  /** The decoded source, clamped to {@link MAX_SOURCE_TEXT_BYTES}; `null` until loaded or on error. */
  readonly text: string | null
  /** True when {@link text} is only the head of a larger message. */
  readonly truncated: boolean
  /** Size of the WHOLE message in bytes (not of {@link text}). */
  readonly bytes: number
  readonly loading: boolean
  readonly error: MessageSourceError | null
  /** Save the whole message as a `.eml` download. A no-op until the bytes have arrived. */
  save(): void
}

/**
 * Turn a subject into a safe `.eml` filename. The subject is attacker-supplied — it is a header the
 * SENDER wrote — and it ends up in a `download` attribute, so it goes through the shared
 * {@link safeFilenameStem}: control characters, bidi/zero-width format characters, the
 * Windows-reserved set, every `..` and any leading dot, trailing dots/space. That strip moved to
 * `safe-filename.ts` because the attachment strip needs exactly the same one and had none of it; its
 * header carries the reasoning per rule, and the measurement of how much of the DOWNLOAD half the
 * browsers already do for us.
 *
 * Two things stay local. The clamp is {@link MAX_FILENAME_STEM}, tighter than the shared default,
 * because a subject is prose rather than a filename and 100 characters of it is already more than
 * any download shelf shows. And `.eml` is appended last, unconditionally: the BYTES are therefore
 * always safe — the file can never *be* executable — while a name that merely READS as `.exe` is a
 * trust problem regardless, which is what the bidi strip answers.
 */
export function sourceFilename(subject: string | null): string {
  const stem = safeFilenameStem(subject ?? '', MAX_FILENAME_STEM)
  return stem === '' ? FALLBACK_FILENAME : `${stem}.eml`
}

/** Map a failed download to the three states the dialog can actually say something useful about. */
export function classifySourceError(error: unknown): MessageSourceError {
  // `fetch` rejects with a TypeError when the network is unreachable — the same discrimination
  // `compose/attachment-upload.ts` makes.
  if (error instanceof TypeError) return 'offline'
  if (error instanceof JmapHttpError || error instanceof JmapProblemError) {
    return error.status === 404 ? 'notFound' : 'failed'
  }
  return 'failed'
}

interface SourceState {
  readonly data: Uint8Array | null
  readonly loading: boolean
  readonly error: MessageSourceError | null
}

const IDLE: SourceState = { data: null, loading: false, error: null }

export function useMessageSource(accountId: Id, email: EmailRow, active: boolean): MessageSource {
  const { getClient } = useSession()
  const [state, setState] = useState<SourceState>(IDLE)
  const filename = useMemo(() => sourceFilename(email.subject), [email.subject])
  const blobId = email.blobId

  useEffect(() => {
    // The whole point of `active`: opening a message must not pull its raw source down with it.
    if (!active) {
      setState(IDLE)
      return
    }
    const client = getClient()
    if (client === null) {
      setState({ data: null, loading: false, error: 'offline' })
      return
    }
    let cancelled = false
    // Abort, do not merely ignore. Without the signal a closed dialog leaves the whole message
    // streaming into a buffer nobody will read — close and reopen a 50 MB .eml a few times and the
    // discarded downloads pile up concurrently. `use-attachment-upload.ts:206` is the precedent.
    const aborter = new AbortController()
    setState({ data: null, loading: true, error: null })
    client
      .download(accountId, blobId, 'message/rfc822', filename, { signal: aborter.signal })
      .then((data) => {
        if (!cancelled) setState({ data, loading: false, error: null })
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ data: null, loading: false, error: classifySourceError(error) })
      })
    return () => {
      cancelled = true
      aborter.abort()
    }
  }, [active, accountId, blobId, filename, getClient])

  const { data } = state
  const text = useMemo(() => {
    if (data === null) return null
    const head =
      data.byteLength > MAX_SOURCE_TEXT_BYTES ? data.subarray(0, MAX_SOURCE_TEXT_BYTES) : data
    // Non-fatal: a message is bytes, not necessarily UTF-8 (an 8-bit body in an unknown charset is
    // legal), and a decode that THREW would leave the reader with nothing at all rather than a few
    // replacement characters in a view whose whole purpose is showing what actually arrived.
    return new TextDecoder('utf-8', { fatal: false }).decode(head)
  }, [data])

  const save = useCallback(() => {
    if (data === null) return
    // One-shot, unlike AttachmentList's reuse cache: nothing here is ever re-shown, so the URL is
    // revoked as soon as the click has consumed it rather than parked until unmount.
    // (`new Uint8Array(data)` re-wraps the bytes over a plain ArrayBuffer — the same copy `use-blob`
    // makes, since a `Uint8Array<ArrayBufferLike>` is not a `BlobPart`.)
    const url = URL.createObjectURL(new Blob([new Uint8Array(data)], { type: 'message/rfc822' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    anchor.click()
    // Revoke on the NEXT task, not synchronously after `click()`. Activating an `<a download>`
    // *queues* the fetch (HTML "download the hyperlink"); it does not complete it. Chromium happens
    // to resolve the blob URL during click dispatch — verified: the save produces a correct .eml —
    // but that is implementation luck, not a guarantee, and revoking first would make the store
    // entry unresolvable and the download silently empty. This is exactly why FileSaver.js and its
    // kin defer the revoke. No leak: the timer always fires, unmount or not.
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }, [data, filename])

  return {
    text,
    truncated: data !== null && data.byteLength > MAX_SOURCE_TEXT_BYTES,
    bytes: data?.byteLength ?? 0,
    loading: state.loading,
    error: state.error,
    save,
  }
}
