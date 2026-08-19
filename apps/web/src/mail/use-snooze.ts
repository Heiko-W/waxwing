/**
 * Snoozing messages, and waking them again (M5.8, FR-ORG-03).
 *
 * The write goes through the same outbox seam as every other keyword change, so a snooze made
 * offline replays like anything else. The wake time is a local preference, because a keyword has
 * nowhere to put a timestamp.
 *
 * **Waking happens when this app runs, and only then.** {@link useSnoozeWaker} checks on mount and
 * once a minute after; a device with the app closed wakes nothing. That limitation is inherent to
 * a client with no server component — the alternative would be a Sieve rule, which cannot express
 * "in three hours" — and the UI says so rather than letting a user discover it.
 */

import { useCallback, useEffect } from 'react'
import { setPref, useLocalPrefOptional, useReplicaOptional } from '../sync'
import { getEngineFor } from '../sync/engine'
import {
  coerceSnoozeMap,
  dueIds,
  SNOOZE_KEYWORD,
  SNOOZE_PREF_KEY,
  type SnoozeMap,
  withoutIds,
  withSnoozed,
} from './snooze'

/** How often the waker looks. A minute is finer than any preset and costs nothing. */
const WAKE_INTERVAL_MS = 60_000

export interface SnoozeActions {
  readonly snoozed: SnoozeMap
  /** Hides `ids` until `wakeAt`. */
  snooze(ids: readonly string[], wakeAt: Date): void
  /** Brings `ids` back now. */
  wake(ids: readonly string[]): void
}

export function useSnooze(): SnoozeActions {
  const replica = useReplicaOptional()
  const snoozed = coerceSnoozeMap(useLocalPrefOptional<unknown>(SNOOZE_PREF_KEY))

  const setKeyword = useCallback(
    (ids: readonly string[], value: boolean): void => {
      if (replica === null) return
      const engine = getEngineFor(replica.accountId)
      if (engine === null) return
      engine.dispatch(
        { kind: 'setKeywords', emailIds: [...ids], keyword: SNOOZE_KEYWORD, value },
        { id: crypto.randomUUID() },
      )
    },
    [replica],
  )

  const snooze = useCallback(
    (ids: readonly string[], wakeAt: Date): void => {
      if (replica === null || ids.length === 0) return
      setKeyword(ids, true)
      void setPref(
        replica.db,
        replica.accountId,
        SNOOZE_PREF_KEY,
        withSnoozed(snoozed, ids, wakeAt.getTime()),
      )
    },
    [replica, snoozed, setKeyword],
  )

  const wake = useCallback(
    (ids: readonly string[]): void => {
      if (replica === null || ids.length === 0) return
      setKeyword(ids, false)
      void setPref(replica.db, replica.accountId, SNOOZE_PREF_KEY, withoutIds(snoozed, ids))
    },
    [replica, snoozed, setKeyword],
  )

  return { snoozed, snooze, wake }
}

/**
 * Brings due messages back.
 *
 * Mounted once, in the shell. Runs on mount — which covers the ordinary case of the app being
 * opened after a snooze elapsed — and then on an interval for a session left open.
 */
export function useSnoozeWaker(): void {
  const { snoozed, wake } = useSnooze()

  useEffect(() => {
    const check = (): void => {
      const due = dueIds(snoozed, Date.now())
      if (due.length > 0) wake(due)
    }
    check()
    const timer = window.setInterval(check, WAKE_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [snoozed, wake])
}
