/**
 * The send options sheet (M-7, M-11): priority, delivery receipt, TLS-only delivery.
 *
 * **Behind a control, not on the surface.** Every one of these is wanted on a small minority of
 * messages, and the composer's ground floor is already the busiest 400 px in the app. Apple Mail
 * makes the same call — priority and read-receipt live in a menu on the header row, not as fields —
 * and the rule it implies is the one followed here: an advanced control has to be FINDABLE, which
 * a labelled button beside Send is, without being something everyone else has to look past.
 *
 * The trigger carries a dot when anything is set (see `composer.module.css` `.optionsSet`), so the
 * one thing a hidden control must never do — change the message silently — it does not do.
 *
 * **Only what this account can do is shown.** The two switches are gated on the advertised
 * submission extensions. A switch for something the server will reject is worse than no switch: it
 * turns an unavailable feature into a failed send.
 *
 * Lazy (`ComposerWindow` imports it through `lazy()`) for the same reason as the send-later picker:
 * most messages are sent with none of this.
 */

import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Dialog, Select, Switch } from '../ui'
import styles from './composer.module.css'
import type { MessagePriority, SendOptions, SubmissionExtensions } from './send-options'

export interface SendOptionsDialogProps {
  readonly value: SendOptions
  readonly extensions: SubmissionExtensions
  onChange: (options: SendOptions) => void
  onClose: () => void
}

/** Spelled out, not computed: the i18n guard only sees literal keys. */
function priorityLabel(t: (key: string) => string, priority: MessagePriority): string {
  switch (priority) {
    case 'high':
      return t('compose.options.priority.high')
    case 'low':
      return t('compose.options.priority.low')
    case 'normal':
      return t('compose.options.priority.normal')
  }
}

const PRIORITIES: readonly MessagePriority[] = ['high', 'normal', 'low']

export default function SendOptionsDialog({
  value,
  extensions,
  onChange,
  onClose,
}: SendOptionsDialogProps) {
  const { t } = useTranslation()
  const priorityId = useId()
  const receiptHintId = useId()
  const tlsHintId = useId()

  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={t('compose.options.title')}
      footer={
        <Button variant="primary" onClick={onClose}>
          {t('compose.options.done')}
        </Button>
      }
    >
      <div className={styles.optionsBody}>
        <div className={styles.optionRow}>
          <label className={styles.optionLabel} htmlFor={priorityId}>
            {t('compose.options.priority.label')}
          </label>
          <Select
            id={priorityId}
            value={value.priority}
            onChange={(event) =>
              onChange({ ...value, priority: event.target.value as MessagePriority })
            }
          >
            {PRIORITIES.map((priority) => (
              <option key={priority} value={priority}>
                {priorityLabel(t, priority)}
              </option>
            ))}
          </Select>
        </div>

        {extensions.dsn && (
          <div className={styles.optionSwitch}>
            <Switch
              block
              checked={value.deliveryReceipt}
              aria-describedby={receiptHintId}
              onCheckedChange={(checked) => onChange({ ...value, deliveryReceipt: checked })}
              label={t('compose.options.receipt.label')}
            />
            {/* Says where the answer ARRIVES, because that is the part nobody guesses: the report
                comes back as an ordinary message from the mail system, not as a badge on the sent
                copy (measured — `EmailSubmission.dsnBlobIds` stays empty on this server). */}
            <p id={receiptHintId} className={styles.optionHint}>
              {t('compose.options.receipt.hint')}
            </p>
          </div>
        )}

        {extensions.requireTls && (
          <div className={styles.optionSwitch}>
            <Switch
              block
              checked={value.requireTls}
              aria-describedby={tlsHintId}
              onCheckedChange={(checked) => onChange({ ...value, requireTls: checked })}
              label={t('compose.options.tls.label')}
            />
            {/* The consequence is stated, not implied. REQUIRETLS means the message is RETURNED
                rather than delivered over an unencrypted hop, and a privacy switch that quietly
                turns into a bounce is a worse outcome than not offering it. */}
            <p id={tlsHintId} className={styles.optionHint}>
              {t('compose.options.tls.hint')}
            </p>
          </div>
        )}
      </div>
    </Dialog>
  )
}
