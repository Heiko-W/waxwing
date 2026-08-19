/**
 * The JMAP seam for calendars (M5.6, FR-CAL-01).
 *
 * Online-only, like the other read-mostly surfaces: calendar data is not in the replica, so there
 * is nothing to reconcile and nothing to replay. A month the user is looking at is one round trip.
 *
 * **Occurrences come from the server.** `expandRecurrences` returns one id per occurrence inside
 * the window, so a weekly meeting arrives as the individual instances it has in that month. The
 * alternative — expanding the rule here — means implementing recurrence in local time across DST
 * transitions, which is the part of calendaring that is genuinely hard and that the server has
 * already done correctly.
 */

import type { Calendar, CalendarEvent, Id, JmapClient } from '@waxwing/jmap'
import { Capabilities, hasCapability, Methods } from '@waxwing/jmap'
import type { JmapSession } from '../app/session/types'
import { durationToMs, localToInstant } from './jscalendar-time'

/** An event placed on the timeline, ready to sort and group. */
export interface PlacedEvent {
  readonly event: CalendarEvent
  /** Absolute start; `null` when the event's own `start` could not be read. */
  readonly startsAt: number | null
  readonly endsAt: number | null
  /** A whole-day event is shown without a time. */
  readonly allDay: boolean
}

export interface CalendarClient {
  listCalendars(): Promise<Calendar[]>
  /** Events overlapping `[from, to)`, recurrences expanded, ordered by start. */
  eventsInRange(from: Date, to: Date, calendarIds?: readonly Id[]): Promise<PlacedEvent[]>
}

/** The properties the views actually read — a whole JSCalendar event is far larger. */
const EVENT_PROPERTIES = [
  'id',
  'calendarIds',
  'title',
  'description',
  'start',
  'duration',
  'timeZone',
  'showWithoutTime',
  'status',
  'locations',
  'participants',
  'recurrenceId',
  'isDraft',
]

/** Places one event on the timeline. */
export function placeEvent(event: CalendarEvent): PlacedEvent {
  const allDay = event.showWithoutTime === true
  const startsAt = localToInstant(event.start, allDay ? null : event.timeZone)
  const endsAt =
    startsAt === null
      ? null
      : startsAt +
        (allDay && event.duration === undefined ? 86_400_000 : durationToMs(event.duration))
  return { event, startsAt, endsAt, allDay }
}

export function makeCalendarClient(client: JmapClient, accountId: Id): CalendarClient {
  return {
    async listCalendars() {
      const responses = await client.call([
        [Methods.calendarGet.name, { accountId, ids: null }, 'c0'],
      ])
      return responses.get<{ list: Calendar[] }>('c0').list
    },

    async eventsInRange(from, to, calendarIds) {
      const builder = client.request()
      const query = builder.invoke(Methods.calendarEventQuery, {
        accountId,
        filter: {
          after: from.toISOString(),
          before: to.toISOString(),
          ...(calendarIds === undefined || calendarIds.length === 0
            ? {}
            : { inCalendars: [...calendarIds] }),
        },
        // See the note at the top: the server owns recurrence expansion.
        expandRecurrences: true,
      })
      const events = builder.invoke(Methods.calendarEventGet, {
        accountId,
        '#ids': query.ref('/ids'),
        properties: EVENT_PROPERTIES,
      })
      const responses = await builder.send()

      return (
        responses
          .get(events)
          .list.map(placeEvent)
          // An event whose start could not be read is dropped rather than sorted to 1970, where it
          // would appear at the top of every view for ever.
          .filter((placed: PlacedEvent) => placed.startsAt !== null)
          .sort((a: PlacedEvent, b: PlacedEvent) => (a.startsAt as number) - (b.startsAt as number))
      )
    },
  }
}

/** Does this server offer calendars for this account? */
export function serverSupportsCalendars(
  session: JmapSession | null,
  accountId: string | null,
): boolean {
  if (session === null || accountId === null) return false
  return hasCapability(session, Capabilities.calendars, accountId)
}
