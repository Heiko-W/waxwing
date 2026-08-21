/**
 * JMAP for Calendars — `Calendar` and `CalendarEvent` (M5.6, FR-CAL-01).
 *
 * **Two specifications, and neither is an RFC.** That is worth stating plainly, because the file
 * this replaced claimed one of them was final and was wrong about it:
 *
 *  - the **transport and object model** is `draft-ietf-jmap-calendars` — the `Calendar` object, the
 *    `/get`,`/set`,`/query` shapes, and the handful of envelope properties JMAP adds to an event
 *    (`calendarIds`, `isOrigin`, `isDraft`, `baseEventId`). It sits in the RFC Editor queue and has
 *    no number yet.
 *  - the **event payload** is JSCalendar. RFC 8984 is final, but Stalwart does not implement it: it
 *    implements **`draft-ietf-calext-jscalendarbis`**, the revision that is meant to obsolete
 *    RFC 8984, and the two differ in property names this client has to get right. See
 *    `docs/adr/025-jscalendarbis-is-the-wire-format.md` for the measurements.
 *
 * Every property below carries a marker saying which of the two it comes from, so the next reader
 * looks it up in the right document. The three that cost the most to find the hard way:
 * `recurrenceRule` is SINGULAR, a participant's address is `calendarAddress` and not `sendTo`, and
 * an expanded instance names its master in `baseEventId`.
 *
 * As before, every shape here was **measured against Stalwart 0.16** rather than transcribed —
 * where server and draft differ, the server wins and the difference is written down.
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

/**
 * A calendar address, as JSCalendar 2.0 writes one: a bare URI string, `mailto:someone@example.test`.
 *
 * RFC 8984 modelled the same thing as a `sendTo` MAP from method (`imip`, `web`) to URI.
 * `jscalendarbis` replaced that map with this single string, and Stalwart followed — see
 * {@link Participant.calendarAddress} for what happens if a client sends the old shape.
 */
export type CalendarAddress = string

/** Per-calendar permissions (`draft-ietf-jmap-calendars`; measured, and the draft's set is the same). */
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

/**
 * A calendar (the container an event belongs to) — `draft-ietf-jmap-calendars` §4.
 *
 * **Half of this arrives only if you ask for it.** Measured: `Calendar/get` with no `properties`
 * answers `id, name, description, color, timeZone, sortOrder, isDefault, isSubscribed, myRights`
 * and nothing else. The five optional properties below are omitted from that default answer and
 * come back only when named explicitly, which is why they are typed as optional here rather than
 * required — a client that adds one to the type and forgets the request reads `undefined`
 * everywhere and concludes the server does not support it.
 */
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
  /**
   * Whether this calendar's events should be drawn at all.
   *
   * **Only `false` means hidden.** `undefined` means the property was not requested (or the server
   * does not send it), and treating that as "hidden" empties the calendar on any server that does
   * not implement it. The rule is one-sided on purpose: absent is visible.
   */
  isVisible?: boolean
  /** Which of this calendar's events count towards free/busy. Measured value: `attending`. */
  includeInAvailability?: 'all' | 'attending' | 'none'
  /** Alerts applied to new TIMED events that do not set their own. */
  defaultAlertsWithTime?: Record<Id, Alert> | null
  /** Alerts applied to new WHOLE-DAY events that do not set their own. */
  defaultAlertsWithoutTime?: Record<Id, Alert> | null
  /** Principal id → the rights that principal has here. Absent when the calendar is not shared. */
  shareWith?: Record<Id, CalendarRights> | null
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

/** How a participant answered (JSCalendar §4.4). */
export type ParticipationStatus = 'needs-action' | 'accepted' | 'declined' | 'tentative'

/**
 * One participant of an event (JSCalendar).
 *
 * **`calendarAddress`, not `sendTo` — and getting it wrong is silent.** Measured against Stalwart
 * 0.16: a `CalendarEvent/set` whose participants carry RFC 8984's `sendTo: {imip: "mailto:…"}` is
 * answered `created`, with no error and no `invalidProperties`; reading the event back shows it has
 * no `participants` at all. The whole map is dropped on the floor. The same call with
 * `calendarAddress` stores every participant and echoes them back.
 */
