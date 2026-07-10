/**
 * The "remote content blocked" banner (M1.8, FR-RD-04 / NFR-PRIV-01). Shown above a message whose
 * ORIGINAL body referenced remote resources while they are currently blocked. Offers a one-off
 * "Load images" (this message only) and a durable "Always allow {sender}" (adds the sender to the
 * `reading.remoteAllow` local preference), plus a short privacy note on why images are blocked.
 */

import { ImageOff } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '../ui'
import styles from './reading.module.css'

export interface RemoteContentBannerProps {
  /** Display name of the sender, for the "Always allow {sender}" affordance. */
  readonly sender: string
  /** Load remote content for this message only. */
  readonly onLoad: () => void
  /** Trust this sender from now on (persisted). Absent when the sender address is unknown. */
  readonly onAlwaysAllow?: (() => void) | undefined
}

export function RemoteContentBanner({ sender, onLoad, onAlwaysAllow }: RemoteContentBannerProps) {
  const { t } = useTranslation()
  return (
    <section className={styles.remoteBanner} aria-label={t('reading.remote.title')}>
      <ImageOff aria-hidden="true" className={styles.remoteIcon} />
      <div className={styles.remoteText}>
        <p className={styles.remoteTitle}>{t('reading.remote.title')}</p>
        <p className={styles.remoteNote}>{t('reading.remote.privacyNote')}</p>
      </div>
      <div className={styles.remoteActions}>
        <Button size="sm" variant="secondary" onClick={onLoad}>
          {t('reading.remote.load')}
        </Button>
        {onAlwaysAllow !== undefined && (
          <Button size="sm" variant="ghost" onClick={onAlwaysAllow}>
            {t('reading.remote.alwaysAllow', { sender })}
          </Button>
        )}
      </div>
    </section>
  )
}
