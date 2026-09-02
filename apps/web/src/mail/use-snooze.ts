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

import { useCallback, useEffect, useMemo, useRef } from 'react'
import { updateSnoozeMap, useLocalPrefOptional, useReplicaOptional } from '../sync'
import { dispatchOrReport } from '../sync/dispatch-failure'
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
  /*
   * Memoized on the RAW preference value (R-49).
   *
   * `useLocalPrefOptional` hands back the same reference between liveQuery emissions, and
   * `coerceSnoozeMap` turned that into a fresh object on every render. Everything downstream hung
   * off it: `snooze`, `wake`, and — through `wake` — the waker's `setInterval`, which was therefore
   * torn down and re-established on every render of the `AppShell`, in every open tab, with a
   * `dueIds` scan each time. Nothing leaked (the cleanup was correct); it was simply work in the
   * shell's render path that nothing asked for.
   */
  const raw = useLocalPrefOptional<unknown>(SNOOZE_PREF_KEY)
  const snoozed = useMemo(() => coerceSnoozeMap(raw), [raw])

  const setKeyword = useCallback(
    (ids: readonly string[], value: boolean): void => {
      if (replica === null) return
      const engine = getEngineFor(replica.accountId)
      if (engine === null) return
      // W-10's seam, which this call site was missed by: `dispatch` awaits `stateGuard`,
      // `enqueueAction` and `refreshQueueCounts`, all IndexedDB writes that can throw, and
      // `enqueueAction` applies the optimistic mutation FIRST (W-31). Unreported, a full disk made
      // the message vanish from the list with the wake time written to the preference and no outbox
      // row to carry either half to the server — and the automatic waker did the same thing in
      // reverse once a minute, silently.
      dispatchOrReport(
        engine.dispatch(
          { kind: 'setKeywords', emailIds: [...ids], keyword: SNOOZE_KEYWORD, value },
          { id: crypto.randomUUID() },
        ),
      )
    },
    [replica],
  )

  /*
   * Both writes go through the `rw` read-modify-write in `repo.ts` rather than a blind `setPref` of
   * the map as this render saw it (R-48).
   *
   * The keyword is per-message and travels the outbox, so it was never at risk; the wake times are
   * one object under one key, and two writers on the same snapshot lost one of them. That is not an
   * ordinary last-writer-wins: the waker only wakes ids it finds in the MAP, so the lost message
   * keeps `$snoozed`, `backfill.ts` filters it out of every folder window, and it is reachable only
   * through search — for good. Note the callbacks no longer close over `snoozed` at all, which is
   * also what makes them stable enough for the waker below (R-49).
   */
  const snooze = useCallback(
    (ids: readonly string[], wakeAt: Date): void => {
      if (replica === null || ids.length === 0) return
      setKeyword(ids, true)
      // Reported, not `void`ed. This is the same IndexedDB write `setKeyword` above already routes
      // through `dispatchOrReport` (W-10/R-10), one line down and with a sharper failure: the
      // keyword half succeeded, so the message is HIDDEN, and a lost wake time means the waker —
      // which only wakes ids it finds in the map — never brings it back. `backfill.ts` filters a
      // `$snoozed` message out of every folder window, so it was reachable only through search,
      // for good, with nothing on screen and only a console line to say so.
      dispatchOrReport(
        updateSnoozeMap(replica.db, replica.accountId, (current) =>
          withSnoozed(current, ids, wakeAt.getTime()),
        ),
      )
    },
    [replica, setKeyword],
  )

  const wake = useCallback(
    (ids: readonly string[]): void => {
      if (replica === null || ids.length === 0) return
      setKeyword(ids, false)
      // The mirror image, and the milder half: a lost removal leaves a stale map entry, which the
      // waker retries harmlessly. Reported all the same — a write that failed is a write the user
      // is entitled to hear about, and a silent one here is how the snooze half above went unseen.
      dispatchOrReport(
        updateSnoozeMap(replica.db, replica.accountId, (current) => withoutIds(current, ids)),
      )
    },
    [replica, setKeyword],
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
  // The interval must not be able to see a map from the render that installed it — sixty seconds is
  // a long time to hold a snapshot — but it must not be re-installed for a new one either (R-49).
  const snoozedRef = useRef(snoozed)
  useEffect(() => {
    snoozedRef.current = snoozed
  }, [snoozed])

  const wakeDue = useCallback((): void => {
    const due = dueIds(snoozedRef.current, Date.now())
    if (due.length > 0) wake(due)
  }, [wake])

  // Two effects, because they answer two different questions. This one is "has anything come due in
  // the data we just received" — it covers the ordinary case of the app being opened after a snooze
  // elapsed, and it runs when the DATA changes rather than on every render, which is what the memo
  // in `useSnooze` bought.
  useEffect(() => {
    const due = dueIds(snoozed, Date.now())
    if (due.length > 0) wake(due)
  }, [snoozed, wake])

  // …and this one is the clock for a session left open. Installed once per stable `wake`, which is
  // once per account, instead of once per render of the shell.
  useEffect(() => {
    const timer = window.setInterval(wakeDue, WAKE_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [wakeDue])
}
