/**
 * Attachment upload — pure validation, the in-flight upload model, and error classification
 * (M2.7, FR-CMP-04). No React, no network: the actual transfer runs through an injected
 * {@link BlobUploader} so the composer's upload hook and its tests share one code path.
 *
 * `UploadItem` is reactive VIEW state ONLY — it is never serialized into the local `drafts` row
 * or an outgoing/Drafts Email. Only a fully-uploaded blob (a `DraftAttachment` with a real
 * `blobId`) is persistable; an item that never finished (or errored) can never be persisted.
 */

import { JmapHttpError, JmapProblemError, ProblemTypes } from '@waxwing/jmap'

/** How a pasted/dropped file is treated: `inline` (image in the body) or `attach` (attachment chip). */
export type AddFilesMode = 'inline' | 'attach'

/** An upload that is still in flight or has failed (a finished one leaves this slice → `draft.attachments`). */
export type AttachmentStatus = 'uploading' | 'error'

export type UploadErrorCode =
  | 'tooLarge'
  | 'totalTooLarge'
  | 'quota'
  | 'network'
  | 'aborted'
  | 'server'

export interface UploadError {
  readonly code: UploadErrorCode
  /** From a 429 `Retry-After`, in milliseconds, when the server provided one. */
  readonly retryAfterMs?: number
}

/** Reactive, serialization-EXCLUDED view state for one in-flight / errored upload. */
export interface UploadItem {
  /** `crypto.randomUUID()` — the chip identity while uploading. */
  readonly tempId: string
  readonly name: string
  /** Media type sent (File.type or the octet-stream fallback). */
  readonly type: string
  readonly size: number
  /** True for a screenshot/dropped-on-editor image inserted into the body. */
  readonly inline: boolean
  /** Set iff `inline` — the future body `cid`. */
  readonly cid: string | null
  /** ObjectURL for an inline preview thumbnail (inline only). */
  readonly previewUrl: string | null
  readonly status: AttachmentStatus
  /**
   * 0..1, and only ever those two values.
   *
   * NOT because "the server cannot stream upload progress", which is what this said and is not
   * true of any party involved: `fetch` has no upload-progress event, and `XMLHttpRequest` — the
   * one browser API that does — would have to be called inside `uploadBlob`, going around the
   * `Transport` seam that every test, `applyAuth` and any proxy deployment hangs on. Recorded as
   * ADR-034, together with the shape a determinate bar would have to arrive in.
   */
  readonly progress: number
  readonly error: UploadError | null
}

export interface ValidationLimits {
  /** Per-file cap (core capability `maxSizeUpload`). */
  readonly maxSizeUpload: number
  /** Total-attachments cap (mail capability `maxSizeAttachmentsPerEmail`); `null` = unlimited. */
  readonly maxSizeAttachmentsPerEmail: number | null
}

/** Used only if the server omits `maxSizeUpload` (a non-conformant Session). */
export const FALLBACK_MAX_UPLOAD = 25_000_000

/** The uploader seam — the ONLY thing that touches the network. Tests inject a fake. */
export type BlobUploader = (
  file: Blob,
  opts: {
    readonly type: string
    readonly signal: AbortSignal
    readonly onProgress?: (p: { loaded: number; total: number | undefined }) => void
  },
) => Promise<{ blobId: string; type: string; size: number }>

/** Per-file check, run BEFORE any network call. */
export function validateFile(size: number, limits: ValidationLimits): UploadError | null {
  return size > limits.maxSizeUpload ? { code: 'tooLarge' } : null
}

/** Total-vs-cap check for `incoming` bytes added on top of `existing` bytes. `null` cap ⇒ never fails. */
export function validateTotal(
  existing: number,
  incoming: number,
  limits: ValidationLimits,
): UploadError | null {
  const cap = limits.maxSizeAttachmentsPerEmail
  return cap !== null && existing + incoming > cap ? { code: 'totalTooLarge' } : null
}

/**
 * Sum of uploaded attachments + IN-FLIGHT uploads (for the total check + a footer readout).
 *
 * An `error` item is deliberately not counted: it carries no blob, it will never be part of the
 * message, and counting it charged the reader for bytes that are not being sent. With a 25 MB cap,
 * 20 MB uploaded and a 10 MB upload that died on the network, the sum came to 30 — Send went grey
 * under "Attachments too large" and every further file was refused as oversized, while the message
 * that would actually go out was 20 MB. `ComposerWindow` says the same thing one line up about
 * Send ("an errored chip must not wedge it") and only the byte sum disagreed (R-53).
 */
export function totalAttachmentBytes(
  attachments: readonly { size: number }[],
  uploads: readonly UploadItem[],
): number {
  let total = 0
  for (const a of attachments) total += a.size
  for (const u of uploads) if (u.status === 'uploading') total += u.size
  return total
}

function isAbortError(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError'
  )
}

/**
 * Map a thrown error to a stable {@link UploadError} (SP.5: oversize=limit/413, quota=429).
 *
 * "Too large" is read from the SIGNAL, not from the status class. RFC 8620 §6.1 says only that an
 * HTTP error on the upload resource SHOULD carry an RFC 7807 problem-details body; the one that
 * means a size limit is `urn:ietf:params:jmap:error:limit` (§3.6.1), and HTTP 413 is the same
 * statement at the transport level. Treating every 400 with a problem body as `tooLarge` — which
 * is what this did — turned `notRequest`, `notJSON` and any server-specific 400 into "this file is
 * too large, max 25 MB" for a 100 KB file, and `AttachmentChips` hides Retry for `tooLarge`, so
 * the only way on was to remove the chip and attach it again (R-54).
 */
export function classifyUploadError(err: unknown): UploadError {
  if (err instanceof JmapProblemError) {
    if (err.status === 429) {
      return err.retryAfterMs !== undefined
        ? { code: 'quota', retryAfterMs: err.retryAfterMs }
        : { code: 'quota' }
    }
    if (err.type === ProblemTypes.limit || err.status === 413) return { code: 'tooLarge' }
    return { code: 'server' }
  }
  // The SAME two statuses without a problem body. RFC 8620 §6.1 only says the upload resource
  // SHOULD carry problem details, so a server that answers a too-large file with a bare 413 — or
  // rate-limits with a bare 429 — is conforming, and the transport surfaces those as
  // `JmapHttpError` (which is why `retryAfterMs` is carried on both classes; see its doc comment).
  // Read as `server`, a bare 413 gave the reader "Server error" plus a Retry button that re-sent
  // the same oversized file and failed identically, every time, with no way to learn the real
  // reason. The status IS the signal here; there is nothing else to read.
  if (err instanceof JmapHttpError) {
    if (err.status === 413) return { code: 'tooLarge' }
    if (err.status === 429) {
      return err.retryAfterMs !== undefined
        ? { code: 'quota', retryAfterMs: err.retryAfterMs }
        : { code: 'quota' }
    }
    return { code: 'server' }
  }
  if (isAbortError(err)) return { code: 'aborted' }
  if (err instanceof TypeError) return { code: 'network' }
  return { code: 'server' }
}
