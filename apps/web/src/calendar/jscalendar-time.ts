/**
 * Converting between JSCalendar's local date-times and absolute instants (M5.6).
 *
 * JSCalendar stores `2026-08-20T10:00:00` plus a separate `timeZone`. To place that on a timeline
 * — to sort it, or to say "in 20 minutes" — it has to become an instant, and that conversion is
 * where calendar clients go wrong.
 *
 * **Why not `new Date(local)`.** That parses the string in the *browser's* zone, which is right
 * exactly when the event's zone happens to match the reader's. Everyone testing in their own zone
 * sees correct times; the bug appears for the colleague in another country, and twice a year at
 * home.
 *
 * **How this does it without a library.** `Intl.DateTimeFormat` can render an instant *in* a named
 * zone, so the offset at a given moment is recoverable: format a guess, read back what the wall
 * clock says there, and correct by the difference. Two passes settle it, because the correction can
 * itself cross a DST boundary.
 */

/** A JSCalendar local date-time: `2026-08-20T10:00:00`, no offset. */
export type LocalDateTime = string

/** Splits a local date-time into its parts. Returns `null` for anything unparseable. */
export function parseLocal(local: LocalDateTime): {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
} | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(local.trim())
  if (match === null) return null
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4] ?? '0'),
    minute: Number(match[5] ?? '0'),
    second: Number(match[6] ?? '0'),
  }
}

/** The wall-clock reading of `instant` in `timeZone`, as a UTC-based timestamp for arithmetic. */
function wallClockAt(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant))

  const read = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0')
  // `hour12: false` can render midnight as 24; Date.UTC normalises it, but the day would be wrong.
  const hour = read('hour') % 24
  return Date.UTC(
    read('year'),
    read('month') - 1,
    read('day'),
    hour,
    read('minute'),
    read('second'),
  )
}

/**
 * The instant at which `local` occurs in `timeZone`.
 *
 * With no zone the value is *floating* — it means the same wall-clock time everywhere — and is
 * resolved in the reader's own zone, which is what a floating event means to the person looking
 * at it.
 *
 * Returns `null` for an unparseable input rather than an Invalid Date, so a malformed event cannot
 * silently sort to 1970.
 */
export function localToInstant(
  local: LocalDateTime,
  timeZone: string | null | undefined,
): number | null {
  const parts = parseLocal(local)
  if (parts === null) return null

  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  )
  if (timeZone === null || timeZone === undefined || timeZone === '') {
    // Floating: interpret in the reader's zone. `new Date(y, m, …)` is local-time construction.
    return new Date(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    ).getTime()
  }

  try {
    // First correction: how far the guess is from the wall clock we wanted.
    let instant = asUtc - (wallClockAt(asUtc, timeZone) - asUtc)
    // Second pass: the correction itself may have crossed a transition, so re-measure once.
    const drift = wallClockAt(instant, timeZone) - asUtc
    if (drift !== 0) instant -= drift
    return instant
  } catch {
    // An unknown zone name is the server's problem, not a reason to crash the view; fall back to
    // treating the value as floating.
    return new Date(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    ).getTime()
  }
}

/** Parses an ISO 8601 duration to milliseconds. Supports the subset JSCalendar events use. */
export function durationToMs(duration: string | null | undefined): number {
  if (typeof duration !== 'string') return 0
  const match = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)?$/.exec(
    duration.trim(),
  )
  if (match === null) return 0
  const num = (value: string | undefined): number => (value === undefined ? 0 : Number(value))
  const total =
    num(match[2]) * 604_800_000 +
    num(match[3]) * 86_400_000 +
    num(match[4]) * 3_600_000 +
    num(match[5]) * 60_000 +
    num(match[6]) * 1000
  return match[1] === '-' ? -total : total
}

/** Whether the event's zone differs from the reader's, i.e. whether the zone is worth showing. */
export function zoneDiffersFromLocal(timeZone: string | null | undefined): boolean {
  if (timeZone === null || timeZone === undefined || timeZone === '') return false
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone !== timeZone
  } catch {
    return false
  }
}
