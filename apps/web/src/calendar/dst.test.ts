/**
 * The two days a year the calendar's own arithmetic has to be right about (R-16, R-17, R-62).
 *
 * `month-grid.ts` says three times over that a local day is not `DAY_MS`, because on the morning a
 * zone springs forward it is 23 hours and on the morning it falls back it is 25. Three places broke
 * that rule anyway, and each produced a different wrong picture: a whole-day event that also
 * appeared the next day, a 10:00 meeting drawn on the 09:00 line, and a query window that stopped
 * an hour early.
 *
 * **Both zones, pinned in the file.** A DST test that runs in whatever zone the developer's machine
 * is set to proves nothing — it passes in Berlin and is never executed in CI. `process.env.TZ` is
 * re-read by V8 on every `Date` operation, so each block states the zone it is about and the
 * transition dates of that zone: Berlin turns on the last Sunday of March and October, the United
 * States on the second Sunday of March and the first of November, and the two are deliberately
 * different dates so a fix that hard-codes one is caught by the other.
 */

import type { CalendarEvent } from '@waxwing/jmap'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { busyBandsForDay } from './availability'
import { placeEvent } from './calendar-client'
import { defaultUntil } from './EventDialog'
import { daysBetween, monthRange, toIsoDate } from './month-grid'
import { layoutDay, overlapsDay } from './week-grid'

/** Any account: `placeEvent` only carries it through (#79), and nothing here reads it back. */
const ACCOUNT = 'a1'

const AMBIENT = process.env.TZ

afterAll(() => {
  if (AMBIENT === undefined) delete process.env.TZ
  else process.env.TZ = AMBIENT
})

/** Runs `body` with the process clock in `zone` — see the note at the top for why this works. */
function inZone(zone: string, body: () => void): () => void {
  return () => {
    process.env.TZ = zone
    body()
  }
}

const allDay = (start: string, duration?: string): CalendarEvent =>
  ({
    id: 'e1',
    '@type': 'Event',
    title: 'Holiday',
    start,
    showWithoutTime: true,
    ...(duration === undefined ? {} : { duration }),
  }) as CalendarEvent

const timed = (start: string, timeZone: string): CalendarEvent =>
  ({
    id: 'e2',
    '@type': 'Event',
    title: 'Standup',
    start,
    duration: 'PT60M',
    timeZone,
  }) as CalendarEvent

/** One zone's two transition days, and a meeting at 10:00 local on each. */
interface Zone {
  readonly name: string
  /** The day the clocks go forward — the 23-hour day. */
  readonly spring: string
  /** The day they go back — the 25-hour day. */
  readonly autumn: string
}

const ZONES: readonly Zone[] = [
  { name: 'Europe/Berlin', spring: '2026-03-29', autumn: '2026-10-25' },
  { name: 'America/New_York', spring: '2026-03-08', autumn: '2026-11-01' },
]

for (const zone of ZONES) {
  describe(`DST arithmetic in ${zone.name}`, () => {
    const day = (iso: string): Date => {
      const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
      return new Date(y, m - 1, d)
    }

    it(
      'places a one-day whole-day event on the spring day and NOT on the day after (R-16)',
      inZone(zone.name, () => {
        const placed = placeEvent(allDay(`${zone.spring}T00:00:00`, 'P1D'), ACCOUNT)
        expect(daysBetween(placed.startsAt as number, placed.endsAt as number)).toEqual([
          zone.spring,
        ])
        const start = day(zone.spring)
        const dayAfter = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1)
        expect(overlapsDay(placed.startsAt as number, placed.endsAt as number, dayAfter)).toBe(
          false,
        )
      }),
    )

    it(
      'gives a whole-day event with no duration exactly its own day (R-16)',
      inZone(zone.name, () => {
        const placed = placeEvent(allDay(`${zone.spring}T00:00:00`), ACCOUNT)
        expect(daysBetween(placed.startsAt as number, placed.endsAt as number)).toEqual([
          zone.spring,
        ])
      }),
    )

    it(
      'gives a three-day whole-day event across the spring transition three days (R-16)',
      inZone(zone.name, () => {
        const placed = placeEvent(allDay(`${zone.spring}T00:00:00`, 'P3D'), ACCOUNT)
        const keys = daysBetween(placed.startsAt as number, placed.endsAt as number)
        expect(keys).toHaveLength(3)
        expect(keys[0]).toBe(zone.spring)
      }),
    )

    it(
      'draws a 10:00 meeting on the 10:00 line on both transition days (R-17)',
      inZone(zone.name, () => {
        for (const iso of [zone.spring, zone.autumn]) {
          const placed = placeEvent(timed(`${iso}T10:00:00`, zone.name), ACCOUNT)
          const slots = layoutDay(
            [
              {
                item: 'e',
                startsAt: placed.startsAt as number,
                endsAt: placed.endsAt as number,
              },
            ],
            day(iso),
          )
          expect(slots[0]?.startMinute, iso).toBe(600)
          expect(slots[0]?.endMinute, iso).toBe(660)
        }
      }),
    )

    it(
      'draws the free/busy band on the same line as the event (R-17)',
      inZone(zone.name, () => {
        for (const iso of [zone.spring, zone.autumn]) {
          const placed = placeEvent(timed(`${iso}T10:00:00`, zone.name), ACCOUNT)
          const bands = busyBandsForDay(
            [
              {
                startsAt: placed.startsAt as number,
                endsAt: placed.endsAt as number,
                status: 'confirmed',
              },
            ],
            day(iso),
          )
          expect(bands[0]?.startMinute, iso).toBe(600)
          expect(bands[0]?.endMinute, iso).toBe(660)
        }
      }),
    )

    it(
      'offers a repeat end date on the local day, not the UTC one (R-62)',
      inZone(zone.name, () => {
        // Late enough in the evening that the UTC day has already turned in Berlin and the local
        // day has NOT: `toISOString().slice(0, 10)` named tomorrow there and yesterday in New York.
        vi.useFakeTimers()
        try {
          vi.setSystemTime(new Date(2026, 6, 12, 23, 30, 0))
          expect(defaultUntil()).toBe('2027-07-12T23:59:59')
        } finally {
          vi.useRealTimers()
        }
      }),
    )

    it(
      'ends every month window at local midnight, transition or not (R-62)',
      inZone(zone.name, () => {
        for (let year = 2026; year <= 2039; year += 1) {
          for (let month = 0; month < 12; month += 1) {
            // `de-DE` starts the week on Monday, which is what puts a grid's LAST cell on a Sunday
            // — and every DST transition in both zones falls on a Sunday.
            const range = monthRange(new Date(year, month, 1), 'de-DE')
            const label = `${zone.name} ${toIsoDate(range.to)}`
            expect(range.to.getHours(), label).toBe(0)
            expect(range.from.getHours(), label).toBe(0)
          }
        }
      }),
    )
  })
}
