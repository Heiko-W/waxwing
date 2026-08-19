/**
 * JMAP for Calendars — `Calendar` and `CalendarEvent` (M5.6, FR-CAL-01).
 *
 * **Standardisation status, stated plainly:** this is `draft-ietf-jmap-calendars`, which sits in
 * the RFC Editor queue and has no RFC number yet. The event payload itself is JSCalendar, which
 * *is* final (RFC 8984). Every shape below was **measured against Stalwart 0.16** rather than
 * transcribed from the draft — where the two differ, the server won.
 *
 * **The one modelling decision worth understanding.** A JSCalendar `start` is a *local* date-time
 * with no offset (`2026-08-20T10:00:00`), and the zone lives beside it in `timeZone`. That is not
 * an oversight in the format: "the 20th at 10:00 in Berlin" stays 10:00 in Berlin when the
 * organiser later moves the meeting to another zone, which an absolute instant cannot express. A
 * client that parses `start` as UTC gets every timed event wrong by its offset — and right on the
 * machine of whoever tested it in London in winter.
 */

import type {
  ChangesRequest,
  ChangesResponse,
  FilterOperator,
  GetRequest,
  GetResponse,
  Id,
  QueryChangesRequest,
  QueryChangesResponse,
  QueryRequest,
  QueryResponse,
  SetRequest,
  SetResponse,
  UnsignedInt,
  UTCDate,
} from './core'

/** A local date-time with NO offset: `2026-08-20T10:00:00`. Read it with {@link CalendarEvent.timeZone}. */
export type LocalDateTime = string

/** An ISO 8601 duration: `PT1H`, `P1D`. */
export type Duration = string

/** Per-calendar permissions (measured; the draft's set is the same). */
export interface CalendarRights {
  mayReadFreeBusy: boolean
  mayReadItems: boolean
  /** May create and modify any event, including other people's. */
  mayWriteAll: boolean
  /** May create and modify events where the user is the organiser. */
  mayWriteOwn: boolean
  /** May change the private properties (alerts, colour) of someone else's event. */
  mayUpdatePrivate: boolean
  /** May answer an invitation. */
  mayRSVP: boolean
  mayShare: boolean
  mayDelete: boolean
}

/** A calendar (the container an event belongs to). */
export interface Calendar {
  id: Id
  name: string
  description: string | null
  /** CSS colour the client may use for this calendar's events; `null` = pick one. */
  color: string | null
  /** The calendar's default zone for new events; `null` = the user's own. */
  timeZone: string | null
  sortOrder: UnsignedInt
  isDefault: boolean
  isSubscribed: boolean
  myRights: CalendarRights
}

/** The account-level `urn:ietf:params:jmap:calendars` object (measured against Stalwart 0.16). */
export interface CalendarCapability {
  maxCalendarsPerEvent: UnsignedInt | null
  minDateTime: LocalDateTime
  maxDateTime: LocalDateTime
  /**
   * The widest window a single `expandRecurrences` query may cover, as an ISO 8601 duration —
   * Stalwart answers `P52W1D`. A month view is far inside it; a "show me everything" view is not,
   * which is why one does not exist.
   */
  maxExpandedQueryDuration: Duration
  maxParticipantsPerEvent: UnsignedInt | null
  mayCreateCalendar: boolean
}

/** How a participant answered (JSCalendar, RFC 8984 §4.4.5). */
export type ParticipationStatus = 'needs-action' | 'accepted' | 'declined' | 'tentative'

/** One participant of an event. */
export interface Participant {
  '@type'?: 'Participant'
  name?: string
  email?: string
  /** `mailto:someone@example.test`. */
  sendTo?: Record<string, string>
  /** `owner`, `attendee`, `chair`, `optional`, … — a set, not a single value. */
  roles?: Record<string, boolean>
  participationStatus?: ParticipationStatus
  expectReply?: boolean
}

/** A reminder (JSCalendar §4.5.2). */
export interface Alert {
  '@type'?: 'Alert'
  trigger?: {
    '@type'?: 'OffsetTrigger' | 'AbsoluteTrigger'
    /** For an OffsetTrigger: `-PT15M` = fifteen minutes before. */
    offset?: Duration
    when?: UTCDate
    relativeTo?: 'start' | 'end'
  }
  action?: 'display' | 'email'
}

