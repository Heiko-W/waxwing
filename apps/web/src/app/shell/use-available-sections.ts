/**
 * Which primary sections this server actually offers (JMAP gap analysis, I-3).
 *
 * `serverSupportsCalendars` and `serverSupportsFiles` had been written, exported and tested when
 * their pages landed — and **nothing called either of them**. The consequence was visible on any
 * server without the two draft capabilities (Calendar is `draft-ietf-jmap-calendars`, FileNode has
 * no RFC at all, so "without" is the common case, not the exotic one): the rail and the phone tab
 * bar offered Calendar and Files anyway, and tapping one opened a screen whose first request comes
 * back `unknownCapability` — an error page reached through a menu item that promised a feature.
 *
 * Apple's rule for this is not "disable it": a capability the device does not have is simply not in
 * the tab bar. So the item is REMOVED, not greyed out — a greyed row is a promise with an
 * explanation attached, and there is nothing here for the user to fix.
 *
 * The same answer has to cover a typed-in `/calendar`, which no amount of nav filtering reaches;
 * {@link isSectionAvailable} is what {@link AppShell} asks before it mounts the lazy page, so a deep
 * link lands on "not found" rather than on a capability error.
 *
 * **Why this does not call `serverSupportsCalendars` / `serverSupportsFiles`, which are exactly this
 * check.** Both live beside their page in a lazy chunk. Importing one symbol from
 * `calendar/calendar-client` and `files/files-client` pulls both modules into the EAGER entry chunk,
 * measured at **+2.47 kB gzipped** (280.39 → 282.86 kB against a 300 kB budget) — a fifth of the
 * remaining headroom for two capability lookups. `hasCapability` is already in the entry chunk, so
 * asking it directly costs 0.10 kB. The two wrappers are consequently still uncalled; folding them
 * into a re-export of this module is the tidy-up, and it belongs in whichever branch owns those
 * files next.
 *
 * Mail and Settings are not gated: mail is the reason the app exists and Settings is local chrome.
 * Contacts is not gated either — the finding named the Calendar and Files items, and widening the
 * gate to a capability no measured server withholds would be a guess dressed as a fix.
 */

import { Capabilities, hasCapability } from '@waxwing/jmap'
import type { RouteId } from '../route'
import { useSessionOptional } from '../session/context'
import type { JmapSession } from '../session/types'

/** The route ids whose availability depends on a server capability. */
const GATED: readonly RouteId[] = ['calendar', 'files']

/** A section predicate: `true` for every section not in {@link GATED}. */
export type SectionAvailability = (id: RouteId) => boolean

/**
 * A predicate over {@link RouteId}, recomputed whenever the session document changes.
 *
 * Deliberately NOT memoised on the session object: the check is two property lookups, and a stale
 * `useMemo` on a session that reconnected under a different account is the failure mode that would
 * actually hurt here (a section staying hidden after the capability appeared).
 */
export function useSectionAvailability(): SectionAvailability {
  const connected = useSessionOptional()
  const session = connected?.jmapSession ?? null
  const accountId = connected?.accountId ?? null
  return (id) => isSectionAvailable(id, session, accountId)
}

/** Pure form of {@link useSectionAvailability}, for the route guard and for tests. */
export function isSectionAvailable(
  id: RouteId,
  session: JmapSession | null,
  accountId: string | null,
): boolean {
  if (session === null || accountId === null) return !GATED.includes(id)
  if (id === 'calendar') return hasCapability(session, Capabilities.calendars, accountId)
  if (id === 'files') return hasCapability(session, Capabilities.fileNode, accountId)
  return true
}
