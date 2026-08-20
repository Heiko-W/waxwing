/**
 * Durable "queued to send" chips (M3.3, FR-OFF-03 / FR-CMP-08). A send dispatched offline — or one
 * backed off after a transient failure — is a real, persisted message that has NOT left the device.
 * The M2.8 "Sending…" toast auto-dismisses after the undo grace, so without this surface the user
 * had no way to see (let alone cancel) a message parked in the queue for hours.
 *
 * Each chip states plainly what will happen ("Will send when you’re back online") and keeps Cancel
 * available for exactly as long as it is safe: cancellation is allowed while the row is `pending`
 * (the submission provably has not been dispatched), whatever its age.
 */

import { useTranslation } from 'react-i18next'
import { useDraftSync } from '../compose'
import { queuedSends, useReplicaQuery } from '../sync'
import type { OutboxIntent } from '../sync/engine'
import { useEngineStatus } from '../sync/engine'
import { Button, Portal } from '../ui'
import styles from './outbox.module.css'

type SendIntent = Extract<OutboxIntent, { kind: 'sendEmail' }>

export function QueuedSends() {
  const { t } = useTranslation()
  const { online } = useEngineStatus()
  const draftSync = useDraftSync()
  const rows = useReplicaQuery(({ db, accountId }) => queuedSends(db, accountId))

  if (rows === undefined || rows.length === 0) return null
  const now = Date.now()

  return (
    <Portal>
      <div
        className={styles.queue}
        role="status"
        aria-live="polite"
        aria-label={t('outbox.send.label')}
      >
        {rows.map((row) => {
          const intent = row.payload as SendIntent
          const subject = intent.email.subject?.trim()
          const status = !online
            ? t('outbox.send.willSendWhenOnline')
            : (row.notBefore ?? 0) > now
              ? t('compose.sendUndoToast')
              : (row.nextAttemptAt ?? 0) > now
                ? t('outbox.send.retrying')
                : t('compose.sending')
          return (
            <div key={row.id} className={styles.queued}>
              <div className={styles.queuedText}>
                <p className={styles.queuedSubject}>{subject || t('compose.noSubject')}</p>
                <p className={styles.queuedStatus}>{status}</p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void draftSync.undoSend(intent.localId)}
              >
                {t('outbox.send.cancel')}
              </Button>
            </div>
          )
        })}
      </div>
    </Portal>
  )
}
