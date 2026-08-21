/**
 * The month grid (M5.6, FR-CAL-01) — pure date arithmetic, no React.
 *
 * A month view is six weeks of seven days starting on the locale's first weekday, which means it
 * always shows a few days of the neighbouring months. Six rows rather than "as many as needed" is
 * deliberate: a grid that changes height between May and June makes the whole page jump when the
 * user pages through the year.
 */

/** One cell of the grid. */
export interface MonthDay {
  readonly date: Date
  /** False for the leading/trailing days that belong to the neighbouring month. */
  readonly inMonth: boolean
  readonly isToday: boolean
}

/** Milliseconds in a day — safe here because every value is built with local-time constructors. */
const DAY_MS = 86_400_000

/** Midnight, local time, of the day `date` falls in. */
export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

/** Whether two instants fall on the same local day. */
export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

/**
 * The first weekday for a locale, as a 0–6 index where 0 is Sunday.
 *
 * `Intl.Locale.prototype.getWeekInfo` is the standard answer and is not everywhere yet, so an
 * unsupported browser falls back to Monday — the ISO-8601 default and the right guess for most of
 * the locales this app ships in.
 */
export function firstDayOfWeek(locale: string): number {
  try {
    const info = new Intl.Locale(locale) as unknown as {
      getWeekInfo?: () => { firstDay: number }
      weekInfo?: { firstDay: number }
    }
    const week = info.getWeekInfo?.() ?? info.weekInfo
    // `weekInfo.firstDay` is 1–7 with 7 = Sunday (CLDR); this module uses 0 = Sunday.
    if (week !== undefined) return week.firstDay % 7
  } catch {
    // Fall through.
  }
  return 1
}

/**
 * Six weeks of days covering `month`, starting on the locale's first weekday.
 *
 * `today` is injected rather than read from the clock so the grid is a pure function — the same
 * inputs always produce the same output, which is what makes it testable at all.
 */
export function monthGrid(month: Date, locale: string, today: Date): MonthDay[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1)
  const weekStart = firstDayOfWeek(locale)
  // How many days of the previous month to show before the 1st.
  const lead = (first.getDay() - weekStart + 7) % 7
  const start = new Date(first.getFullYear(), first.getMonth(), 1 - lead)

  const days: MonthDay[] = []
  for (let index = 0; index < 42; index += 1) {
    // Built from the local-time constructor rather than by adding DAY_MS: adding milliseconds
    // across a DST transition lands on 23:00 the previous day, and the grid would repeat a date.
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index)
    days.push({
      date,
      inMonth: date.getMonth() === month.getMonth() && date.getFullYear() === month.getFullYear(),
      isToday: isSameDay(date, today),
    })
  }
  return days
}

/** The `[from, to)` window a month view has to fetch — the whole grid, not just the month. */
export function monthRange(month: Date, locale: string): { from: Date; to: Date } {
  const days = monthGrid(month, locale, month)
  const first = days[0]?.date ?? month
  const last = days[days.length - 1]?.date ?? month
  return { from: startOfDay(first), to: new Date(startOfDay(last).getTime() + DAY_MS) }
}

/** `2026-08-20`, for a route param. Local, not UTC — the URL names a day, not an instant. */
export function toIsoDate(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Reads a `YYYY-MM-DD` route param; `null` when it is missing or malformed. */
export function fromIsoDate(value: string | undefined): Date | null {
  if (value === undefined) return null
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (match === null) return null
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  // `new Date(2026, 12, 40)` silently rolls over; reject rather than show a different day.
  return date.getMonth() === Number(match[2]) - 1 ? date : null
}

/**
 * Adds `delta` days.
 *
 * Built with the local-time constructor rather than by adding `DAY_MS`, for the reason this module
 * keeps repeating: across a DST transition a day is 23 or 25 hours, and millisecond arithmetic
 * lands on 23:00 the day before.
 */
export function addDays(date: Date, delta: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + delta)
}

/**
 * Every local day an interval touches, as `YYYY-MM-DD` keys.
 *
 * A month cell asks "is this event on my day?", and keying an event by its start alone answers no
 * for every day but the first — a three-day whole-day event appeared on the 12th, and the 13th and
 * 14th were empty (T4).
 *
 * **Half-open at the end**, matching `week-grid.ts`: an event ending exactly at midnight belongs to
 * the day before, not to both. An event of zero length still occupies the day it starts on, which
 * is what the `startsAt + 1` floor is for.
 *
 * `limit` is a stop, not a policy: a corrupt `duration` (JSCalendar allows `P9999Y`) would otherwise
 * spin here for millions of iterations while the browser looked hung.
 */
export function daysBetween(startsAt: number, endsAt: number, limit = 400): string[] {
  const keys: string[] = []
  if (!Number.isFinite(startsAt)) return keys
  const end = Math.max(Number.isFinite(endsAt) ? endsAt : startsAt, startsAt + 1)
  let cursor = startOfDay(new Date(startsAt))
  while (cursor.getTime() < end && keys.length < limit) {
    keys.push(toIsoDate(cursor))
    cursor = addDays(cursor, 1)
  }
  return keys
}

/** Adds `delta` months, clamping the day so 31 January + 1 month is not 3 March. */
export function addMonths(date: Date, delta: number): Date {
  const target = new Date(date.getFullYear(), date.getMonth() + delta, 1)
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate()
  return new Date(target.getFullYear(), target.getMonth(), Math.min(date.getDate(), lastDay))
}