export interface Participant {
  '@type'?: 'Participant'
  name?: string
  email?: string
  /**
   * `mailto:someone@example.test`. Required by `jscalendarbis` whenever `expectReply` is set, and
   * the server adds one for the organiser itself if the client does not.
   */
  calendarAddress?: CalendarAddress
  /** The address that acted on this participant's behalf (a delegate or an assistant). */
  sentBy?: CalendarAddress
  /** `owner`, `attendee`, `chair`, `optional`, `required`, … — a set, not a single value. */
  roles?: Record<string, boolean>
  /** `individual`, `group`, `resource`, `location`. Stalwart fills this in for the organiser. */
  kind?: string
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

/** A recurrence rule (JSCalendar §4.3). Only the fields a client commonly writes are named. */
export interface RecurrenceRule {
  '@type'?: 'RecurrenceRule'
  frequency: 'yearly' | 'monthly' | 'weekly' | 'daily' | 'hourly' | 'minutely' | 'secondly'
  interval?: UnsignedInt
  count?: UnsignedInt
  until?: LocalDateTime
  byDay?: { '@type'?: 'NDay'; day: string; nthOfPeriod?: number }[]
  byMonthDay?: number[]
  /**
   * Months, as STRINGS — `'1'` for January, and `'5L'` for a leap month in a lunisolar calendar.
   * That last case is why the format cannot use numbers here, and it is the one property of this
   * object whose type surprises everybody. `byMonthDay` above really is numeric.
   */
  byMonth?: string[]
}

/**
 * A calendar event.
 *
 * The payload is JSCalendar (`jscalendarbis`); `calendarIds`, `isOrigin`, `isDraft` and
 * `baseEventId` are the envelope `draft-ietf-jmap-calendars` adds around it, and are marked as
 * such below so nobody hunts for them in the wrong document.
 *
 * Deliberately not exhaustive: JSCalendar is a large format and this names what the client reads
 * or writes. Unknown properties survive a round trip because the server keeps them — this type
 * does not model them, which is a different thing from destroying them.
 */
export interface CalendarEvent {
  '@type'?: 'Event'
  id: Id
  /** **JMAP envelope.** Which calendars it belongs to, as a set. */
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
  /**
   * The organiser's calendar address. Set it whenever `participants` is set — `jscalendarbis`
   * requires it, and Stalwart 0.16.18's release notes name a bug where the server failed to assign
   * it and then sent no scheduling messages at all.
   */
  organizerCalendarAddress?: CalendarAddress
  /**
   * The iTIP method in lowercase (`request`, `reply`, `cancel`, …).
   *
   * **Immutable on this server:** an update naming it is refused with
   * `invalidProperties: "This property is immutable."`, so it is a read-only field for the editor.
   */
  method?: string
  alerts?: Record<string, Alert>
  /**
   * The repetition rule — **SINGULAR, one object, not an array**.
   *
   * RFC 8984 §4.3.3 named this `recurrenceRules` and typed it as a list; `jscalendarbis` replaced
   * it with a single `recurrenceRule`, and Stalwart implements the latter in BOTH directions.
   * Measured: a create carrying `recurrenceRules` is refused outright
   * (`invalidProperties: ["recurrenceRules"]`), the same create carrying `recurrenceRule` succeeds,
   * and a read answers `recurrenceRule` — which is why a master asked for the plural spelling came
   * back looking like an ordinary event for months.
   */
  recurrenceRule?: RecurrenceRule
  /** Per-instance overrides, keyed by the instance's local start. */
  recurrenceOverrides?: Record<LocalDateTime, Record<string, unknown> | null>
  /** **JMAP envelope.** Server-set: is this account the authoritative source for the event? */
  isOrigin?: boolean
  /** **JMAP envelope.** A draft is not scheduled and triggers no alerts. */
  isDraft?: boolean
  /**
   * **JMAP envelope.** The id of the MASTER event this synthetic instance was expanded from.
   *
   * Present on every occurrence an `expandRecurrences` query answers with — including occurrences
   * of events that repeat nothing, where it simply names the event itself. Absent on a real,
   * stored object, because the draft defines it only "if the `id` property is a synthetic id".
   *
   * This is the one certain way back from a display id to a writable one, and it is why
   * `calendar-client.ts` no longer has to guess. Its presence says nothing about recurrence:
   * `recurrenceId` reports that.
   */
  baseEventId?: Id
  /** Present on an expanded instance: which occurrence this is (JSCalendar §4.3). */
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
/**
 * `Calendar/set` — plus the one argument that is not in {@link SetRequest}.
 *
 * **A calendar that holds events cannot simply be destroyed.** Measured against Stalwart v0.16.18:
 * `destroy: ["<id>"]` on a non-empty calendar answers
 * `{"type":"calendarHasEvent","description":"Calendar is not empty."}` and changes nothing. The
 * same call with `onDestroyRemoveEvents: true` succeeds and takes every event in the calendar with
 * it — which is precisely why the screen asks first (see `CalendarList`): the flag is the client
 * saying out loud that it accepts the cascade, and there is no way back from it.
 */
export type CalendarSetRequest = SetRequest<Calendar> & {
  /** Destroy the calendar's events along with it. Without it a non-empty calendar is refused. */
  onDestroyRemoveEvents?: boolean
}
export type CalendarSetResponse = SetResponse<Calendar>

export type CalendarEventGetRequest = GetRequest
export type CalendarEventGetResponse = GetResponse<CalendarEvent>
export type CalendarEventChangesRequest = ChangesRequest
export type CalendarEventChangesResponse = ChangesResponse
export type CalendarEventSetRequest = SetRequest<CalendarEvent>
export type CalendarEventSetResponse = SetResponse<CalendarEvent>

/** Filter conditions for `CalendarEvent/query`. */
export interface CalendarEventFilterCondition {
  /**
   * Events in ONE calendar — **singular, one id, and not `inCalendars`**.
   *
   * `draft-ietf-jmap-calendars` spells this `inCalendars` and types it as a list. Stalwart v0.16.18
   * implements neither: `inCalendars` (and `calendarIds`, and `calendarId`) is answered
   * `{"type":"unsupportedFilter","description":"inCalendars"}`, which is a METHOD-LEVEL error — the
   * whole query fails, so a client that sends the draft's spelling loses the month rather than the
   * filter. `inCalendar` with a single id works, including alongside `expandRecurrences`.
   *
   * More than one calendar is therefore an `OR` of these conditions; see `calendarFilter()` in
   * `apps/web/src/calendar/calendar-client.ts`, which is the only place that builds one.
   */
  inCalendar?: Id
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
   *
   * The ids it answers with are SYNTHETIC and cannot be written to; each expanded event carries
   * {@link CalendarEvent.baseEventId} naming the real one.
   */
  expandRecurrences?: boolean
}

export type CalendarEventQueryResponse = QueryResponse
export type CalendarEventQueryChangesRequest = Omit<QueryChangesRequest, 'filter'> & {
  filter?: CalendarEventFilter | null
}
export type CalendarEventQueryChangesResponse = QueryChangesResponse
