/**
 * Free/busy geometry (S-6, RFC 9670 §5) — pure, no React, no JMAP.
 *
 * `Principal/getAvailability` answers with absolute UTC intervals and nothing else: **times, never
 * titles**. That is what makes it worth a surface at all — it needs no share, no delegated account
 * and no trust, so "when is Bob free" is answerable about anyone in the directory. This module turns
 * that answer into what a week column can draw, and it is separate from the view for the same reason
 * `week-grid.ts` is: the arithmetic is where the mistakes live, and it can be tested without a DOM.
 *
 * ## Two decisions that are not obvious
 *
 * **Overlapping periods are MERGED.** The server may answer with several periods covering the same
 * hour (two calendars, a series and its override). Drawn as separate translucent bands they would
 * stack, and the same hour would come out darker than a neighbouring one — which reads as "busier",
 * a distinction the data does not contain. One band per contiguous busy stretch is the honest shape.
 *
 * **`busyStatus` is carried but not drawn.** A merged band keeps the STRONGEST status it swallowed
 * ({@link STRENGTH}), so nothing is lost; the week view renders one hatch for all of them. The
 * question a background layer answers is "may I put a meeting here", and `tentative` answers it the
 * same way `confirmed` does. Two hatch densities plus a legend would be more chrome than the layer
 * is worth — and would need a non-colour distinction of its own (WCAG 1.4.1) to be legible at all.
 */

import type { AvailabilityPeriod, BusyStatus } from '@waxwing/jmap'
import { addDays, startOfDay } from './month-grid'
import { minuteOfDay } from './week-grid'

/** One busy stretch, as absolute instants. */
export interface BusyPeriod {
  readonly startsAt: number
  readonly endsAt: number
  readonly status: BusyStatus
}

/** One busy stretch, clamped onto a single day column. Minutes from local midnight. */
export interface BusyBand {
  readonly startMinute: number
  readonly endMinute: number
  readonly status: BusyStatus
}

/**
 * How much a status "wins" when two merge.
 *
 * `unavailable` is out-of-office and is the least interruptible; `tentative` is the most. A merged
 * band takes the highest, so merging can only ever overstate how unavailable someone is — the
 * direction in which a scheduling hint is allowed to be wrong.
 */
const STRENGTH: Readonly<Record<BusyStatus, number>> = {
  tentative: 0,
  confirmed: 1,
  unavailable: 2,
}

function stronger(left: BusyStatus, right: BusyStatus): BusyStatus {
  return (STRENGTH[right] ?? 0) > (STRENGTH[left] ?? 0) ? right : left
}

/**
 * Parses the server's periods into instants, dropping what cannot be drawn, and merges overlaps.
 *
 * Defensive at every step, because this is data from another account and there is no schema check
 * between here and the wire: an unparseable timestamp, an end before its start, and a zero-length
 * period are each dropped rather than clamped. A band of zero height is invisible and a band with a
 * negative one is a rendering bug that looks like a server bug.
 *
 * An unknown `busyStatus` is kept as-is and treated as the weakest — this is a hint layer, and a
 * status word nobody has seen before is not a reason to hide the fact that the time is taken.
 */
export function toBusyPeriods(list: readonly AvailabilityPeriod[]): readonly BusyPeriod[] {
  const parsed: BusyPeriod[] = []
  for (const period of list) {
    const startsAt = Date.parse(period.utcStart)
    const endsAt = Date.parse(period.utcEnd)
    if (Number.isNaN(startsAt) || Number.isNaN(endsAt) || endsAt <= startsAt) continue
    parsed.push({ startsAt, endsAt, status: period.busyStatus })
  }
  parsed.sort((left, right) => left.startsAt - right.startsAt || left.endsAt - right.endsAt)

  const merged: BusyPeriod[] = []
  for (const period of parsed) {
    const last = merged[merged.length - 1]
    // Touching counts as overlapping: 10–11 and 11–12 are one busy stretch, not two, and drawing
    // the seam would suggest a minute of freedom that does not exist.
    if (last !== undefined && period.startsAt <= last.endsAt) {
      merged[merged.length - 1] = {
        startsAt: last.startsAt,
        endsAt: Math.max(last.endsAt, period.endsAt),
        status: stronger(last.status, period.status),
      }
      continue
    }
    merged.push(period)
  }
  return merged
}

/**
 * The bands to draw in one day's column, in minutes from LOCAL midnight.
 *
 * Local, because a column is a local day — the same rule `week-grid.ts` follows. A period that
 * spans midnight yields a band in each day it touches, each clamped to its own column, which is
 * what makes an overnight trip look like two full columns rather than one impossible one.
 */
export function busyBandsForDay(periods: readonly BusyPeriod[], day: Date): readonly BusyBand[] {
  const start = startOfDay(day)
  const from = start.getTime()
  // `addDays`, not `+ 24 h`, and the minutes come from {@link minuteOfDay} rather than from a
  // difference: on a DST day the column is 23 or 25 hours long, so measuring minutes as a distance
  // from midnight put every band after the transition an hour off — the same defect the week grid
  // had beside it, drawn behind the events it was supposed to line up with (R-17).
  const to = addDays(start, 1).getTime()
  const bands: BusyBand[] = []
  for (const period of periods) {
    // Half-open, like `overlapsDay`: a period ending exactly at midnight belongs to the day before.
    if (period.startsAt >= to || period.endsAt <= from) continue
    const startMinute = minuteOfDay(period.startsAt, day)
    const endMinute = minuteOfDay(period.endsAt, day)
    if (endMinute <= startMinute) continue
    bands.push({ startMinute, endMinute, status: period.status })
  }
  return bands
}
