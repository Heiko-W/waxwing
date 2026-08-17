/**
 * The attachment strip below a message (M1.8, FR-RD-05). Lists the message's non-inline parts with a
 * type icon, filename and human size, a per-file Download, an optional "Save all", and an inline
 * preview for images/PDFs. A preview is rendered in a SEPARATE sandboxed surface (an `<img>` or a
 * script-free `<iframe sandbox>`) that is OUTSIDE the mail body frame, and every blob object URL is
 * revoked on unmount. Downloads go through the authenticated JMAP blob endpoint (never a bare URL).
 *
 * The filename is the SENDER's, in both places it appears: `safe-filename.ts` strips it for the
 * `download` attribute and, separately, for the text — a `<bdi>` around the label completes the
 * second half. The icon beside it is derived from the sender-DECLARED MIME type and is therefore a
 * claim, not a fact; nothing here verifies the bytes.
 */

import type { EmailBodyPart, Id } from '@waxwing/jmap'
import { Download } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatBytes } from '../i18n/formatters'
import { Button, IconButton, Spinner } from '../ui'
import { attachmentIcon } from './attachment-icon'
import { NestedMessageView } from './NestedMessageView'
import styles from './reading.module.css'
import { displayFilename, safeDownloadName } from './safe-filename'
import { useBlobFetcher } from './use-blob'

export interface AttachmentListProps {
  readonly accountId: Id
  readonly attachments: EmailBodyPart[]
}

/** Real attachments: a downloadable blob that is not an inline (cid) body image. */
function isAttachment(part: EmailBodyPart): part is EmailBodyPart & { blobId: Id } {
  if (part.blobId === null) return false
  return !(part.cid !== null && part.disposition === 'inline')
}

function isPreviewable(type: string): boolean {
  return type.startsWith('image/') || type === 'application/pdf'
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

export function AttachmentList({ accountId, attachments }: AttachmentListProps) {
  const { t } = useTranslation()
  const fetchBlob = useBlobFetcher(accountId)
  // One object URL per blob, reused across preview toggles and downloads and revoked once on unmount
  // — so re-opening a preview neither re-downloads nor leaks a superseded blob: URL.
  const urlCacheRef = useRef(new Map<Id, string>())
  const [busy, setBusy] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ blobId: Id; type: string; url: string } | null>(null)
  // The attached message currently expanded inline (M3.9, FR-RD-07); null = none open.
  const [openMessage, setOpenMessage] = useState<Id | null>(null)

  const items = attachments.filter(isAttachment)

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
      const blob = await fetchBlob({ blobId: part.blobId, type: part.type, name: part.name })
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
        if (url === null) return
        const anchor = document.createElement('a')
        anchor.href = url
        // Never `part.name` raw: it is the sender's string and this is a filesystem name. Chromium
        // and WebKit sanitize `download` themselves (measured), but that is a mitigation this app
        // neither controls nor can assume of every engine.
        anchor.download = safeDownloadName(part.name, DOWNLOAD_FALLBACK)
        anchor.click()
      } finally {
        setBusy(null)
      }
    },
    [fetchUrl],
  )

  const togglePreview = useCallback(
    async (part: EmailBodyPart & { blobId: Id }): Promise<void> => {
      if (preview?.blobId === part.blobId) {
        setPreview(null)
        return
      }
      setBusy(part.blobId)
      try {
        const url = await fetchUrl(part)
        if (url !== null) setPreview({ blobId: part.blobId, type: part.type, url })
      } finally {
        setBusy(null)
      }
    },
    [fetchUrl, preview],
  )

  if (items.length === 0) return null

  return (
    <section className={styles.attachments} aria-label={t('reading.attachments.title')}>
      <div className={styles.attachmentsHead}>
        <h3 className={styles.attachmentsTitle}>
          {t('reading.attachments.title')} ({items.length})
        </h3>
        {items.length > 1 && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              for (const part of items) void saveOne(part)
            }}
          >
            {t('reading.attachments.saveAll')}
          </Button>
        )}
      </div>
      <ul className={styles.attachmentItems}>
        {items.map((part) => {
          const Icon = attachmentIcon(part.type)
          // Stripped, not raw: `Invoice<U+202E>gpj.exe` rendered as `Invoiceexe.jpg` is this app
          // telling the reader the file is an image. Used for the visible text AND for every
          // `aria-label` built from it, so the two cannot say different things.
          // A name made ENTIRELY of stripped characters leaves nothing, which would render a
          // nameless row and a control with no accessible name at all — that is "unnamed" too.
          const shown = part.name !== null ? displayFilename(part.name) : ''
          const label = shown === '' ? t('reading.attachments.unnamed') : shown
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
                  {preview.type.startsWith('image/') ? (
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
            </li>
          )
        })}
      </ul>
    </section>
  )
}
