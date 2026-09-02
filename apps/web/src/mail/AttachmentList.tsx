/**
 * The attachment strip below a message (M1.8, FR-RD-05). Lists the message's non-inline parts with a
 * type icon, filename and human size, a per-file Download, an optional "Save all", and an inline
 * preview for the types `preview-policy.ts` allows. A preview is rendered in a SEPARATE sandboxed
 * surface (an `<img>` or a script-free `<iframe sandbox>`) that is OUTSIDE the mail body frame, and
 * every blob object URL is revoked on unmount. Downloads go through the authenticated JMAP blob endpoint (never a bare URL).
 *
 * The filename is the SENDER's, in both places it appears: `safe-filename.ts` strips it for the
 * `download` attribute and, separately, for the text — a `<bdi>` around the label completes the
 * second half. The icon beside it is derived from the sender-DECLARED MIME type and is therefore a
 * claim, not a fact; nothing here verifies the bytes.
 *
 * A `winmail.dat` (M5.21) is offered for unpacking rather than hidden: the container is what the
 * sender actually attached, and a reader who cannot see it cannot forward it to someone whose
 * client copes. The decoder is a lazy chunk — nobody who never receives Outlook rich-text mail
 * downloads it.
 *
 * A signed message's signature part is NOT listed. It has a blobId and no `cid`, so RFC 8621 puts
 * it in `attachments` — but it is machinery, not a file, and showing it gives every signed message
 * a mystery attachment nobody can open. `isProtectionPart` is the rule; "Show source" is the way
 * to get at it anyway.
 */

import type { EmailBodyPart, Id } from '@waxwing/jmap'
import { Download } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatBytes } from '../i18n/formatters'
import { Button, IconButton, Spinner, useToast } from '../ui'
import { attachmentIcon } from './attachment-icon'
import { isProtectionPart } from './encrypted-message'
import { NestedMessageView } from './NestedMessageView'
import { isPreviewable, previewSurface } from './preview-policy'
import styles from './reading.module.css'
import { displayFilename, safeDownloadName } from './safe-filename'
import type { TnefAttachment } from './tnef'
import { isTnefPart } from './tnef-detect'
import { classifyBlobError, useBlobFetcher } from './use-blob'

export interface AttachmentListProps {
  readonly accountId: Id
  readonly attachments: EmailBodyPart[]
  /** Names the "save all" archive. Optional: without it the file is called `attachments.zip`. */
  readonly subject?: string | null
}

/**
 * Real attachments: a downloadable blob that is neither an inline (cid) body image nor the
 * cryptographic machinery of a signed or encrypted message (M5.19, see `isProtectionPart`).
 */
function isAttachment(part: EmailBodyPart): part is EmailBodyPart & { blobId: Id } {
  if (part.blobId === null) return false
  if (isProtectionPart(part.type)) return false
  return !(part.cid !== null && part.disposition === 'inline')
}

/** An attached email (M3.9, FR-RD-07) — opens as a nested in-app view, not a download preview. */
function isMessage(type: string): boolean {
  return type === 'message/rfc822'
}

/**
 * The `download` value for a part whose name is missing or strips to nothing. Not localized on
 * purpose: it becomes a file on disk, and a filename that changes with the UI language is a file the
 * reader cannot find again. The visible label DOES use the localized "unnamed" string.
 */
const DOWNLOAD_FALLBACK = 'attachment'

/**
 * The `busy` sentinel for the archive action.
 *
 * `busy` otherwise holds a blobId, and the archive belongs to no single one. A value no blobId can
 * take keeps the two apart without widening the state.
 */
const SAVE_ALL_BUSY = '\0save-all'

