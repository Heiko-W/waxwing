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
import { useCallback, useEffect, useMemo } from 'react'
import { canonicalCalendarQueryKey, useCalendarWindow } from '../sync'
import { useAccountEngine } from '../sync/engine'
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

/**
 * Watch one month window and render it from the replica.
 *
 * `calendarIds` carries the same three meanings the online `eventsInRange` gave it, and all three
 * are used: `null` is "the calendar list has not arrived yet" (watch nothing — a filter naming no
 * calendar asks for EVERYTHING), an EMPTY list is "every calendar is switched off" (an empty month,
 * with no query), and a non-empty list is those calendars.
 */
export function useCalendarEvents(
  fromMs: number,
  toMs: number,
  calendarIds: readonly Id[] | null,
): CalendarEventsState {
  const engine = useAccountEngine()
  /**
   * The calendar ids as ONE string, and the memo below depends on that rather than on the array.
   *
   * `visibleCalendarIds` builds a fresh array on every render of the calendar list, so an array
   * dependency would re-key the watch continuously: unwatch, re-watch, re-materialize, repeat. A
   * comma join is safe as an identity — a JMAP id is a restricted charset that cannot contain one.
   * `null` (the list has not arrived) stays distinct from `''` (nothing is switched on).
   */
  const idKey = calendarIds === null ? null : calendarIds.join(',')

  const spec = useMemo(() => {
    if (idKey === null || idKey === '') return null
    return { filter: calendarFilter(new Date(fromMs), new Date(toMs), idKey.split(',')) }
  }, [fromMs, toMs, idKey])

  const key = useMemo(
    () => (spec === null ? '' : canonicalCalendarQueryKey({ ...spec, expandRecurrences: true })),
    [spec],
  )

  useEffect(() => {
    if (engine === null || spec === null) return
    const watched = engine.watchCalendarQuery(spec)
    return () => engine.unwatchCalendarQuery(watched)
  }, [engine, spec])

  const window = useCalendarWindow(key)

  const refresh = useCallback(async () => {
    if (engine === null || spec === null) return
    await engine.refreshCalendarWindow(spec)
  }, [engine, spec])

  return useMemo(() => {
    // No calendars known yet ⇒ still loading; every calendar switched off ⇒ a real, empty answer.
    if (spec === null) {
      return idKey === null
        ? { events: undefined, syncedAt: 0, neverSynced: false, refresh: NO_REFRESH }
        : { events: [], syncedAt: 0, neverSynced: false, refresh: NO_REFRESH }
    }
    // `undefined` (query in flight) and `null` (asked for, not answered yet) are both "wait".
    if (window === undefined || window === null) {
      return { events: undefined, syncedAt: 0, neverSynced: false, refresh }
    }

    const objects = window.objects.flatMap((row) => (row === undefined ? [] : [row.event]))
    // Best-effort, exactly as online: a window whose identity half never arrived still draws. Every
    // occurrence then reads as unresolved — legible, not editable — and the screen says which.
    let index = indexObjects([])
    try {
      index = indexObjects(objects)
    } catch {
      /* an unreadable identity half costs editing, never the month */
    }

    const events = window.occurrences
      .flatMap((row) => (row === undefined ? [] : [row.event]))
      .map((event) => placeEvent(event, resolveIdentity(event, index)))
      // An event whose start could not be read is dropped rather than sorted to 1970, where it would
      // appear at the top of every view for ever.
      .filter((placed) => placed.startsAt !== null)
      .sort((a, b) => (a.startsAt as number) - (b.startsAt as number))

    return { events, syncedAt: window.syncedAt, neverSynced: window.empty, refresh }
  }, [window, spec, idKey, refresh])
}
