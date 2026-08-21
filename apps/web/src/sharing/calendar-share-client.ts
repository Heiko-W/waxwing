/**
 * The JMAP seam for sharing a calendar (S-2, RFC 9670 + `draft-ietf-jmap-calendars`).
 *
 * **The one of the three that needs no load, and the reason is a property list that already exists.**
 * `apps/web/src/calendar/calendar-client.ts` sends `CALENDAR_PROPERTIES` on every `Calendar/get`, and
 * `shareWith` has been in it since K-1 — asked for, unused, because nothing wrote grants. So the
 * calendar rail is already holding the true grant map when the reader opens the dialog, exactly as
 * the Files screen holds a node's, and the load/failed/ready dance `MailboxShareDialog` has to
 * perform is not needed here. If that property is ever dropped from the list, this seam has to grow
 * a `load()` — the failure would otherwise be silent and would revoke everyone.
 *
 * What it does own is the WRITE, and it is deliberately not `CalendarClient.updateCalendar`: that
 * method's patch type is the calendar EDITOR's vocabulary (name, colour, isVisible), it lives in the
 * calendar's lazy chunk, and its `throwIfRefused` flattens every refusal into one message. A share
 * refusal has to be told apart — `invalidProperties` means a rights key this client should not have
 * sent, `forbidden` means the user may not share this calendar after all — so it is classified here
 * the way the other two sharing clients classify theirs.
 *
 * The `using` set is core + calendars, derived from the method name. Measured for `Mailbox`, and
 * assumed here for the same reason: an unrecognised `using` entry costs the WHOLE request on this
 * server (HTTP 400 `notRequest`), so nothing is added on speculation.
 */

import type { Id, JmapClient, Principal } from '@waxwing/jmap'
import { Methods } from '@waxwing/jmap'
import type { CalendarShareWith } from './calendar-roles'
import { searchPrincipals } from './principals'

/** Why a share write failed, in the terms the UI can explain. */
export type CalendarShareFailure = 'forbidden' | 'invalidRights' | 'rejected'

export class CalendarShareError extends Error {
  constructor(
    readonly failure: CalendarShareFailure,
    description?: string | null,
  ) {
    super(description ?? failure)
    this.name = 'CalendarShareError'
  }
}

export interface CalendarSharingClient {
  searchPrincipals(query: string): Promise<Principal[]>
  /** Replaces the calendar's WHOLE grant map. */
  setShareWith(calendarId: Id, shareWith: CalendarShareWith): Promise<void>
}

export function makeCalendarSharingClient(
  client: JmapClient,
  accountId: Id,
  /** Excluded from principal searches. */
  selfPrincipalId: Id | null = null,
): CalendarSharingClient {
  return {
    async searchPrincipals(query) {
      return await searchPrincipals(client, accountId, query, selfPrincipalId)
    },

    async setShareWith(calendarId, shareWith) {
      const responses = await client.call([
        [Methods.calendarSet.name, { accountId, update: { [calendarId]: { shareWith } } }, 'c0'],
      ])
      const response = responses.get<{
        notUpdated: Record<string, { type: string; description?: string | null }> | null
      }>('c0')
      // Per object, not per request: the batch survives, this one calendar does not change.
      const first = Object.values(response.notUpdated ?? {})[0]
      if (first !== undefined) throw new CalendarShareError(classify(first.type), first.description)
    },
  }
}

function classify(type: string): CalendarShareFailure {
  if (type === 'forbidden') return 'forbidden'
  if (type === 'invalidProperties') return 'invalidRights'
  return 'rejected'
}