export function AttachmentList({ accountId, attachments, subject }: AttachmentListProps) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const fetchBlob = useBlobFetcher(accountId)
  // One object URL per blob, reused across preview toggles and downloads and revoked once on unmount
  // — so re-opening a preview neither re-downloads nor leaks a superseded blob: URL.
  const urlCacheRef = useRef(new Map<Id, string>())
  const [busy, setBusy] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ blobId: Id; type: string; url: string } | null>(null)
  // The attached message currently expanded inline (M3.9, FR-RD-07); null = none open.
  const [openMessage, setOpenMessage] = useState<Id | null>(null)
  // blobId → what was inside its TNEF container. An EMPTY array is a real answer ("nothing in
  // there"), which is why this is a map rather than a nullable list.
  const [unpacked, setUnpacked] = useState<Record<Id, readonly TnefAttachment[]>>({})

  const items = attachments.filter(isAttachment)

  /**
   * The name this strip SHOWS for a part — stripped, never the sender's raw string, and never empty.
   *
   * Hoisted out of the row markup because the failure messages below name the file too, and a toast
   * that calls it something the row does not is a toast about a different attachment.
   */
  const nameOf = useCallback(
    (part: EmailBodyPart): string => {
      const shown = part.name !== null ? displayFilename(part.name) : ''
      return shown === '' ? t('reading.attachments.unnamed') : shown
    },
    [t],
  )

  /*
   * Why every action here now has a `catch`, and why it TOASTS.
   *
   * These are downloads over the network, in an app whose whole point is working offline. Clicking
   * Download on a blob that is not cached, with no connection, did exactly nothing: the spinner went
   * out again (`finally`) and the rejection went to the console, which is not a place anybody looks.
   * The neighbouring surfaces — `MessageSourceDialog`, `NestedMessageView` — have classified and
   * shown their failures all along; this strip was the one that did not.
   *
   * `null` from the fetcher is the same event wearing different clothes: it means there is no
   * client, i.e. nothing is connected, and it was likewise silent.
   */
  const reportFailure = useCallback(
    (error: unknown, name: string): void => {
      toast({
        title: t(`reading.attachments.error.${classifyBlobError(error)}`, { name }),
        tone: 'danger',
      })
    },
    [toast, t],
  )
  const reportDisconnected = useCallback(
    (name: string): void => {
      toast({ title: t('reading.attachments.error.offline', { name }), tone: 'danger' })
    },
    [toast, t],
  )

  useEffect(() => {
    const cache = urlCacheRef.current
    return () => {
      for (const url of cache.values()) URL.revokeObjectURL(url)
      cache.clear()
    }
  }, [])

  const fetchUrl = useCallback(
    async (part: EmailBodyPart & { blobId: Id }): Promise<string | null> => {
      const cached = urlCacheRef.current.get(part.blobId)
      if (cached !== undefined) return cached
      // M3.4: through the write-through cache — a re-open (or an offline open) hits the replica.
      const blob = await fetchBlob({
        blobId: part.blobId,
        type: part.type,
        name: part.name,
        size: part.size,
      })
      if (blob === null) return null
      const url = URL.createObjectURL(blob)
      urlCacheRef.current.set(part.blobId, url)
      return url
    },
    [fetchBlob],
  )

  const saveOne = useCallback(
    async (part: EmailBodyPart & { blobId: Id }): Promise<void> => {
      setBusy(part.blobId)
      try {
        const url = await fetchUrl(part)
        if (url === null) {
          reportDisconnected(nameOf(part))
          return
        }
        const anchor = document.createElement('a')
        anchor.href = url
        // Never `part.name` raw: it is the sender's string and this is a filesystem name. Chromium
        // and WebKit sanitize `download` themselves (measured), but that is a mitigation this app
        // neither controls nor can assume of every engine.
        anchor.download = safeDownloadName(part.name, DOWNLOAD_FALLBACK)
        anchor.click()
      } catch (error) {
        reportFailure(error, nameOf(part))
      } finally {
        setBusy(null)
      }
    },
    [fetchUrl, nameOf, reportFailure, reportDisconnected],
  )

  /**
   * Downloads every attachment and hands over ONE `.zip`.
   *
   * This used to fire `saveOne` per attachment, which asks the browser to start n downloads in a
   * loop — Chromium prompts for "multiple downloads" permission and Safari drops all but the first.
   * A single archive is one download, and it is also what a reader means by "save all".
   */
  const saveAll = useCallback(async (): Promise<void> => {
    setBusy(SAVE_ALL_BUSY)
    try {
      // `allSettled`, not `all`: one unreachable blob used to reject the whole batch, so a message
      // with nine cached attachments and one that is not produced no archive and no explanation.
      // Now the nine are archived and the tenth is named.
      const fetched = await Promise.allSettled(
        items.map(async (part) => {
          const blob = await fetchBlob({
            blobId: part.blobId,
            type: part.type,
            name: part.name,
            size: part.size,
          })
          // `null` is "nothing is connected" — a failure like any other as far as this archive is
          // concerned, so it is rejected rather than filtered away without a word.
          if (blob === null) throw new TypeError('no client')
          return { name: safeDownloadName(part.name, DOWNLOAD_FALLBACK), blob }
        }),
      )
      const entries = fetched
        .filter((result) => result.status === 'fulfilled')
        .map((result) => result.value)
      const missing = items
        .filter((_part, index) => fetched[index]?.status === 'rejected')
        .map((part) => nameOf(part))
      // Every attachment failed to download — there is nothing to put in an archive, and an empty
      // zip would look like success.
      if (entries.length === 0) {
        toast({ title: t('reading.attachments.error.saveAllFailed'), tone: 'danger' })
        return
      }
      if (missing.length > 0) {
        toast({
          title: t('reading.attachments.error.saveAllPartial', { names: missing.join(', ') }),
          tone: 'danger',
        })
      }

      const { buildZip, zipFilename } = await import('./attachment-zip')
      const archive = await buildZip(entries)
      const url = URL.createObjectURL(archive)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = zipFilename(subject)
      anchor.click()
      // Not cached in `urlCacheRef`: this URL addresses a one-off archive, not a blob the pane will
      // show again. Revoked on a later tick so the click has taken it (same idiom as the .eml save).
      setTimeout(() => URL.revokeObjectURL(url), 0)
    } catch {
      // Not the per-blob failures — those are settled above. This is the archive itself: the lazy
      // zip chunk failing to load, or `buildZip` refusing. Nothing was saved either way.
      toast({ title: t('reading.attachments.error.saveAllFailed'), tone: 'danger' })
    } finally {
      setBusy(null)
    }
  }, [items, fetchBlob, subject, nameOf, toast, t])

  const unpack = useCallback(
    async (part: EmailBodyPart & { blobId: Id }): Promise<void> => {
      setBusy(part.blobId)
      try {
        const blob = await fetchBlob({
          blobId: part.blobId,
          type: part.type,
          name: part.name,
          size: part.size,
        })
        if (blob === null) {
          reportDisconnected(nameOf(part))
          return
        }
        // Lazily imported so the decoder stays out of the eager bundle — see `.size-limit.js`.
        const { extractTnefAttachments } = await import('./tnef')
        const bytes = new Uint8Array(await blob.arrayBuffer())
        setUnpacked((current) => ({ ...current, [part.blobId]: extractTnefAttachments(bytes) }))
      } catch (error) {
        reportFailure(error, nameOf(part))
      } finally {
        setBusy(null)
      }
    },
    [fetchBlob, nameOf, reportFailure, reportDisconnected],
  )

  const saveInner = useCallback((file: TnefAttachment): void => {
    const blob = new Blob([file.bytes as BlobPart], { type: 'application/octet-stream' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    // The name came out of the container, which came from the sender. Same rule as every other
    // filename here: it becomes a path on disk, so it goes through `safeDownloadName` first.
    anchor.download = safeDownloadName(file.name, DOWNLOAD_FALLBACK)
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }, [])

  const togglePreview = useCallback(
    async (part: EmailBodyPart & { blobId: Id }): Promise<void> => {
      if (preview?.blobId === part.blobId) {
        setPreview(null)
        return
      }
      setBusy(part.blobId)
      try {
        const url = await fetchUrl(part)
        if (url === null) reportDisconnected(nameOf(part))
        else setPreview({ blobId: part.blobId, type: part.type, url })
      } catch (error) {
        reportFailure(error, nameOf(part))
      } finally {
        setBusy(null)
      }
    },
    [fetchUrl, preview, nameOf, reportFailure, reportDisconnected],
  )

  if (items.length === 0) return null

  return (
    <section className={styles.attachments} aria-label={t('reading.attachments.title')}>
      <div className={styles.attachmentsHead}>
        {/* The count belongs INSIDE the string (R-50): " (n)" is a typographic convention, not a
            universal one, and a number in a sentence is what `{{count}}` is for. `title` stays as
            the bare label for the section's `aria-label`, which names the region rather than
            counting it. */}
        <h3 className={styles.attachmentsTitle}>
          {t('reading.attachments.titleCount', { count: items.length })}
        </h3>
        {items.length > 1 && (
          <Button
            size="sm"
            variant="ghost"
            loading={busy === SAVE_ALL_BUSY}
            onClick={() => void saveAll()}
          >
            {t('reading.attachments.saveAll')}
          </Button>
        )}
      </div>
      <ul className={styles.attachmentItems}>
        {items.map((part) => {
          const Icon = attachmentIcon(part.type)
          // `nameOf`, which strips: `Invoice<U+202E>gpj.exe` rendered as `Invoiceexe.jpg` is this
          // app telling the reader the file is an image. The same function feeds the visible text,
          // every `aria-label` built from it AND the failure toasts, so none of them can name the
          // file differently from the others.
          const label = nameOf(part)
          const open = preview?.blobId === part.blobId
          return (
            <li key={part.blobId} className={styles.attachment}>
              <div className={styles.attachmentMain}>
                <Icon aria-hidden="true" className={styles.attachmentIcon} />
                {/* `<bdi>` and not a plain span: the strip above removes the characters that
                    REVERSE a name, but a filename in Hebrew or Arabic is legitimately RTL and would
                    still drag the size and the buttons after it into its own direction. Isolation is
                    the fix for that; it is not a second security measure. */}
                <bdi className={styles.attachmentName} title={label}>
                  {label}
                </bdi>
                <span className={styles.attachmentSize}>{formatBytes(part.size)}</span>
                {busy === part.blobId && <Spinner size="sm" label={t('ui.spinner.label')} />}
                {isPreviewable(part.type) && (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-expanded={open}
                    // A message with three attachments renders three buttons all called "Preview"
                    // (B20.1). The visible text stays short; the accessible name carries the
                    // filename, PREFIXED by that visible text so voice control still matches it
                    // (WCAG 2.5.3 Label in Name).
                    aria-label={
                      open
                        ? t('reading.attachments.hidePreviewNamed', { name: label })
                        : t('reading.attachments.previewNamed', { name: label })
                    }
                    onClick={() => void togglePreview(part)}
                  >
                    {open ? t('reading.attachments.hidePreview') : t('reading.attachments.preview')}
                  </Button>
                )}
                {/* message/rfc822 is not previewable, so Preview and Open are mutually exclusive. */}
                {isMessage(part.type) && (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-expanded={openMessage === part.blobId}
                    aria-label={
                      openMessage === part.blobId
                        ? t('reading.nested.closeNamed', { name: label })
                        : t('reading.nested.openNamed', { name: label })
                    }
                    onClick={() =>
                      setOpenMessage((current) => (current === part.blobId ? null : part.blobId))
                    }
                  >
                    {openMessage === part.blobId
                      ? t('reading.nested.close')
                      : t('reading.nested.open')}
                  </Button>
                )}
                {isTnefPart(part.type, part.name) && unpacked[part.blobId] === undefined && (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={t('reading.attachments.unpack', { name: label })}
                    onClick={() => void unpack(part)}
                  >
                    {t('reading.attachments.unpackShort')}
                  </Button>
                )}
                <IconButton
                  label={t('reading.attachments.download', { name: label })}
                  variant="ghost"
                  size="sm"
                  onClick={() => void saveOne(part)}
                >
                  <Download />
                </IconButton>
              </div>
              {open && preview !== null && (
                <div className={styles.attachmentPreview}>
                  {previewSurface(preview.type) === 'image' ? (
                    // A blob: URL for the just-downloaded attachment (no network fetch).
                    <img src={preview.url} alt={label} className={styles.previewImage} />
                  ) : (
                    <iframe
                      src={preview.url}
                      title={label}
                      sandbox=""
                      className={styles.previewFrame}
                    />
                  )}
                </div>
              )}
              {openMessage === part.blobId && (
                <NestedMessageView accountId={accountId} blobId={part.blobId} />
              )}
              {unpacked[part.blobId] !== undefined && (
                <div className={styles.unpacked}>
                  {(unpacked[part.blobId] ?? []).length === 0 ? (
                    // An empty container is a real outcome, not an error: the sender may have put
                    // nothing but a rich-text body in it. Saying so beats an empty box.
                    <p className={styles.unpackedNote}>{t('reading.attachments.unpackEmpty')}</p>
                  ) : (
                    <>
                      <p className={styles.unpackedNote}>{t('reading.attachments.unpackNote')}</p>
                      <ul
                        className={styles.unpackedList}
                        aria-label={t('reading.attachments.unpackedHeading', { name: label })}
                      >
                        {(unpacked[part.blobId] ?? []).map((file) => (
                          <li key={file.id} className={styles.unpackedRow}>
                            <span className={styles.unpackedName}>
                              <bdi>{displayFilename(file.name)}</bdi>
                            </span>
                            <span className={styles.attachmentSize}>
                              {formatBytes(file.bytes.byteLength)}
                            </span>
                            <IconButton
                              label={t('reading.attachments.download', {
                                name: displayFilename(file.name),
                              })}
                              variant="ghost"
                              size="sm"
                              onClick={() => saveInner(file)}
                            >
                              <Download />
                            </IconButton>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
