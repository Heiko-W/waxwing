/**
 * The attachment strip below a message (M1.8, FR-RD-05). Lists the message's non-inline parts with a
 * type icon, filename and human size, a per-file Download, an optional "Save all", and an inline
 * preview for images/PDFs. A preview is rendered in a SEPARATE sandboxed surface (an `<img>` or a
 * script-free `<iframe sandbox>`) that is OUTSIDE the mail body frame, and every blob object URL is
 * revoked on unmount. Downloads go through the authenticated JMAP blob endpoint (never a bare URL).
 */

import type { EmailBodyPart, Id } from '@waxwing/jmap'
import { Download, FileText, ImageIcon, Paperclip } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSession } from '../app/session/context'
import { formatBytes } from '../i18n/formatters'
import { Button, IconButton, Spinner } from '../ui'
import styles from './reading.module.css'

export interface AttachmentListProps {
  readonly accountId: Id
  readonly attachments: EmailBodyPart[]
}

/** Real attachments: a downloadable blob that is not an inline (cid) body image. */
function isAttachment(part: EmailBodyPart): part is EmailBodyPart & { blobId: Id } {
  if (part.blobId === null) return false
  return !(part.cid !== null && part.disposition === 'inline')
}

function iconFor(type: string) {
  if (type.startsWith('image/')) return ImageIcon
  if (type === 'application/pdf') return FileText
  return Paperclip
}

function isPreviewable(type: string): boolean {
  return type.startsWith('image/') || type === 'application/pdf'
}

export function AttachmentList({ accountId, attachments }: AttachmentListProps) {
  const { t } = useTranslation()
  const { getClient } = useSession()
  // One object URL per blob, reused across preview toggles and downloads and revoked once on unmount
  // — so re-opening a preview neither re-downloads nor leaks a superseded blob: URL.
  const urlCacheRef = useRef(new Map<Id, string>())
  const [busy, setBusy] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ blobId: Id; type: string; url: string } | null>(null)

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
      const client = getClient()
      if (client === null) return null
      const name = part.name ?? 'attachment'
      const bytes = await client.download(accountId, part.blobId, part.type, name)
      const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: part.type }))
      urlCacheRef.current.set(part.blobId, url)
      return url
    },
    [accountId, getClient],
  )

  const saveOne = useCallback(
    async (part: EmailBodyPart & { blobId: Id }): Promise<void> => {
      setBusy(part.blobId)
      try {
        const url = await fetchUrl(part)
        if (url === null) return
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = part.name ?? 'attachment'
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
          const Icon = iconFor(part.type)
          const label = part.name ?? t('reading.attachments.unnamed')
          const open = preview?.blobId === part.blobId
          return (
            <li key={part.blobId} className={styles.attachment}>
              <div className={styles.attachmentMain}>
                <Icon aria-hidden="true" className={styles.attachmentIcon} />
                <span className={styles.attachmentName} title={label}>
                  {label}
                </span>
                <span className={styles.attachmentSize}>{formatBytes(part.size)}</span>
                {busy === part.blobId && <Spinner size="sm" label={t('ui.spinner.label')} />}
                {isPreviewable(part.type) && (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-expanded={open}
                    onClick={() => void togglePreview(part)}
                  >
                    {open ? t('reading.attachments.hidePreview') : t('reading.attachments.preview')}
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
            </li>
          )
        })}
      </ul>
    </section>
  )
}
