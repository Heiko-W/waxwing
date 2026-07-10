/**
 * Connectivity + sync status in the chrome (M1.4 checklist item 6). A polite live region so a
 * screen reader announces going offline/online. The sync-engine status (syncing/idle/error) is
 * an M1.3 concern; this region is the seam it fills — for now it surfaces `navigator.onLine`.
 */

import { WifiOff } from 'lucide-react'
import { useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
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
  return (
    <div
      className={online ? styles.status : `${styles.status} ${styles.statusOffline}`}
      role="status"
      aria-live="polite"
    >
      {!online && (
        <>
          <WifiOff aria-hidden="true" className={styles.statusIcon} />
          <span>{t('status.offline')}</span>
        </>
      )}
    </div>
  )
}
