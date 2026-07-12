/**
 * Connectivity + sync status in the chrome (M1.4 checklist item 6; M1.3 engine seam). The polite
 * live region announces the states worth hearing — going **offline**, a sync **error**, and (M3.3)
 * an outbox that is **still retrying** against an unreachable server — while a transient **syncing**
 * spinner is shown visually but kept OUT of the live region (announcing every sync would be noise).
 * Engine phase comes from {@link useEngineStatus} (leader or, on a follower, the cross-tab bus);
 * connectivity stays a direct `navigator.onLine` read.
 *
 * "Stuck" is deliberately informational and actionless: those actions are NOT lost — they are still
 * queued and still being retried (FR-OFF-03). Only a dead letter asks the user to decide, and that
 * is the {@link OutboxProblemsButton}'s job.
 */

import { CloudOff, Loader2, TriangleAlert, WifiOff } from 'lucide-react'
import { useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { useEngineStatus } from '../../sync/engine'
import styles from './shell.module.css'

function subscribeOnline(onChange: () => void): () => void {
  window.addEventListener('online', onChange)
  window.addEventListener('offline', onChange)
  return () => {
    window.removeEventListener('online', onChange)
    window.removeEventListener('offline', onChange)
  }
}

function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  )
}

type Alert = 'offline' | 'error' | 'stuck' | null

export function StatusRegion() {
  const { t } = useTranslation()
  const online = useOnline()
  const { phase, stuckActions } = useEngineStatus()

  // Precedence: offline > error > stuck. Being offline already explains a stalled queue, and a sync
  // error is the more actionable of the two, so only announce "still trying" when neither applies.
  const alert: Alert = !online
    ? 'offline'
    : phase === 'error'
      ? 'error'
      : stuckActions > 0
        ? 'stuck'
        : null
  const syncing = online && phase === 'syncing'
  const liveClass =
    alert === 'offline'
      ? `${styles.status} ${styles.statusOffline}`
      : alert === 'error'
        ? `${styles.status} ${styles.statusError}`
        : alert === 'stuck'
          ? `${styles.status} ${styles.statusOffline}`
          : styles.status

  return (
    <div className={styles.status}>
      {syncing && (
        <span className={styles.status}>
          <Loader2 aria-hidden="true" className={`${styles.statusIcon} ${styles.statusSpin}`} />
          <span>{t('status.sync.syncing')}</span>
        </span>
      )}
      <span className={liveClass} role="status" aria-live="polite">
        {alert === 'offline' && (
          <>
            <WifiOff aria-hidden="true" className={styles.statusIcon} />
            <span>{t('status.offline')}</span>
          </>
        )}
        {alert === 'error' && (
          <>
            <TriangleAlert aria-hidden="true" className={styles.statusIcon} />
            <span>{t('status.sync.error')}</span>
          </>
        )}
        {alert === 'stuck' && (
          <>
            <CloudOff aria-hidden="true" className={styles.statusIcon} />
            <span>{t('status.outbox.stuck', { count: stuckActions })}</span>
          </>
        )}
      </span>
    </div>
  )
}
