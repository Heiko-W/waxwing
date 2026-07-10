/**
 * Connectivity + sync status in the chrome (M1.4 checklist item 6; M1.3 engine seam). The polite
 * live region announces the states worth hearing — going **offline** and a sync **error** — while
 * a transient **syncing** spinner is shown visually but kept OUT of the live region (announcing
 * every sync would be noise). Engine phase comes from {@link useEngineStatus} (leader or, on a
 * follower, the cross-tab bus); connectivity stays a direct `navigator.onLine` read.
 */

import { Loader2, TriangleAlert, WifiOff } from 'lucide-react'
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

export function StatusRegion() {
  const { t } = useTranslation()
  const online = useOnline()
  const { phase } = useEngineStatus()

  const alert: 'offline' | 'error' | null = !online ? 'offline' : phase === 'error' ? 'error' : null
  const syncing = online && phase === 'syncing'
  const liveClass =
    alert === 'offline'
      ? `${styles.status} ${styles.statusOffline}`
      : alert === 'error'
        ? `${styles.status} ${styles.statusError}`
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
      </span>
    </div>
  )
}
