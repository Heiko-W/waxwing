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
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatRelativeTime } from '../../i18n/formatters'
import { useEngineStatus } from '../../sync/engine'
import { useOnline } from '../use-online'
import styles from './shell.module.css'

/** How often the "updated …" line re-reads the clock. */
const TICK_MS = 60_000

/**
 * A minute hand for the relative timestamp: re-render once a minute, so the line stays true.
 *
 * Without it the line is written once and then lies for the rest of the session — "updated just
 * now" an hour later is worse than saying nothing, because it is the same sentence the app would
 * use if it HAD just synced. One interval per shell, only while there is something to re-read.
 *
 * It returns nothing on purpose. Holding the clock in state and reading it back is what produced
 * "Updated in 9 seconds" on a tablet in the visual sweep: the state was captured when the shell
 * mounted, the sync finished nine seconds later, and the label compared a fresh stamp against a
 * stale base — so it reported the future, for up to a minute, every time. The clock belongs to the
 * render that uses it; this hook only says WHEN to render.
 */
function useMinuteTick(active: boolean): void {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setTick((value) => value + 1), TICK_MS)
    return () => clearInterval(timer)
  }, [active])
}

type Alert = 'offline' | 'error' | 'stuck' | null

export function StatusRegion() {
  const { t } = useTranslation()
  const online = useOnline()
  const { phase, stuckActions, lastSyncedAt } = useEngineStatus()

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

  /*
   * At rest, say when the mail last arrived (HIG `feedback`: "Consider integrating status feedback
   * into your interface. … Mail in iOS and iPadOS describes the most recent update … making the
   * information unobtrusive but easy for people to check").
   *
   * The value has existed since M1.3 — `lastSyncedAt`, set on every completed pass and shared over
   * the tab bus — and was read at exactly two places, both as a TRIGGER; no surface showed it. In
   * the idle state this region rendered nothing at all, so "is this list current?" had no answer
   * anywhere in the app short of watching the spinner go by.
   *
   * Not in the live region: this is not an alert, and a screen reader repeating "updated 3 minutes
   * ago" every minute would be the noise this file already refuses to make for sync itself.
   */
  const showUpdated = alert === null && !syncing && lastSyncedAt !== null
  useMinuteTick(showUpdated)

  return (
    <div className={styles.status}>
      {showUpdated && lastSyncedAt !== null && (
        <span className={`${styles.status} ${styles.statusUpdated}`}>
          {/* The clock is read HERE, in the render that prints it, and the stamp is CLAMPED to it.
              Both halves come from one defect, seen in the visual sweep on a tablet: "Updated in 9
              seconds". The base was captured when the shell mounted, the sync finished nine seconds
              later, and `Intl.RelativeTimeFormat` reported precisely what it was given — a future.
              Reading the clock at render fixes the nine seconds; the clamp covers the millisecond
              case, where the engine's stamp is a hair ahead of this line. A just-finished sync then
              reads "now", which is the only true thing to say about it. */}
          {t('status.sync.updated', {
            when: formatRelativeTime(Math.min(lastSyncedAt, Date.now()), Date.now()),
          })}
        </span>
      )}
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
