/**
 * "The sender asked to be told you read this" (M5.22, RFC 8098).
 *
 * A button, never an automatic send. NFR-PRIV-01 says the app makes no network request the reader
 * did not ask for, and a read receipt is a request the SENDER made on the reader's behalf — opening
 * a message is not consent to tell anyone. So the banner states what was asked, names who would be
 * told, and waits.
 *
 * **It names the address, not "the sender".** `Disposition-Notification-To` is a separate header
 * and may point anywhere; a receipt addressed away from the `From` is the shape used to confirm a
 * live mailbox. When the two differ the banner says so explicitly, because that is the case where
 * a reader would most want to decline and least expect to need to.
 *
 * Declining leaves no trace and is not reported anywhere. There is deliberately no "never ask
 * again for this sender": that would be a stored list of who the reader refuses, which is a worse
 * thing to hold than the question is to see.
 */

import { MailCheck } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../ui'
import type { MdnRequest } from './mdn'
import styles from './reading.module.css'

export interface ReadReceiptBannerProps {
  readonly request: MdnRequest
  /** True once `$mdnsent` is set — on this device or any other. */
  readonly alreadySent: boolean
  /** Resolves when the receipt has gone out; rejects if the server refused. */
  onConfirm: () => Promise<void>
}

export function ReadReceiptBanner({ request, alreadySent, onConfirm }: ReadReceiptBannerProps) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [failed, setFailed] = useState(false)

  // Nothing to ask once it has been answered, and nothing to nag about once declined. The "sent"
  // state is still shown, because a reader who told someone should be able to see that they did.
  if (dismissed) return null

  if (alreadySent) {
    return (
      <section className={styles.remoteBanner} aria-label={t('reading.receipt.title')}>
        <MailCheck aria-hidden="true" className={styles.remoteIcon} />
        <div className={styles.remoteText}>
          <p className={styles.remoteTitle}>{t('reading.receipt.sent')}</p>
          <p className={styles.remoteNote}>
            {t('reading.receipt.sentNote', { address: request.notifyTo })}
          </p>
        </div>
      </section>
    )
  }

  const confirm = async (): Promise<void> => {
    setBusy(true)
    setFailed(false)
    try {
      await onConfirm()
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className={styles.remoteBanner} aria-label={t('reading.receipt.title')}>
      <MailCheck aria-hidden="true" className={styles.remoteIcon} />
      <div className={styles.remoteText}>
        <p className={styles.remoteTitle}>{t('reading.receipt.asked')}</p>
        <p className={styles.remoteNote}>
          {request.matchesFrom
            ? t('reading.receipt.note', { address: request.notifyTo })
            : // The mismatch case, said plainly. This is the one worth reading twice.
              t('reading.receipt.noteElsewhere', { address: request.notifyTo })}
        </p>
        {/* Assertive: a confirmation the reader believes they sent, but did not, is the failure
            that matters here. */}
        <p aria-live="assertive" className={styles.remoteNote}>
          {failed ? t('reading.receipt.failed') : ''}
        </p>
      </div>
      <div className={styles.remoteActions}>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void confirm()}>
          {busy ? t('reading.receipt.sending') : t('reading.receipt.confirm')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setDismissed(true)}>
          {t('reading.receipt.decline')}
        </Button>
      </div>
    </section>
  )
}
