/**
 * Attachment upload — pure validation, the in-flight upload model, and error classification
 * (M2.7, FR-CMP-04). No React, no network: the actual transfer runs through an injected
 * {@link BlobUploader} so the composer's upload hook and its tests share one code path.
 *
 * `UploadItem` is reactive VIEW state ONLY — it is never serialized into the local `drafts` row
 * or an outgoing/Drafts Email. Only a fully-uploaded blob (a `DraftAttachment` with a real
 * `blobId`) is persistable; an item that never finished (or errored) can never be persisted.
 */

import { JmapProblemError, ProblemTypes } from '@waxwing/jmap'

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
  /** 0..1 (0 at start, 1 at completion — the server cannot stream upload progress). */
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

/** Sum of uploaded attachments + in-flight uploads (for the total check + a footer readout). */
export function totalAttachmentBytes(
  attachments: readonly { size: number }[],
  uploads: readonly UploadItem[],
): number {
  let total = 0
  for (const a of attachments) total += a.size
  for (const u of uploads) total += u.size
  return total
}

function isAbortError(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError'
  )
}

/** Map a thrown error to a stable {@link UploadError} (SP.5: oversize=400/limit, quota=429). */
export function classifyUploadError(err: unknown): UploadError {
  if (err instanceof JmapProblemError) {
    if (err.status === 429) {
      return err.retryAfterMs !== undefined
        ? { code: 'quota', retryAfterMs: err.retryAfterMs }
        : { code: 'quota' }
    }
    if (err.type === ProblemTypes.limit || err.status === 400) return { code: 'tooLarge' }
    return { code: 'server' }
  }
  if (isAbortError(err)) return { code: 'aborted' }
  if (err instanceof TypeError) return { code: 'network' }
  return { code: 'server' }
}