/** A recurrence rule (JSCalendar §4.3.3). Only the fields a client commonly writes are named. */
export interface RecurrenceRule {
  '@type'?: 'RecurrenceRule'
  frequency: 'yearly' | 'monthly' | 'weekly' | 'daily' | 'hourly' | 'minutely' | 'secondly'
  interval?: UnsignedInt
  count?: UnsignedInt
  until?: LocalDateTime
  byDay?: { '@type'?: 'NDay'; day: string; nthOfPeriod?: number }[]
  byMonthDay?: number[]
}

/**
 * A calendar event (JSCalendar, RFC 8984).
 *
 * Deliberately not exhaustive: JSCalendar is a large format and this names what the client reads
 * or writes. Unknown properties survive a round trip because the server keeps them — this type
 * does not model them, which is a different thing from destroying them.
 */
export interface CalendarEvent {
  '@type'?: 'Event'
  id: Id
  /** Which calendars it belongs to, as a set. */
  calendarIds: Record<Id, boolean>
  title?: string
  description?: string
  /** LOCAL date-time. See the note at the top of this file before doing arithmetic on it. */
  start: LocalDateTime
  duration?: Duration
  /** IANA zone name; `null`/absent means the event is floating (same wall-clock time everywhere). */
  timeZone?: string | null
  /** A whole-day event has no time-of-day and no zone. */
  showWithoutTime?: boolean
  status?: 'confirmed' | 'cancelled' | 'tentative'
  freeBusyStatus?: 'free' | 'busy'
  privacy?: 'public' | 'private' | 'secret'
  locations?: Record<string, { '@type'?: 'Location'; name?: string }>
  virtualLocations?: Record<string, { '@type'?: 'VirtualLocation'; name?: string; uri?: string }>
  participants?: Record<string, Participant>
  alerts?: Record<string, Alert>
  recurrenceRules?: RecurrenceRule[]
  /** Per-instance overrides, keyed by the instance's local start. */
  recurrenceOverrides?: Record<LocalDateTime, Record<string, unknown> | null>
  /** Server-set: whether this is the master event rather than an expanded instance. */
  isOrigin?: boolean
  isDraft?: boolean
  /** Present on an expanded instance: which occurrence this is. */
  recurrenceId?: LocalDateTime
  uid?: string
  sequence?: UnsignedInt
  created?: UTCDate
  updated?: UTCDate
  [key: string]: unknown
}

export type CalendarGetRequest = GetRequest
export type CalendarGetResponse = GetResponse<Calendar>
export type CalendarChangesRequest = ChangesRequest
export type CalendarChangesResponse = ChangesResponse
export type CalendarSetRequest = SetRequest<Calendar>
export type CalendarSetResponse = SetResponse<Calendar>

export type CalendarEventGetRequest = GetRequest
export type CalendarEventGetResponse = GetResponse<CalendarEvent>
export type CalendarEventChangesRequest = ChangesRequest
export type CalendarEventChangesResponse = ChangesResponse
export type CalendarEventSetRequest = SetRequest<CalendarEvent>
export type CalendarEventSetResponse = SetResponse<CalendarEvent>

/** Filter conditions for `CalendarEvent/query`. */
export interface CalendarEventFilterCondition {
  inCalendars?: Id[]
  /** Events that end at or after this instant. */
  after?: UTCDate
  /** Events that start before this instant. */
  before?: UTCDate
  text?: string
  title?: string
  description?: string
  location?: string
  uid?: string
}

export type CalendarEventFilter = FilterOperator | CalendarEventFilterCondition

export type CalendarEventQueryRequest = Omit<QueryRequest, 'filter'> & {
  filter?: CalendarEventFilter | null
  /**
   * Return one id per OCCURRENCE rather than one per master event.
   *
   * This is what makes a month view possible: without it a weekly meeting is a single id and the
   * client would have to expand the rule itself, in local time, across DST — the part of calendar
   * handling that is genuinely hard and that the server has already done. Requires `after` and
   * `before`, and the window may not exceed
   * {@link CalendarCapability.maxExpandedQueryDuration}.
   */
  expandRecurrences?: boolean
}

export type CalendarEventQueryResponse = QueryResponse
export type CalendarEventQueryChangesRequest = Omit<QueryChangesRequest, 'filter'> & {
  filter?: CalendarEventFilter | null
}
export type CalendarEventQueryChangesResponse = QueryChangesResponse
