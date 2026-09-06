/**
 * The calendar's read path (K-8) — the replica, and nothing else.
 *
 * Until K-8 this screen fetched a month straight from the server on every visit and kept the answer
 * in component state, which meant a train, a lift or a flaky hotel network produced the same thing:
 * "The calendar could not be loaded", over a month the device had already drawn ten minutes earlier.
 * Mail and Contacts have not behaved that way since M1.2 — they subscribe to the replica and let the
 * engine keep it fresh — and this hook is the calendar joining them.
 *
 * What it does NOT do is expand recurrences. The rows come out of the replica already expanded,
 * because the SERVER expanded them (`expandRecurrences`) and the sync engine stored the answer.
 * Expanding a rule in local time across a DST boundary is the genuinely hard part of calendaring and
 * this client has never done it; doing it offline "just for the cached months" would be the same
 * work with less to check it against. See the note on `CalendarQueryCacheRow`.
 *
 * The identity join (`baseEventId` → the writable id, and "is this a series") is reproduced here from
 * the SAME functions the online client uses, over the stored objects the window kept beside its
 * occurrences. So an event opened offline knows whether it may be edited — which is what lets the
 * editor be greyed out with a reason rather than failing on save.
 */

import type { Id } from '@waxwing/jmap'
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import { canonicalCalendarQueryKey, useCalendarWindowsFor } from '../sync'
import { getEngineEpoch, getEngineFor, subscribeEngines } from '../sync/engine'
import {
  calendarFilter,
  indexObjects,
  type PlacedEvent,
  placeEvent,
  resolveIdentity,
} from './calendar-client'

export interface CalendarEventsState {
  /**
   * The month's events in start order, or `undefined` while the replica is still answering.
   *
   * An EMPTY array is a real answer ("this month has nothing"), which is why it is not conflated
   * with `undefined` — the difference is a spinner versus a blank grid, and the blank grid is what
   * an offline reader with an empty month is owed.
   */
  readonly events: PlacedEvent[] | undefined
  /**
   * When this window was last read from the server; `0` = never. Drives the "showing what was here
   * as of…" line, so the screen can be honest about age instead of pretending it is live.
   */
  readonly syncedAt: number
  /** `true` when the window has never been materialized — "not synced yet", not "no events". */
  readonly neverSynced: boolean
  /**
   * Re-read this window from the server now. What a local write calls, and what the "Try again"
   * button calls; never needed for freshness, which the engine owns.
   */
  refresh(): Promise<void>
}

const NO_REFRESH = async (): Promise<void> => {}

/** One account's contribution to the merged month (#79). */
export interface CalendarSource {
  readonly accountId: Id
  /**
   * The calendars to draw from this account. Same three meanings as before, now per account:
   * `null` — the list has not arrived (watch nothing; a filter naming no calendar asks for
   * EVERYTHING), `[]` — every calendar of this account is switched off, non-empty — those.
   */
  readonly calendarIds: readonly Id[] | null
}

/**
 * Watch one month across SEVERAL accounts and render it from the replica (#79).
 *
 * Was single-account until #79 and is now the merged read: a team member wants their own
 * appointments and the group's in one week view, not a switch between two screens that each hide
 * half the answer. One source per account, each with its own calendars, its own window key, its own
 * engine — merged here, in start order.
 *
 * The parts that had to become per-account, each for a reason that would otherwise be a silent bug:
 *  - **the window key**, because it hashes the filter and the filter names calendars, which are
 *    per-account ids (ADR-018). One key across accounts reads the wrong rows.
 *  - **the engine**, because a watch registered on the wrong engine syncs the wrong account —
 *    `getEngineFor(accountId)` answers `null` rather than the primary for exactly that reason.
 *  - **`placeEvent`'s account stamp**, because two accounts routinely meet on `c1`, and a chip has
 *    to know which client opens it.
 *
 * The single-account case is this with one source, and it behaves exactly as it did.
 */
