/**
 * Message-list timestamp formatting (M1.6, FR-LST-03): a compact, localized, age-dependent label —
 * a relative phrase for the last day ("2h ago", "yesterday"), a short weekday within the week
 * ("Mon"), a month/day for older-this-year ("Mar 3"), and a full date across years. Built on the
 * shared Intl helpers so it follows the active locale.
 *
 * ## Why this parses defensively (R-09)
 *
 * RFC 8621 makes `receivedAt` a mandatory `UTCDate`, and nothing between the wire and here checks
 * that it is one: `port.ts` casts the response list, `toEmailRow` spreads it into the row, and the
 * row is rendered. `Intl.DateTimeFormat.format` THROWS a `RangeError` on an `Invalid Date`, in the
 * render path of a virtualized list — so one malformed envelope from one non-conforming server took
 * the whole mail route into the error boundary, and a reload did not help, because the row sits in
 * the replica until it is evicted. `message-body.ts` is deliberately defensive about ADDRESSES for
 * exactly this reason ("a throw costs the whole app"); the date was the remaining unguarded field.
 *
 * There are TWO failure classes and they look nothing alike. `undefined`, `''`, a non-ISO string and
 * an out-of-range one (`2026-13-45T00:00:00Z`) all produce `Invalid Date` and throw. But `null` and
 * a bare number do NOT throw: `new Date(null)` is the epoch and `new Date(1234)` is 1.234 seconds
 * after it, so a server sending either got a confident, wrong "Jan 1, 1970" — the quieter defect of
 * the two, and the one no error boundary would ever have surfaced. {@link parseReceivedAt} refuses
 * both classes, which is why it insists on a non-empty STRING before it parses anything.
 */

import { formatDate, formatRelativeTime } from '../i18n/formatters'

const DAY_MS = 86_400_000

/**
 * A server-supplied timestamp as a `Date`, or `null` when the value is not one.
 *
 * Takes `unknown` on purpose: the type says `string` all the way down from `packages/jmap`, and the
 * point of this function is that the type is a claim about the server, not a fact about the bytes.
 */
export function parseReceivedAt(value: unknown): Date | null {
  if (typeof value !== 'string' || value === '') return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * The row label for `iso`, or `null` when it is not a usable timestamp — the caller renders the
 * placeholder, because this module has no `t`.
 */
export function formatMessageTime(iso: string, now: number = Date.now()): string | null {
  const date = parseReceivedAt(iso)
  if (date === null) return null
  const age = now - date.getTime()
  if (age < DAY_MS) return formatRelativeTime(date, now)
  if (age < 7 * DAY_MS) return formatDate(date, { weekday: 'short' })
  if (date.getFullYear() === new Date(now).getFullYear()) {
    return formatDate(date, { month: 'short', day: 'numeric' })
  }
  return formatDate(date, { year: 'numeric', month: 'short', day: 'numeric' })
}
