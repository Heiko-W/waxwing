/**
 * The phishing-friction interstitial (M3.9, FR-RD-08): this link does not go where its text says.
 * A lazy chunk — most readers will never see it, and the ones who do are not in a hurry.
 *
 * Three deliberate choices:
 *  - **Cancel takes initial focus**, and is the plain button; "Open anyway" is `destructive`. The
 *    default action of a dialog nobody asked for must be the safe one — Enter and Escape both back
 *    out. Someone clicking through a familiar-looking flow must have to aim.
 *  - **The hosts are structural, not interpolated into a sentence.** The real host is the largest
 *    thing in the dialog, because it is the one fact that decides the question — and a sentence with
 *    two hosts in it reads as a sentence, which is precisely how phishing survives being read.
 *  - **Both hosts are rendered exactly as `link-host.ts` returns them: ASCII/punycode, monospace.**
 *    `xn--pple-43d.com` is the truth; `аpple.com` would be the forgery, re-drawn by us.
 */

import { ShieldAlert } from 'lucide-react'
import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Dialog } from '../ui'
import styles from './reading.module.css'

export interface LinkWarningDialogProps {
  readonly claimedHost: string
  readonly targetHost: string
  readonly onConfirm: () => void
  /** Also the dialog's `onClose` (Escape, the close button, the backdrop). Must be memoized. */
  readonly onCancel: () => void
}

export default function LinkWarningDialog({
  claimedHost,
  targetHost,
  onConfirm,
  onCancel,
}: LinkWarningDialogProps) {
  const { t } = useTranslation()
  const cancelRef = useRef<HTMLButtonElement>(null)

  return (
    <Dialog
      open
      onClose={onCancel}
      title={t('reading.linkWarning.title')}
      size="sm"
      // Explicit, not incidental: Dialog would otherwise focus its first focusable, which is the
      // header's close button. Cancel is the safe answer, so Cancel is what the reader lands on.
      initialFocusRef={cancelRef}
      footer={
        <>
          <Button ref={cancelRef} variant="secondary" onClick={onCancel}>
            {t('mailbox.cancel')}
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            {t('reading.linkWarning.open')}
          </Button>
        </>
      }
    >
      <p className={styles.linkWarnLead}>
        <ShieldAlert className={styles.linkWarnIcon} aria-hidden="true" />
        {t('reading.linkWarning.lead')}
      </p>
      <dl className={styles.linkHosts}>
        <dt>{t('reading.linkWarning.claimed')}</dt>
        <dd className={styles.linkHostClaimed}>{claimedHost}</dd>
        <dt>{t('reading.linkWarning.target')}</dt>
        <dd className={styles.linkHostTarget}>{targetHost}</dd>
      </dl>
      <p className={styles.linkWarnNote}>{t('reading.linkWarning.note')}</p>
    </Dialog>
  )
}
