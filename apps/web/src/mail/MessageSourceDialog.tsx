/**
 * The raw message source (M3.9, FR-RD-06) — "View source" / "Save as .eml" from the reading pane's
 * overflow menu. A lazy chunk: nobody opens this on the way to reading their mail.
 *
 * The `<pre>` renders `text` as a React TEXT NODE. That is not a style choice: this is the one view
 * in the app that shows an attacker's bytes verbatim, and `dangerouslySetInnerHTML` here would hand
 * every phishing message a script tag. The mail body has a sandboxed frame and a sanitizer for
 * exactly this reason; the source view has React's escaping, and needs nothing else.
 */

import type { Id } from '@waxwing/jmap'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatBytes } from '../i18n/formatters'
import type { EmailRow } from '../sync'
import { Button, Dialog, Spinner } from '../ui'
import styles from './reading.module.css'
import { MAX_SOURCE_TEXT_BYTES, useMessageSource } from './use-message-source'

/** How long the Copy button acknowledges a copy before going back to its normal label. */
const COPIED_RESET_MS = 2000

export interface MessageSourceDialogProps {
  readonly open: boolean
  readonly accountId: Id
  readonly email: EmailRow
  /**
   * Save as soon as the bytes land, then close — the overflow menu's "Save as .eml" entry. The
   * dialog is still shown meanwhile, which is the point: a 20 MB message takes time, and a failure
   * gets a real error surface instead of a download that silently never happens.
   */
  readonly autoSave?: boolean
  readonly onClose: () => void
}

export default function MessageSourceDialog({
  open,
  accountId,
  email,
  autoSave = false,
  onClose,
}: MessageSourceDialogProps) {
  const { t } = useTranslation()
  const source = useMessageSource(accountId, email, open)
  const [copied, setCopied] = useState(false)
  const autoSaved = useRef(false)

  // Fire the auto-save exactly once, whatever re-renders happen around it.
  useEffect(() => {
    if (!autoSave || autoSaved.current || source.text === null) return
    autoSaved.current = true
    source.save()
    onClose()
  }, [autoSave, source, onClose])

  // "Copied" is a transient acknowledgement, not a state: without this the button keeps claiming it
  // for as long as the dialog stays open, including after the reader has changed the selection.
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), COPIED_RESET_MS)
    return () => clearTimeout(timer)
  }, [copied])

  const onCopy = (): void => {
    if (source.text === null) return
    void navigator.clipboard?.writeText(source.text).then(
      () => setCopied(true),
      () => setCopied(false),
    )
  }

  // The clipboard only ever gets what is on screen, and on a clamped message that is the head. Say
  // so ON THE BUTTON: the note above it tells the reader to save the file to see all of it, so a
  // button labelled plain "Copy" sitting next to it is a promise we are not keeping.
  const copyLabel = copied
    ? t('reading.source.copied')
    : source.truncated
      ? t('reading.source.copyHead', { size: formatBytes(MAX_SOURCE_TEXT_BYTES) })
      : t('reading.source.copy')

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('reading.source.title')}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onCopy} disabled={source.text === null}>
            {copyLabel}
          </Button>
          <Button variant="ghost" onClick={source.save} disabled={source.text === null}>
            {t('reading.source.save')}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {t('ui.dialog.close')}
          </Button>
        </>
      }
    >
      {source.loading && (
        <div className={styles.sourceStatus}>
          <Spinner label={t('ui.spinner.label')} />
        </div>
      )}
      {source.error !== null && (
        <p className={styles.sourceStatus}>{t(`reading.source.error.${source.error}`)}</p>
      )}
      {source.text !== null && (
        <>
          {source.truncated && (
            <p className={styles.sourceTruncated}>
              {t('reading.source.truncated', { size: formatBytes(source.bytes) })}
            </p>
          )}
          <pre className={styles.sourceText}>{source.text}</pre>
        </>
      )}
    </Dialog>
  )
}
