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

/** The fields the editor writes. A JSCalendar event has far more; these are the ones it owns. */
export interface EventDraft {
  readonly calendarId: Id
  readonly title: string
  readonly description: string
  /** Local date-time, `2026-08-20T10:00:00` — no offset (see `jscalendar-time.ts`). */
  readonly start: string
  readonly durationMinutes: number
  readonly allDay: boolean
  /** IANA zone; `null` means floating. */
  readonly timeZone: string | null
}

export interface CalendarClient {
  listCalendars(): Promise<Calendar[]>
  /** Events overlapping `[from, to)`, recurrences expanded, ordered by start. */
  eventsInRange(from: Date, to: Date, calendarIds?: readonly Id[]): Promise<PlacedEvent[]>
  createEvent(draft: EventDraft): Promise<void>
  updateEvent(id: Id, draft: EventDraft): Promise<void>
  destroyEvent(id: Id): Promise<void>
}

/**
 * Whether this event may be edited here.
 *
 * **Recurring events are refused**, and that is the whole safety property of this editor. Changing
 * one occurrence of a series means deciding between "this one", "this and following" and "all",
 * writing `recurrenceOverrides` accordingly, and getting iTIP right for every participant. An
 * editor that quietly applied one of those three to a meeting other people are in would lose their
 * time, not ours. Series stay read-only until that scope editor exists.
 *
 * An expanded instance is recognisable by its `recurrenceId`; a master by its `recurrenceRules`.
 */
export function isEditable(event: CalendarEvent): boolean {
  if (event.recurrenceId !== undefined) return false
  const rules = event.recurrenceRules
  return !(Array.isArray(rules) && rules.length > 0)
}

/** The JSCalendar patch an {@link EventDraft} describes. */
export function draftToEvent(draft: EventDraft): Record<string, unknown> {
  return {
    '@type': 'Event',
    calendarIds: { [draft.calendarId]: true },
    title: draft.title,
    // `null` clears the property rather than storing an empty string (RFC 8984 patch semantics).
    description: draft.description === '' ? null : draft.description,
    start: draft.start,
    duration: draft.allDay ? 'P1D' : `PT${Math.max(1, Math.round(draft.durationMinutes))}M`,
    // A whole-day event has neither a time of day nor a zone; saying otherwise makes it move
    // across a border.
    showWithoutTime: draft.allDay ? true : null,
    timeZone: draft.allDay ? null : draft.timeZone,
  }
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

    async createEvent(draft) {
      const responses = await client.call([
        [Methods.calendarEventSet.name, { accountId, create: { e: draftToEvent(draft) } }, 'c0'],
      ])
      throwIfRefused(responses.get<SetOutcome>('c0'))
    },

    async updateEvent(id, draft) {
      const responses = await client.call([
        [Methods.calendarEventSet.name, { accountId, update: { [id]: draftToEvent(draft) } }, 'c0'],
      ])
      throwIfRefused(responses.get<SetOutcome>('c0'))
    },

    async destroyEvent(id) {
      const responses = await client.call([
        [Methods.calendarEventSet.name, { accountId, destroy: [id] }, 'c0'],
      ])
      throwIfRefused(responses.get<SetOutcome>('c0'))
    },
  }
}

/** The refusal maps a `/set` can carry. */
interface SetOutcome {
  notCreated?: Record<string, { type: string; description?: string | null }> | null
  notUpdated?: Record<string, { type: string; description?: string | null }> | null
  notDestroyed?: Record<string, { type: string; description?: string | null }> | null
}

/** A per-object refusal the UI can report. */
export class CalendarSetError extends Error {
  constructor(
    readonly type: string,
    description?: string | null,
  ) {
    super(description ?? type)
    this.name = 'CalendarSetError'
  }
}

function throwIfRefused(response: SetOutcome): void {
  for (const group of [response.notCreated, response.notUpdated, response.notDestroyed]) {
    const first = Object.values(group ?? {})[0]
    if (first !== undefined) throw new CalendarSetError(first.type, first.description)
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
