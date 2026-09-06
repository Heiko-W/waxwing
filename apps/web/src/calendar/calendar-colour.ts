/**
 * What colour a calendar is drawn in (#79).
 *
 * ## Why a calendar without a colour still gets one
 *
 * `Calendar.color` is optional in JMAP and a server is free never to set it. Stalwart's own default
 * calendar is exactly that case — measured against the fixture: `Calendar/get` returns the default
 * calendar of both accounts with no colour at all. So the honest reading of "each calendar in its
 * own colour" was, for the commonest setup there is, "every calendar in no colour".
 *
 * That is tolerable on a single-account month, where a chip only has to be legible. It is not
 * tolerable on the merged grid #79 introduced, whose entire premise is telling one account's
 * appointments from another's at a glance — and it is worst on a phone, where the title is
 * truncated to three or four characters and the colour is the only thing left carrying meaning.
 *
 * So a calendar with no colour of its own is assigned one, DERIVED rather than remembered:
 *
 *  - **Stable.** The same calendar is the same colour on every device and after every reload,
 *    because the hash is over ids that do not change, not over list order or arrival time. A colour
 *    that reshuffles is worse than no colour: it teaches the reader a mapping and then breaks it.
 *  - **Account-scoped.** The account id is in the hash, so two accounts whose calendars both happen
 *    to be `c1` (ADR-018 — ids are per-account and short) do not collide into one colour. That
 *    collision is what this whole feature is about.
 *  - **Not written back.** This is presentation, never a `Calendar/set`. Persisting it would claim a
 *    decision the reader never made, on an object that may not even be writable — and a shared
 *    calendar's colour is its owner's to choose.
 *
 * A calendar that DOES carry a colour keeps it, always. This only fills a gap.
 */

import type { Calendar, Id } from '@waxwing/jmap'
import { CALENDAR_COLORS } from './CalendarDialog'

/**
 * FNV-1a over the two ids.
 *
 * A hash rather than a running index, because an index depends on the ORDER the calendars arrived
 * in — and they arrive from several accounts over several round trips that finish in whatever order
 * the network decides. The same calendar would change colour between two loads of one screen.
 */
function hash(accountId: Id, calendarId: Id): number {
  const input = `${accountId} ${calendarId}`
  let value = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    value ^= input.charCodeAt(i)
    value = Math.imul(value, 0x01000193) >>> 0
  }
  return value
}

/** The calendar's own colour, or the derived one when it has none. Never empty. */
export function calendarColor(accountId: Id, calendar: Calendar): string {
  const own = calendar.color
  if (own !== undefined && own !== null && own !== '') return own
  const entry = CALENDAR_COLORS[hash(accountId, calendar.id) % CALENDAR_COLORS.length]
  // The palette is a non-empty module constant; this keeps the type honest without an assertion.
  return entry?.value ?? '#2761c4'
}
