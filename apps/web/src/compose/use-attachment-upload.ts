/**
 * Composer attachment controller (M2.7, FR-CMP-04). Validates + uploads files through an injected
 * {@link BlobUploader} (the session client in production, a fake in tests), tracks per-file
 * progress/errors in the composer store's `uploads` slice, inserts inline images optimistically, and
 * supports cancel + retry. ONLY a fully-uploaded blob reaches `draft.attachments` (the persistable
 * set) — an in-flight or errored upload is never serialized. A failed upload never loses the draft.
 *
 * Impure per-upload handles (the `File` + `AbortController`) live in a module-scoped registry, not
 * React state, so they survive a ComposerWindow remount (minimize/restore); inline preview objectURLs
 * live in {@link inline-image-registry} keyed by `cid`.
 */

import {
  DEFAULT_BLOB_TYPE,
  getCoreCapability,
  getMailCapability,
  type JmapClient,
} from '@waxwing/jmap'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useSessionOptional } from '../app/session/context'
import { formatBytes } from '../i18n/formatters'
import { useToast } from '../ui'
import {
  type AddFilesMode,
  type BlobUploader,
  classifyUploadError,
  FALLBACK_MAX_UPLOAD,
  totalAttachmentBytes,
  type UploadError,
  type ValidationLimits,
  validateFile,
  validateTotal,
} from './attachment-upload'
import { useComposerStore } from './composer-store'
import { putInlineObjectUrl, revokeInlineObjectUrl } from './inline-image-registry'
import { removeInlineImage } from './inline-images'

/** Production {@link BlobUploader}: uploads to the session `uploadUrl` via the JMAP client. */
export function makeBlobUploader(client: JmapClient, accountId: string): BlobUploader {
  return (file, opts) => {
    const options: Parameters<JmapClient['upload']>[2] = { type: opts.type, signal: opts.signal }
    if (opts.onProgress) options.onProgress = opts.onProgress
    return client
      .upload(accountId, file, options)
      .then((result) => ({ blobId: result.blobId, type: result.type, size: result.size }))
  }
}

// ── Module-scoped concurrency pool (bounded by the server's maxConcurrentUpload) ───────────────
let concurrency = 4
let active = 0
const waiters: (() => void)[] = []
function setUploadConcurrency(limit: number): void {
  if (limit > 0) concurrency = limit
}
function acquireSlot(): Promise<void> {
  if (active < concurrency) {
    active += 1
    return Promise.resolve()
  }
  return new Promise((resolve) => waiters.push(resolve))
}
function releaseSlot(): void {
  const next = waiters.shift()
  if (next !== undefined)
    next() // hand the slot straight on — `active` unchanged
  else active -= 1
}

// ── Impure per-upload handles (survive a window remount) ───────────────────────────────────────
interface PendingUpload {
  readonly file: File
  readonly draftId: string
  readonly name: string
  readonly type: string
  readonly cid: string | null
  controller: AbortController
}
const pending = new Map<string, PendingUpload>()

function makeCid(): string {
  return `${crypto.randomUUID()}@waxwing.local`
}

export interface UseAttachmentUploadOptions {
  /** Injected uploader (tests). Production builds one from the session client. */
  readonly uploader?: BlobUploader | undefined
  /** Injected limits (tests). Production reads the JMAP capabilities. */
  readonly limits?: ValidationLimits | undefined
  /** Insert an inline `<img>` preview into the live editor; returns false if the editor isn't ready. */
  readonly insertInlineImage?:
    | ((objectUrl: string, cid: string, alt: string) => boolean)
    | undefined
}

export interface AttachmentController {
  /** Validate + start uploads. Inline images are inserted into the editor immediately (optimistic). */
  addFiles(files: readonly File[], mode: AddFilesMode): void
  /** Cancel an in-flight upload (abort) or drop an errored one; revokes an inline preview. */
  removeUpload(tempId: string): void
  /** Re-run a failed upload with the same File. */
  retry(tempId: string): void
  /** Remove a fully-uploaded attachment by blobId (and strip its inline `<img>`, if any). */
  removeAttachment(blobId: string): void
  /** False before the session connects (no uploader) — the UI disables the attach affordances. */
  readonly canUpload: boolean
}