export function useCalendarEvents(
  sources: readonly CalendarSource[],
  fromMs: number,
  toMs: number,
): CalendarEventsState {
  /*
   * Serialised for every dependency below. The caller rebuilds `sources` on each render (it comes
   * out of a `.map` over the visible calendars), so an array dependency would unwatch and re-watch
   * continuously — the same reason the single-account version joined its ids, one level up.
   */
  const sourceKey = sources
    .map((source) => `${source.accountId}\u0000${source.calendarIds?.join(',') ?? '\u0002'}`)
    .join('\u0001')

  /** `{accountId, spec, key}` per account that has something to ask for; `null` ids ⇒ skipped. */
  const specs = useMemo(() => {
    if (sourceKey === '') return []
    return sourceKey
      .split('\u0001')
      .map((entry) => {
        const [accountId, ids] = entry.split('\u0000')
        if (accountId === undefined || ids === undefined) return null
        // `\u0002` is "not arrived yet", `''` is "all switched off" — neither is a query.
        if (ids === '\u0002' || ids === '') return null
        const spec = { filter: calendarFilter(new Date(fromMs), new Date(toMs), ids.split(',')) }
        return {
          accountId,
          spec,
          key: canonicalCalendarQueryKey({ ...spec, expandRecurrences: true }),
        }
      })
      .flatMap((entry) => (entry === null ? [] : [entry]))
  }, [sourceKey, fromMs, toMs])

  /**
   * Every account's list has arrived (or there are no accounts). Until then the screen is loading —
   * conflating that with "no events" is what flashes an empty month over a populated one.
   */
  const allListsArrived = useMemo(
    () =>
      sourceKey === '' ||
      sourceKey.split('\u0001').every((entry) => !entry.endsWith('\u0000\u0002')),
    [sourceKey],
  )

  // The engines, re-read when the fleet changes (an account gained or lost mid-session).
  const engineEpoch = useSyncExternalStore(subscribeEngines, getEngineEpoch, () => 0)

  /* `engineEpoch` is the intended re-watch TRIGGER rather than a value the effect reads:
     `getEngineFor` reaches into a module registry, so an account that gained an engine
     mid-session (a share accepted, a second tab signing in) would otherwise never have its
     window watched at all. */
  // biome-ignore lint/correctness/useExhaustiveDependencies: `engineEpoch` is the re-watch trigger for `getEngineFor`, which reads a module registry the linter cannot see.
  useEffect(() => {
    const watched = specs.flatMap((entry) => {
      const engine = getEngineFor(entry.accountId)
      return engine === null ? [] : [{ engine, id: engine.watchCalendarQuery(entry.spec) }]
    })
    return () => {
      for (const entry of watched) entry.engine.unwatchCalendarQuery(entry.id)
    }
  }, [specs, engineEpoch])

  const windows = useCalendarWindowsFor(specs)

  const refresh = useCallback(async () => {
    await Promise.all(
      specs.map(async (entry) => {
        const engine = getEngineFor(entry.accountId)
        if (engine === null) return
        await engine.refreshCalendarWindow(entry.spec)
      }),
    )
  }, [specs])

  return useMemo(() => {
    // Nothing to ask for. "No calendars known yet" is a spinner; "every calendar off" is an answer.
    if (specs.length === 0) {
      return allListsArrived
        ? { events: [], syncedAt: 0, neverSynced: false, refresh: NO_REFRESH }
        : { events: undefined, syncedAt: 0, neverSynced: false, refresh: NO_REFRESH }
    }
    if (windows === undefined) {
      return { events: undefined, syncedAt: 0, neverSynced: false, refresh }
    }
    // One account still unanswered keeps the whole grid waiting: half a month drawn as if it were
    // the whole month is worse than a spinner — it reads as "you are free" when you are not.
    if (specs.some((entry) => (windows.get(entry.accountId) ?? null) === null)) {
      return { events: undefined, syncedAt: 0, neverSynced: false, refresh }
    }

    const events: PlacedEvent[] = []
    let syncedAt = 0
    let neverSynced = false
    for (const entry of specs) {
      const window = windows.get(entry.accountId)
      if (window === undefined || window === null) continue
      const objects = window.objects.flatMap((row) => (row === undefined ? [] : [row.event]))
      // Best-effort, exactly as online: a window whose identity half never arrived still draws.
      let index = indexObjects([])
      try {
        index = indexObjects(objects)
      } catch {
        /* an unreadable identity half costs editing, never the month */
      }
      for (const row of window.occurrences) {
        if (row === undefined) continue
        const placed = placeEvent(row.event, entry.accountId, resolveIdentity(row.event, index))
        // An event whose start could not be read is dropped rather than sorted to 1970, where it
        // would appear at the top of every view for ever.
        if (placed.startsAt !== null) events.push(placed)
      }
      // The OLDEST answer is the honest one for a merged grid: "as of" must not claim the freshness
      // of the newest account while another has not been read for an hour.
      syncedAt = syncedAt === 0 ? window.syncedAt : Math.min(syncedAt, window.syncedAt)
      if (window.empty) neverSynced = true
    }
    events.sort((a, b) => (a.startsAt as number) - (b.startsAt as number))
    return { events, syncedAt, neverSynced, refresh }
  }, [specs, windows, allListsArrived, refresh])
}
