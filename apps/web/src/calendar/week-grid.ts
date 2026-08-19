/**
 * The week and day views (M5.13, FR-CAL-01) — pure geometry, no React.
 *
 * A week grid is a time axis with events positioned on it, and the part that is actually hard is
 * **overlap**: two meetings at the same hour have to share the column rather than cover each other.
 * That is what this module computes, and it is separated out precisely so it can be tested without
 * rendering anything.
 *
 * Everything is minutes-from-midnight in LOCAL time, because that is what a column represents.
 */

import { isSameDay, startOfDay } from './month-grid'

/** An event placed on a day column. */
export interface DaySlot<T> {
  readonly item: T
  /** Minutes from local midnight. Clamped to the day, so an event starting yesterday begins at 0. */
  readonly startMinute: number
  /** Clamped likewise; always greater than `startMinute`. */
  readonly endMinute: number
  /** Which of `columns` this slot occupies (0-based). */
  readonly column: number
  /** How many columns the overlapping group needs. */
  readonly columns: number
}

const MINUTES_PER_DAY = 1440
/** The shortest an event may render as, so a five-minute meeting stays clickable. */
const MIN_SLOT_MINUTES = 15

/** Minutes from local midnight of `day`, clamped into `[0, 1440]`. */
function minuteOfDay(instant: number, day: Date): number {
  const midnight = startOfDay(day).getTime()
  const minutes = Math.round((instant - midnight) / 60_000)
  return Math.min(MINUTES_PER_DAY, Math.max(0, minutes))
}

/** Whether an event touches `day` at all. */
export function overlapsDay(startsAt: number, endsAt: number, day: Date): boolean {
  const from = startOfDay(day).getTime()
  const to = from + MINUTES_PER_DAY * 60_000
  // Half-open: an event ending exactly at midnight belongs to the day before, not to both.
  return startsAt < to && endsAt > from
}

/**
 * Lays out one day's events into columns.
 *
 * The algorithm is the standard sweep: events are taken in start order, and each joins the current
 * cluster if it overlaps anything still open in it. A cluster's width is the largest number of
 * events open at once, so two meetings sharing an hour each get half the width — and a third one
 * later, overlapping neither, starts a fresh cluster at full width rather than being squeezed to a
 * third for the whole day.
 */
export function layoutDay<T>(
  events: readonly { item: T; startsAt: number; endsAt: number }[],
  day: Date,
): DaySlot<T>[] {
  const onDay = events
    .filter((event) => overlapsDay(event.startsAt, event.endsAt, day))
    .map((event) => ({
      item: event.item,
      startMinute: minuteOfDay(event.startsAt, day),
      endMinute: Math.max(
        minuteOfDay(event.startsAt, day) + MIN_SLOT_MINUTES,
        minuteOfDay(event.endsAt, day),
      ),
    }))
    .sort((a, b) => a.startMinute - b.startMinute || a.endMinute - b.endMinute)

  const slots: DaySlot<T>[] = []
  /** The cluster being built: indices into `slots`, plus the per-column end times. */
  let cluster: number[] = []
  let columnEnds: number[] = []

  const closeCluster = (): void => {
    const width = columnEnds.length
    for (const index of cluster) {
      const slot = slots[index]
      if (slot !== undefined) slots[index] = { ...slot, columns: width }
    }
    cluster = []
    columnEnds = []
  }

  for (const event of onDay) {
    // A cluster ends when nothing in it is still open at this event's start.
    if (cluster.length > 0 && columnEnds.every((end) => end <= event.startMinute)) closeCluster()

    // The first column that is free; otherwise a new one.
    let column = columnEnds.findIndex((end) => end <= event.startMinute)
    if (column === -1) {
      column = columnEnds.length
      columnEnds.push(event.endMinute)
    } else {
      columnEnds[column] = event.endMinute
    }

    slots.push({ ...event, column, columns: columnEnds.length })
    cluster.push(slots.length - 1)
  }
  closeCluster()

  return slots
}

/** The seven days of the week containing `date`, starting on the locale's first weekday. */
export function weekDays(date: Date, firstDay: number): Date[] {
  const lead = (date.getDay() - firstDay + 7) % 7
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate() - lead)
  return Array.from(
    { length: 7 },
    // Local-time construction, not millisecond addition: adding 86 400 000 ms across a DST
    // transition lands on 23:00 the previous day and the week repeats a date.
    (_, index) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + index),
  )
}

/** The `[from, to)` a week view has to fetch. */
export function weekRange(date: Date, firstDay: number): { from: Date; to: Date } {
  const days = weekDays(date, firstDay)
  const first = days[0] ?? date
  const last = days[days.length - 1] ?? date
  return {
    from: startOfDay(first),
    to: new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1),
  }
}

/** Whether `day` is the one containing `instant` — re-exported so views need one import. */
export { isSameDay }