export function useAttachmentUpload(
  draftId: string,
  options?: UseAttachmentUploadOptions,
): AttachmentController {
  const { t } = useTranslation()
  const { toast } = useToast()
  const session = useSessionOptional()

  const uploader = useMemo<BlobUploader | undefined>(() => {
    if (options?.uploader) return options.uploader
    return session === null ? undefined : makeBlobUploader(session.client, session.accountId)
  }, [options?.uploader, session])

  const limits = useMemo<ValidationLimits>(() => {
    if (options?.limits) return options.limits
    const jmapSession = session?.jmapSession
    const maxSizeUpload =
      (jmapSession ? getCoreCapability(jmapSession)?.maxSizeUpload : undefined) ??
      FALLBACK_MAX_UPLOAD
    const mailCap =
      jmapSession && session ? getMailCapability(jmapSession, session.accountId) : null
    return {
      maxSizeUpload,
      maxSizeAttachmentsPerEmail: mailCap?.maxSizeAttachmentsPerEmail ?? null,
    }
  }, [options?.limits, session])

  useEffect(() => {
    const jmapSession = session?.jmapSession
    setUploadConcurrency(
      (jmapSession ? getCoreCapability(jmapSession)?.maxConcurrentUpload : undefined) ?? 4,
    )
  }, [session])

  // On unmount, if the draft is GONE (closed/discarded — not merely minimized, which keeps the draft
  // and lets uploads finish in the background), abort its still-in-flight uploads, revoke their inline
  // previews, and drop their registry entries so nothing leaks.
  useEffect(() => {
    return () => {
      if (useComposerStore.getState().drafts.has(draftId)) return
      for (const [tempId, item] of pending) {
        if (item.draftId !== draftId) continue
        item.controller.abort()
        if (item.cid !== null) revokeInlineObjectUrl(item.cid)
        pending.delete(tempId)
      }
    }
  }, [draftId])

  // Stable refs so the callbacks below never go stale on a session/limits change.
  const uploaderRef = useRef(uploader)
  uploaderRef.current = uploader
  const limitsRef = useRef(limits)
  limitsRef.current = limits
  const insertRef = useRef(options?.insertInlineImage)
  insertRef.current = options?.insertInlineImage

  const toastValidation = useCallback(
    (error: UploadError, name: string): void => {
      const cap = limitsRef.current.maxSizeAttachmentsPerEmail
      if (error.code === 'tooLarge') {
        toast({
          tone: 'danger',
          title: t('compose.attachTooLarge', {
            name,
            max: formatBytes(limitsRef.current.maxSizeUpload),
          }),
        })
      } else if (error.code === 'totalTooLarge') {
        toast({
          tone: 'danger',
          title: t('compose.attachTotalTooLarge', { max: cap !== null ? formatBytes(cap) : '' }),
        })
      }
    },
    [t, toast],
  )

  const startUpload = useCallback(
    async (tempId: string): Promise<void> => {
      const uploaderNow = uploaderRef.current
      const item = pending.get(tempId)
      if (uploaderNow === undefined || item === undefined) return
      await acquireSlot()
      if (!pending.has(tempId)) {
        releaseSlot() // cancelled while queued
        return
      }
      const store = useComposerStore.getState()
      try {
        const result = await uploaderNow(item.file, {
          type: item.type,
          signal: item.controller.signal,
          onProgress: (progress) => {
            if (progress.total !== undefined && progress.total > 0) {
              store.patchUpload(item.draftId, tempId, {
                progress: Math.min(1, progress.loaded / progress.total),
              })
            }
          },
        })
        pending.delete(tempId)
        store.addAttachments(item.draftId, [
          {
            blobId: result.blobId,
            name: item.name,
            type: result.type,
            size: result.size,
            cid: item.cid,
          },
        ])
        store.removeUpload(item.draftId, tempId)
      } catch (error) {
        const classified = classifyUploadError(error)
        if (classified.code === 'aborted') return // removeUpload already cleaned the state up
        store.patchUpload(item.draftId, tempId, { status: 'error', progress: 0, error: classified })
        if (classified.code === 'quota') toast({ tone: 'danger', title: t('compose.attachQuota') })
        else if (classified.code === 'network') {
          toast({ tone: 'danger', title: t('compose.attachNetworkError') })
        }
      } finally {
        releaseSlot()
      }
    },
    [t, toast],
  )

  const addFiles = useCallback(
    (files: readonly File[], mode: AddFilesMode): void => {
      if (uploaderRef.current === undefined) return
      const store = useComposerStore.getState()
      if (!store.drafts.has(draftId)) return
      for (const file of files) {
        const type = file.type || DEFAULT_BLOB_TYPE
        const perFile = validateFile(file.size, limitsRef.current)
        if (perFile !== null) {
          toastValidation(perFile, file.name)
          continue
        }
        const now = useComposerStore.getState()
        const existing = totalAttachmentBytes(
          now.drafts.get(draftId)?.attachments ?? [],
          now.uploads.get(draftId) ?? [],
        )
        const totalError = validateTotal(existing, file.size, limitsRef.current)
        if (totalError !== null) {
          toastValidation(totalError, file.name)
          continue
        }
        const tempId = crypto.randomUUID()
        let inline = mode === 'inline' && file.type.startsWith('image/')
        let cid = inline ? makeCid() : null
        let previewUrl = inline ? URL.createObjectURL(file) : null
        if (inline && cid !== null && previewUrl !== null) {
          if (insertRef.current?.(previewUrl, cid, file.name) ?? false) {
            putInlineObjectUrl(cid, previewUrl)
          } else {
            // The editor wasn't ready → fall back to a regular attachment so the image is never lost
            // (the body would otherwise reference a cid it does not contain).
            URL.revokeObjectURL(previewUrl)
            inline = false
            cid = null
            previewUrl = null
          }
        }
        pending.set(tempId, {
          file,
          draftId,
          name: file.name,
          type,
          cid,
          controller: new AbortController(),
        })
        now.addUpload(draftId, {
          tempId,
          name: file.name,
          type,
          size: file.size,
          inline,
          cid,
          previewUrl,
          status: 'uploading',
          progress: 0,
          error: null,
        })
        void startUpload(tempId)
      }
    },
    [draftId, startUpload, toastValidation],
  )

  const removeUpload = useCallback(
    (tempId: string): void => {
      const item = pending.get(tempId)
      if (item !== undefined) {
        item.controller.abort()
        if (item.cid !== null) {
          revokeInlineObjectUrl(item.cid)
          const draft = useComposerStore.getState().drafts.get(draftId)
          if (draft !== undefined) {
            useComposerStore.getState().updateBody(draftId, removeInlineImage(draft.body, item.cid))
          }
        }
        pending.delete(tempId)
      }
      useComposerStore.getState().removeUpload(draftId, tempId)
    },
    [draftId],
  )

  const retry = useCallback(
    (tempId: string): void => {
      const item = pending.get(tempId)
      if (item === undefined) return
      item.controller = new AbortController()
      useComposerStore
        .getState()
        .patchUpload(draftId, tempId, { status: 'uploading', progress: 0, error: null })
      void startUpload(tempId)
    },
    [draftId, startUpload],
  )

  const removeAttachment = useCallback(
    (blobId: string): void => {
      const removed = useComposerStore
        .getState()
        .drafts.get(draftId)
        ?.attachments.find((a) => a.blobId === blobId)
      useComposerStore.getState().removeAttachment(draftId, blobId)
      if (removed?.cid != null) {
        revokeInlineObjectUrl(removed.cid)
        const draft = useComposerStore.getState().drafts.get(draftId)
        if (draft !== undefined) {
          useComposerStore
            .getState()
            .updateBody(draftId, removeInlineImage(draft.body, removed.cid))
        }
      }
    },
    [draftId],
  )

  return useMemo<AttachmentController>(
    () => ({ addFiles, removeUpload, retry, removeAttachment, canUpload: uploader !== undefined }),
    [addFiles, removeUpload, retry, removeAttachment, uploader],
  )
}
