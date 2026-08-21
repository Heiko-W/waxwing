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
 *
 * **But an occurrence id is not an object id, and that distinction is the whole of T1.** The ids an
 * expanded query answers with are SYNTHETIC: they name "the instance of that event on that day",
 * which is a thing that exists only for the length of the answer. Stalwart says so out loud — a
 * `/set` addressed to one comes back `invalidProperties: "Updating synthetic ids is not yet
 * supported."` — and the same patch addressed to the real id is accepted without complaint.
 * Waxwing read with expansion and then wrote back with what it had read, so editing and deleting
 * failed for EVERY event, including plain single ones that have no recurrence at all.
 *
 * So the range query asks TWICE in one request: once expanded, which is what the grid draws, and
 * once unexpanded, which is what a write may address. The resulting {@link PlacedEvent.writeId} is
 * the ONLY id this module will write to. An occurrence that cannot be traced back to an object
 * carries `writeId: null` and is shown read-only, rather than being offered an editor whose Save
 * is guaranteed to fail.
 *
 * **The two answers are joined by a SIGNATURE, and NOT by `uid`.** RFC 8984 gives every event a
 * `uid` and every occurrence its master's, so a uid join is the obvious design — it is what the
 * first attempt at this fix did, and it left every event in the calendar read-only on the wire
 * while passing every unit test. Measured against Stalwart v0.16, here is why:
 *
 *  - `uid` comes back only for an event that HAS one stored. Anything written over CalDAV does
 *    (iCalendar requires it), and a `CalendarEvent/set` that names a `uid` keeps it.
 *  - A `CalendarEvent/set` that does NOT name one gets no uid — Stalwart mints none, and the .ics
 *    it then serves over CalDAV has no `UID` line either.
 *  - {@link draftToEvent} names no uid. So every event a reader creates HERE has none, and a uid
 *    join fails for exactly the events this editor exists to edit while working for everyone
 *    else's — the worst possible distribution of a bug, and precisely the one that shipped.
 *
 * Minting a uid on create would fix half of that and nothing about events already stored, so the
 * join has to hold without one. If it is ever added, it belongs beside the branches in
 * {@link resolveIdentity} as a more certain one — never as a replacement for them.
 *
 * **That more certain branch now exists, and it is `baseEventId`.** `draft-ietf-jmap-calendars`
 * defines it as "only defined if the `id` property is a synthetic id", and Stalwart sends it on
 * EVERY event an expanded query answers with — `{"id":"iaaaaaf","baseEventId":"f"}` — including
 * instances of events that repeat nothing, where it names the event itself. It is the server
 * stating the mapping the signature was reconstructing, so it is asked for and consulted first.
 * The signature stays exactly where it was, as the fallback for a server that does not send it:
 * it is measured behaviour on one version of one server, and deleting the join that works without
 * it would trade a guess for a different guess.
 *
 * What the server does send, for an occurrence of a non-repeating event, is the stored event's own
 * record with a synthetic `id` swapped in — compared field by field against the unexpanded answer.
 * So {@link eventSignature} is built from what the two demonstrably share: `start`, `duration`,
 * `title`, `calendarIds`, `showWithoutTime`. `timeZone` is deliberately NOT among them: the
 * expanded answer says `Etc/UTC` where a direct read of the same event says `null` (the same
 * discrepancy T12 found in the agenda), so including it would fail to resolve precisely the
 * whole-day and floating events.
 *
 * The join is deliberately conservative. Exactly one object carrying the signature is a write id;
 * none, or more than one, leaves `writeId: null`. Two genuinely indistinguishable events in the
 * same window make each other read-only instead of one becoming the target of the other's edit.
 * In doubt, do not write.
 *
 * **A series is refused either way, which is what makes that conservatism affordable.** Measured
 * with a weekly `RRULE` put in over CalDAV: every expanded occurrence carries `recurrenceId`, so
 * {@link refuseEdit} answers `series` for all of them. Their `start` differs from the master's
 * from the second occurrence on, so the signature resolves nothing — and the first occurrence,
 * which does resolve, is refused on the series flag before the write id is ever consulted. Worth
 * knowing while reading {@link indexObjects}: that same measurement showed the stored master
 * answering WITHOUT `recurrenceRules` even when asked for it. That is no longer a mystery — the
 * client was asking for the wrong property name. Stalwart implements
 * `draft-ietf-calext-jscalendarbis`, where the rule is SINGULAR (`recurrenceRule`, one object) and
 * not RFC 8984's `recurrenceRules` array; asked by its real name, the master answers. See
 * `docs/adr/025-jscalendarbis-is-the-wire-format.md`. The occurrence's `recurrenceId` still
 * carries most of the load, but the master's own answer is no longer a belt that was never
 * fastened — which matters the moment a series editor exists, because that editor starts from the
 * master.
 */

import type {
  AvailabilityPeriod,
  Calendar,
  CalendarEvent,
  CalendarEventFilter,
  Id,
  JmapClient,
  ParticipantIdentity,
  ParticipationStatus,
  Principal,
} from '@waxwing/jmap'
import { Capabilities, hasCapability, Methods } from '@waxwing/jmap'
import type { JmapSession } from '../app/session/types'
import { searchPrincipals } from '../sharing/principals'
import { alertsToPatch, type EventAlerts } from './event-alerts'
import { type ParticipantRow, participantsToPatch, rsvpPatch } from './event-participants'
import {
  type EditScope,
  excludeOverride,
  mergeOverride,
  overrideFromDraft,
  overrideKeyFor,
  type RepeatEnd,
  type RepeatPreset,
  ruleToWrite,
} from './event-recurrence'
import {
  candidatesFrom,
  createsFor,
  type ImportCandidate,
  type ImportOutcome,
  outcomeFrom,
} from './ics-import'
import { durationToMs, localToInstant } from './jscalendar-time'

/**
 * How a displayed occurrence maps back to the stored object behind it.
 *
 * Kept apart from the event itself because it is knowledge about the QUERY, not about the event:
 * the same event read without expansion IS its own writable object, and read with expansion is an
 * instance of one.
 */
export interface EventIdentity {
  /** The id a `/set` may address, or `null` when the occurrence could not be traced back to one. */
  readonly writeId: Id | null
  /** Whether this occurrence belongs to a repeating event — the master's answer, not a guess. */
  readonly series: boolean
}

/**
 * The identity an occurrence gets when nothing resolved it.
 *
 * `writeId: null` rather than the event's own id, deliberately: the default has to be the SAFE
 * answer, or a caller who forgets to resolve identity quietly reintroduces T1 — writing with a
 * synthetic id and being refused.
 */
const UNRESOLVED: EventIdentity = { writeId: null, series: false }

/** An event placed on the timeline, ready to sort and group. */
export interface PlacedEvent {
  readonly event: CalendarEvent
  /** See {@link EventIdentity.writeId}. Never `event.id` unless the server said the two agree. */
  readonly writeId: Id | null
  /** See {@link EventIdentity.series}. */
  readonly series: boolean
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
  /**
   * The event's reminders, or `undefined` to leave them exactly as they are.
   *
   * **Optional on purpose, and the two absences differ.** `undefined` keeps `alerts` out of the
   * patch, so the server leaves whatever is stored alone — that is what a caller that knows nothing
   * about alerts gets, and it is what every save did before K-5. An `EventAlerts` with no offsets
   * and nothing opaque is the reader having EMPTIED the list, and writes `alerts: null`. See
   * `event-alerts.ts`.
   */
  readonly alerts?: EventAlerts | undefined
  /**
   * How the event repeats, or `undefined` to leave the stored rule exactly as it is.
   *
   * The same two-absence rule `alerts` follows, and for the same reason: this object is a PATCH, so
   * a caller that knows nothing about repetition must be able to save a title without deleting a
   * weekly meeting's rule. `{ preset: 'none' }` is the reader having said "does not repeat" and
   * writes `recurrenceRule: null`.
   */
  readonly repeat?: { readonly preset: RepeatPreset; readonly end: RepeatEnd } | undefined
  /**
   * The event's participants, or `undefined` to leave them alone.
   *
   * An EMPTY list is "there are none" and writes `participants: null` — which is how the last
   * attendee is removed. `EventFacts` used to protect this property by never naming it; now that
   * the editor names it, the protection has to be this distinction instead.
   */
  readonly participants?: readonly ParticipantRow[] | undefined
  /**
   * The organiser's address, written beside `participants`.
   *
   * `jscalendarbis` requires it whenever a participant carries an address. Measured on v0.16.18:
   * the server fills it in itself when the client omits it, so this is belt and braces — but the
   * release notes name a version where it did not, and then sent no scheduling messages at all.
   */
  readonly organizerCalendarAddress?: string | undefined
}

/** What {@link CalendarClient.createCalendar} and {@link CalendarClient.updateCalendar} may set. */
export interface CalendarDraft {
  readonly name: string
  /** A CSS colour, or `null` to let the client pick one. Measured: `null` clears a stored colour. */
  readonly color: string | null
}

export interface CalendarClient {
  listCalendars(): Promise<Calendar[]>
  /**
   * Events overlapping `[from, to)`, recurrences expanded, ordered by start.
   *
   * `calendarIds` has three meanings and all three are used: `undefined` is every calendar the
   * account has, a non-empty list is those calendars, and an EMPTY list is none — answered here
   * without a round trip, because a filter that names no calendar is a filter Stalwart would
   * ignore, and drawing every event under "nothing is shown" is the failure this parameter exists
   * to prevent.
   */
  eventsInRange(from: Date, to: Date, calendarIds?: readonly Id[]): Promise<PlacedEvent[]>
  createCalendar(draft: CalendarDraft): Promise<void>
  /** Patches one calendar. Only the named properties are sent, so the rest survive untouched. */
  updateCalendar(id: Id, patch: Partial<CalendarDraft & { isVisible: boolean }>): Promise<void>
  /**
   * Destroys a calendar **and every event in it**.
   *
   * Measured against Stalwart v0.16.18: a bare `destroy` on a non-empty calendar is refused with
   * `{"type":"calendarHasEvent","description":"Calendar is not empty."}`, so this call carries
   * `onDestroyRemoveEvents: true` — which is the server's way of making a client state that it
   * accepts the cascade. There is no Undo for it: `create` plus n × `CalendarEvent/set` would be a
   * re-enactment, not a restoration. Hence the confirmation on the screen (see `CalendarList`).
   */
  destroyCalendar(id: Id): Promise<void>
  /** How many events one calendar holds, for the sentence the delete confirmation says. */
  countEvents(calendarId: Id): Promise<number>
  /**
   * Creates one event.
   *
   * `sendInvitations` is the METHOD argument `sendSchedulingMessages`, and it is the only thing
   * that makes an invitation go out: measured on v0.16.18, a create carrying `participants` and
   * `organizerCalendarAddress` sends nothing at all without it — no mail, no queue entry, no error.
   * It is a parameter rather than something inferred from the draft, because "there are
   * participants" and "invite them now" are different statements and only the screen knows which
   * one the reader made.
   */
  createEvent(draft: EventDraft, sendInvitations?: boolean): Promise<void>
  /**
   * Writes the draft onto the object behind `target`.
   *
   * Takes the placed occurrence rather than an id, and that is not decoration: an `id` parameter is
   * exactly what let a display id reach the wire (T1). With the occurrence in hand, the call site
   * cannot pass the wrong one — there is only one id on it that a write may use.
   *
   * `scope` says what a change to an occurrence of a SERIES means. `'all'` patches the master, as
   * it always did. `'occurrence'` writes a `recurrenceOverrides` entry — see
   * {@link CalendarClient.updateOccurrence}, which is what it delegates to. For an event that does
   * not repeat the two are the same thing and the parameter is ignored.
   */
  updateEvent(
    target: PlacedEvent,
    draft: EventDraft,
    scope?: EditScope,
    sendInvitations?: boolean,
  ): Promise<void>
  /**
   * Changes ONE occurrence of a series, by rewriting the master's `recurrenceOverrides`.
   *
   * **The whole map is written, and there is no alternative on this server.** A pointer patch
   * (`"recurrenceOverrides/<rid>": {...}`) is answered `invalidProperties: "Patch operation
   * failed."` — measured on v0.16.18, with `recurrenceRule/count` accepted in the same request as
   * the control. See `event-recurrence.ts` for the probe.
   *
   * The map is therefore RE-READ inside the same JMAP request that writes it, never taken from the
   * copy the screen has been holding. That is the whole mitigation: a `/get` and a `/set` in one
   * batch run in order on the server, so the window in which another client's override could be
   * overwritten is the width of one request rather than the lifetime of a dialog.
   */
  updateOccurrence(target: PlacedEvent, draft: EventDraft): Promise<void>
  /** Removes ONE occurrence from a series (`recurrenceOverrides[<rid>] = {excluded: true}`). */
  excludeOccurrence(target: PlacedEvent): Promise<void>
  /**
   * Answers an invitation: `"participants/<key>/participationStatus"` and nothing else.
   *
   * One pointer, one field. Writing the whole `participants` map to change one word would re-send
   * every other participant as this client understood them, silently dropping a delegate or a role
   * it does not model. Measured `updated` on v0.16.18, with the participant's name, roles and
   * `expectReply` intact afterwards.
   */
  rsvp(target: PlacedEvent, participantKey: string, status: ParticipationStatus): Promise<void>
  /**
   * The calendar addresses this account may act as (K-10).
   *
   * Read only, and that is measured: a `create` naming an address the account does not own is
   * refused, `isDefault` cannot be written at all, and `/changes` cannot answer. The one thing this
   * list is for is deciding which participant on an event is the reader, which is what gates the
   * RSVP bar.
   */
  listParticipantIdentities(): Promise<ParticipantIdentity[]>
  /** Uploads a `.ics` and asks the SERVER to read it. Every event in it, not just the first. */
  parseIcs(file: Blob): Promise<ImportCandidate[]>
  /** Creates the chosen events. A `uid` already in the account is a skip, not a failure. */
  importEvents(candidates: readonly ImportCandidate[], calendarId: Id): Promise<ImportOutcome>
  /**
   * Deletes the object behind `target` and returns a **complete copy of what was deleted**, so the
   * caller can offer Undo. `null` when the copy could not be taken — the delete still happened, and
   * a caller holding `null` must not promise a way back.
   */
  destroyEvent(target: PlacedEvent): Promise<CalendarEvent | null>
  /** Re-creates an event from a copy taken by {@link CalendarClient.destroyEvent}. */
  restoreEvent(snapshot: CalendarEvent): Promise<void>
  /**
   * Everyone this account may ask an availability question about (S-6).
   *
   * The whole organisation, and that is measured rather than assumed: `Principal/get {ids: null}`
   * as any user lists every user, with **no share of any kind in place**. So this is a directory,
   * not a list of people who have let the reader see something.
   */
  listPrincipals(): Promise<Principal[]>
  /**
   * When one principal is busy in `[from, to)` — times, never titles (S-6).
   *
   * `null` rather than an empty list when the server cannot answer, and the difference is the whole
   * point: `[]` means "free all week" and would be drawn as an empty column, which is a statement.
   * A server without the method, a principal who has hidden their availability, a network failure —
   * all of those are "no answer", and the layer is simply not drawn.
   */
  getAvailability(principalId: Id, from: Date, to: Date): Promise<AvailabilityPeriod[] | null>
}

/**
 * Does this event belong to a repeating series?
 *
 * **This used to be `isEditable`, and the rename is the whole of K-2.** Until a scope editor
 * existed, "repeats" and "cannot be touched" were the same sentence and one function said both.
 * They are not the same sentence any more: a series IS editable, it just needs the reader to say
 * whether a change means this occurrence or all of them. Keeping the old name would have left the
 * refusal reading as a fact about the event rather than a decision of this client.
 *
 * An expanded instance is recognisable by its `recurrenceId`; a master by its `recurrenceRule`.
 */
export function isSeriesEvent(event: CalendarEvent): boolean {
  if (event.recurrenceId !== undefined) return true
  return isSeriesMaster(event)
}

/**
 * Does this stored object carry a repetition rule?
 *
 * **Both spellings are recognised, and only one is asked for.** `recurrenceRule` (singular, one
 * object) is `jscalendarbis` and is what this server answers; `recurrenceRules` (plural, an array)
 * is RFC 8984 and is what the client used to ask for and never get. The plural branch is kept
 * because treating a series as a series is the safe direction and a server that volunteers the old
 * spelling should not have its series handed to an editor that writes a single event — but it is
 * deliberately NOT in the property lists, because asking a `jscalendarbis` server for it is how
 * this bug started. An empty array is not a series.
 */
function isSeriesMaster(event: CalendarEvent): boolean {
  const rule: unknown = event.recurrenceRule
  if (typeof rule === 'object' && rule !== null) return true
  const legacy: unknown = event.recurrenceRules
  return Array.isArray(legacy) && legacy.length > 0
}

/** Why an occurrence cannot be edited, or `null` when it can. */
export type EditRefusal = 'unresolved'

/**
 * The one question the screen asks before opening the editor.
 *
 * **One refusal left, and it is the honest one.** `unresolved` says the server handed back an
 * occurrence this client cannot trace to a writable object — rare, but the alternative is an editor
 * whose Save is certain to fail, which is precisely the state T1 left the whole calendar in.
 *
 * The other refusal, `series`, is gone: a repeating event no longer turns the editor back, it
 * raises the scope question after Save instead ({@link needsScope}). That is the change K-2 exists
 * to make, and the reason it took an ADR to get here is that the failure mode of getting it wrong —
 * a single-event patch landing on a repeating meeting — costs other people's time.
 */
export function refuseEdit(placed: PlacedEvent): EditRefusal | null {
  return placed.writeId === null ? 'unresolved' : null
}

/**
 * Does saving this occurrence need the reader to choose a scope?
 *
 * Asked of the PLACED event rather than the raw one, so the master's own answer (`series`, resolved
 * from the identity index or from `baseEventId`) counts as well as the occurrence's `recurrenceId`.
 * An occurrence whose master lies outside the fetched window carries `recurrenceId` and is caught
 * by the second half.
 */
export function needsScope(placed: PlacedEvent): boolean {
  return placed.series || isSeriesEvent(placed.event)
}

/**
 * The JSCalendar patch an {@link EventDraft} describes.
 *
 * `stored` is the event being edited, where there is one. It is read for exactly one thing: a
 * repetition rule this editor has no control for, which `ruleToWrite` carries through rather than
 * flattening into the nearest preset it does know.
 */
export function draftToEvent(
  draft: EventDraft,
  stored?: CalendarEvent | null,
): Record<string, unknown> {
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
    /*
     * `alerts` is here ONLY when the draft carries them, and that condition is the whole of K-5.
     *
     * Spread rather than assigned, so a draft that says nothing about reminders leaves the property
     * out of the patch entirely and the server keeps what it has. Written unconditionally — even as
     * `alerts: draft.alerts ?? null` — every save from a caller that does not model them would
     * silently delete every alarm on the event, which is the exact failure this editor spent its
     * first year avoiding by not naming the property at all.
     */
    ...(draft.alerts === undefined ? {} : { alerts: alertsToPatch(draft.alerts) }),
    /*
     * `recurrenceRule` (K-2) follows exactly the same rule, and it matters more here than it did
     * for alerts: a caller that says nothing about repetition and gets `recurrenceRule: null`
     * written for it has just turned a weekly meeting into a single appointment, silently, while
     * saving a title.
     *
     * `stored` is passed so a rule this editor cannot name (`custom` — a `byDay`, a `bySetPosition`)
     * survives an unrelated edit intact. See `ruleToWrite`.
     */
    ...(draft.repeat === undefined
      ? {}
      : {
          recurrenceRule: ruleToWrite(
            draft.repeat.preset,
            draft.repeat.end,
            stored?.recurrenceRule,
          ),
        }),
    /*
     * `participants` (K-3), same rule again. An EMPTY list is the reader having removed the last
     * one and writes `null`; `undefined` keeps the property out of the patch entirely.
     *
     * `organizerCalendarAddress` rides along only when there is somebody to organise, because
     * naming an organiser on an event with no participants is a claim the server did not ask for.
     */
    ...(draft.participants === undefined
      ? {}
      : {
          participants:
            draft.participants.length === 0 ? null : participantsToPatch(draft.participants),
          ...(draft.participants.length === 0 || draft.organizerCalendarAddress === undefined
            ? {}
            : { organizerCalendarAddress: draft.organizerCalendarAddress }),
        }),
    /*
     * Note what is still NOT here: `locations`.
     *
     * On an update this object is a JMAP PATCH (RFC 8620 §5.3) — every property it does not name is
     * left exactly as it was. That is what keeps a location the editor cannot yet EDIT (T11) from
     * being destroyed by saving a title change. `calendar-write.test.ts` pins it, because the day
     * someone "tidies" this into a full object is the day that field goes.
     */
  }
}

/**
 * The `filter` both halves of the range query carry.
 *
 * **`inCalendar`, singular, one id per condition — not the draft's `inCalendars`.** Measured
 * against Stalwart v0.16.18: `inCalendars: ["g"]` is answered `{"type":"unsupportedFilter"}` as a
 * METHOD-level error, which fails the whole query and takes the month down with it; so do
 * `calendarIds` and `calendarId`. Only `inCalendar: "g"` works, and it works with
 * `expandRecurrences: true` and inside a `FilterOperator`, both measured.
 *
 * So more than one calendar is an `OR` of single-calendar conditions, `AND`ed with the window. One
 * calendar gets the same shape rather than a flattened condition: a single code path is one thing
 * to be right about, and the `OR`-of-one was measured working too.
 */
export function calendarFilter(
  from: Date,
  to: Date,
  calendarIds?: readonly Id[],
): CalendarEventFilter {
  // Deliberately un-annotated. `CalendarEventFilterCondition` is an interface, and an interface has
  // no implicit index signature, so annotating it here makes it unassignable to the core
  // `FilterCondition` (`Record<string, unknown>`) that a `FilterOperator`'s conditions are typed as.
  // An inferred object literal type does have one.
  const window = { after: from.toISOString(), before: to.toISOString() }
  if (calendarIds === undefined || calendarIds.length === 0) return window
  return {
    operator: 'AND',
    conditions: [
      window,
      { operator: 'OR', conditions: calendarIds.map((id) => ({ inCalendar: id })) },
    ],
  }
}

/**
 * Everything {@link eventSignature} reads.
 *
 * Named once and spread into BOTH property lists below, because the join only works while the two
 * queries are asked for the same fields: a property that is not requested comes back absent, and
 * two events both "missing" a title would then look alike to a signature built from one side only.
 */
const SIGNATURE_PROPERTIES = ['calendarIds', 'title', 'start', 'duration', 'showWithoutTime']

/** The properties the views actually read — a whole JSCalendar event is far larger. */
const EVENT_PROPERTIES = [
  'id',
  ...SIGNATURE_PROPERTIES,
  'description',
  'timeZone',
  'status',
  'locations',
  'participants',
  'recurrenceId',
  // K-5: asked for at last. `alerts` was in NO property list this client sent, so an alarm set on a
  // phone was invisible here — the editor could not show it, and only the fact that `draftToEvent`
  // is a patch kept a title change from being the moment it disappeared.
  'alerts',
  // Asked for although no view draws it: `isSeriesEvent` tests it, and a property that is never
  // fetched always reads as absent — so the master of a series looked like a plain event. It read
  // as absent for a second reason too, until ADR-025: the name is SINGULAR on this server, and the
  // plural RFC 8984 spelling this line used to carry was never going to come back.
  'recurrenceRule',
  // The server's own answer to "which stored event is this an instance of". Only present on a
  // synthetic id, which is exactly when it is needed — see `resolveIdentity`.
  'baseEventId',
  'isDraft',
]

/** What the unexpanded companion query needs, and nothing else — it is asked purely for identity. */
const IDENTITY_PROPERTIES = ['id', ...SIGNATURE_PROPERTIES, 'recurrenceRule']

/**
 * What a `Calendar/get` has to name to get a complete calendar.
 *
 * **The list exists because a bare `Calendar/get` is not a complete answer.** Measured: with no
 * `properties` at all Stalwart returns `id, name, description, color, timeZone, sortOrder,
 * isDefault, isSubscribed, myRights` — and silently omits `isVisible`, `shareWith`,
 * `includeInAvailability` and both `defaultAlerts*` maps. A client that adds them to its type and
 * leaves the request alone reads `undefined` for all five and concludes the server cannot do them.
 */
const CALENDAR_PROPERTIES = [
  'id',
  'name',
  'description',
  'color',
  'timeZone',
  'sortOrder',
  'isDefault',
  'isSubscribed',
  'myRights',
  // Everything from here down is omitted unless named. `isVisible` is the load-bearing one: only
  // `false` means hidden (see `Calendar.isVisible`), so a missing property is not "invisible".
  'isVisible',
  'includeInAvailability',
  'defaultAlertsWithTime',
  'defaultAlertsWithoutTime',
  'shareWith',
]

/**
 * Server-owned properties, dropped when an event is re-created from a snapshot.
 *
 * `uid` is deliberately NOT in this list. This server does not send one (see the note at the top),
 * but a snapshot is whatever the server handed back, and on a server that does send one, restoring
 * an event is meant to bring back THAT event — to a CalDAV client on the other side of the same
 * account the uid is what says so.
 *
 * `method` IS in it, and that one is not a judgement call — it is measured. Stalwart answers
 * `{"type":"invalidProperties","description":"This property is immutable.","properties":["method"]}`
 * to a `method` in **create** as well as in update (probed against v0.16.18 on 2026-08-21; the
 * update half was already known, the create half is what makes it matter here). A scheduling
 * event — one that arrived by iMIP and therefore carries `method` — would otherwise snapshot
 * fine, delete fine, and fail to come back: Undo offered and Undo refused, which is the one
 * outcome a delete-with-Undo may never produce.
 */
const SERVER_OWNED = ['id', 'created', 'updated', 'isOrigin', 'baseEventId', 'method']

/** Places one event on the timeline. */
export function placeEvent(
  event: CalendarEvent,
  identity: EventIdentity = UNRESOLVED,
): PlacedEvent {
  const allDay = event.showWithoutTime === true
  const startsAt = localToInstant(event.start, allDay ? null : event.timeZone)
  const endsAt =
    startsAt === null
      ? null
      : startsAt +
        (allDay && event.duration === undefined ? 86_400_000 : durationToMs(event.duration))
  return { event, writeId: identity.writeId, series: identity.series, startsAt, endsAt, allDay }
}

/**
 * The fields an expanded occurrence and the stored object behind it demonstrably share.
 *
 * Measured against the fixture rather than derived from the spec: asked for an occurrence of a
 * non-repeating event, the server answered with the stored event's record and a synthetic `id` in
 * place of the real one — every other property equal. These five are that set, minus `timeZone`,
 * which is NOT equal, and minus everything the identity query does not fetch. See the note at the
 * top of the file for why `uid` is not the join key it ought to be.
 *
 * Encoded as JSON rather than joined with a separator, so a title that contains the separator
 * cannot forge another event's signature. `calendarIds` is a SET in JSCalendar and its key order is
 * not promised, so it is sorted. An absent field and an empty one both read as `''`, which can only
 * ever make the join LESS certain — a false collision costs an edit, a false match costs the wrong
 * event.
 */
export function eventSignature(event: CalendarEvent): string {
  const members: unknown = event.calendarIds
  const calendars =
    typeof members === 'object' && members !== null
      ? Object.entries(members as Record<string, unknown>)
          .filter(([, member]) => member === true)
          .map(([id]) => id)
          .sort()
      : []
  return JSON.stringify([
    typeof event.start === 'string' ? event.start : '',
    typeof event.duration === 'string' ? event.duration : '',
    typeof event.title === 'string' ? event.title : '',
    calendars,
    event.showWithoutTime === true,
  ])
}

/** One stored object, as the identity index remembers it. */
interface StoredObject {
  readonly id: Id
  readonly series: boolean
}

/** What the unexpanded query taught us about the objects in this window. */
export interface IdentityIndex {
  /**
   * Signature → the single object carrying it, or `null` where more than one does.
   *
   * `null` is not the same as absent, and the difference is load-bearing: it RECORDS that the
   * signature is ambiguous, so a second object cannot quietly overwrite the first and win a
   * collision it should have lost.
   */
  readonly bySignature: ReadonlyMap<string, StoredObject | null>
  /** Every id the unexpanded query named — a server that does not synthesise needs no join. */
  readonly byId: ReadonlyMap<Id, { readonly series: boolean }>
}

const EMPTY_INDEX: IdentityIndex = { bySignature: new Map(), byId: new Map() }

/** Builds the index from the unexpanded query's answer. */
export function indexObjects(objects: readonly CalendarEvent[]): IdentityIndex {
  const bySignature = new Map<string, StoredObject | null>()
  const byId = new Map<Id, { series: boolean }>()
  for (const object of objects) {
    const series = isSeriesMaster(object)
    byId.set(object.id, { series })
    const signature = eventSignature(object)
    // A second object with the same signature POISONS the entry rather than replacing it: two
    // events nothing distinguishes cannot be told apart, and picking either one means editing an
    // event the reader did not open.
    bySignature.set(signature, bySignature.has(signature) ? null : { id: object.id, series })
  }
  return { bySignature, byId }
}

/**
 * Resolves one displayed occurrence to the object behind it.
 *
 * Four ways, in order of certainty:
 *
 * 1. The occurrence carries `baseEventId`, and the server has therefore NAMED its master. Nothing
 *    is inferred, nothing is compared, and the index is not consulted at all — which is the point:
 *    it resolves an occurrence the signature cannot, such as the second week of a series, where
 *    `start` has moved away from the master's.
 * 2. The id is itself an object id. A server that does not synthesise ids when expanding — which
 *    the spec permits — needs no mapping at all, and this keeps such a server working unchanged.
 * 3. Exactly one object in the same window carries the same {@link eventSignature}. This is what
 *    carried the whole feature before `baseEventId` was asked for, and it is the reason a whole
 *    month is still fetched both ways: it is the fallback for a server that omits it.
 * 4. None of those, or an ambiguous signature: `writeId` stays `null` and the screen says so,
 *    rather than offering a doomed editor or — far worse — writing the wrong event's id.
 *
 * `series` is taken from the MASTER wherever one was found, not from the occurrence alone: an
 * expanded instance is supposed to carry `recurrenceId`, and a client that believes only the
 * instance is one server quirk away from offering to edit a series in place. Note what `series`
 * is NOT taken from: `baseEventId` itself. Stalwart puts it on every expanded event, repeating or
 * not, so reading it as "this is a series" would make every single event in the month read-only.
 */
export function resolveIdentity(event: CalendarEvent, index: IdentityIndex): EventIdentity {
  const occurrence = event.recurrenceId !== undefined

  const base: unknown = event.baseEventId
  if (typeof base === 'string' && base !== '') {
    // The index is consulted only for the series flag, and only if it happens to hold the master.
    // The write id does not depend on it — an occurrence whose master lies outside the fetched
    // window still resolves, which is precisely what the signature join could never do.
    return { writeId: base, series: (index.byId.get(base)?.series ?? false) || occurrence }
  }

  const own = index.byId.get(event.id)
  if (own !== undefined) return { writeId: event.id, series: own.series || occurrence }

  const master = index.bySignature.get(eventSignature(event))
  // `undefined` is "no such signature", `null` is "more than one". Both mean: do not write.
  if (master === undefined || master === null) return { writeId: null, series: occurrence }
  return { writeId: master.id, series: master.series || occurrence }
}

export function makeCalendarClient(client: JmapClient, accountId: Id): CalendarClient {
  /** The id a write may address, or a refusal that never reaches the wire. */
  const writeIdOf = (target: PlacedEvent): Id => {
    if (target.writeId === null) {
      // Unreachable through the UI — `refuseEdit` gates every path that leads here — and thrown
      // rather than quietly skipped, so a future call site cannot resurrect T1 in silence.
      throw new Error('This occurrence has no writable event id')
    }
    return target.writeId
  }

  return {
    async listCalendars() {
      const responses = await client.call([
        // `properties` is named, and that is not tidiness: without it the answer silently lacks
        // `isVisible` and the four other opt-in properties. See CALENDAR_PROPERTIES.
        [Methods.calendarGet.name, { accountId, ids: null, properties: CALENDAR_PROPERTIES }, 'c0'],
      ])
      return responses.get<{ list: Calendar[] }>('c0').list
    },

    async createCalendar(draft) {
      const responses = await client.call([
        [
          Methods.calendarSet.name,
          {
            accountId,
            create: {
              // `isVisible` and `isSubscribed` are stated rather than left to the server. Measured:
              // a calendar created without them comes back `isSubscribed: false`, which is the
              // server saying "made, but not one the user asked to see" — and it would be missing
              // from the phone's calendar app the moment it was made here.
              //
              // What is deliberately NOT sent: `participantIdentities` (measured
              // `invalidProperties`, which would fail the whole create) and `isDefault` (measured
              // "Field could not be set." in create AND update — on this server the default
              // calendar is the DAV collection literally named `default`, so JMAP cannot make one).
              k: { name: draft.name, color: draft.color, isVisible: true, isSubscribed: true },
            },
          },
          'c0',
        ],
      ])
      throwIfRefused(responses.get<SetOutcome>('c0'))
    },

    async updateCalendar(id, patch) {
      const responses = await client.call([
        [Methods.calendarSet.name, { accountId, update: { [id]: { ...patch } } }, 'c0'],
      ])
      throwIfRefused(responses.get<SetOutcome>('c0'))
    },

    async destroyCalendar(id) {
      const responses = await client.call([
        [
          Methods.calendarSet.name,
          // See `CalendarClient.destroyCalendar`: without the flag a non-empty calendar is refused.
          { accountId, destroy: [id], onDestroyRemoveEvents: true },
          'c0',
        ],
      ])
      throwIfRefused(responses.get<SetOutcome>('c0'))
    },

    async countEvents(calendarId) {
      const responses = await client.call([
        [
          Methods.calendarEventQuery.name,
          // `limit: 1` and `calculateTotal`, so the answer is a number and not a list of every id
          // in the calendar. NOT expanded: the confirmation counts stored events, and expanding a
          // weekly meeting into "417 events" would be a frightening answer to the wrong question.
          { accountId, filter: { inCalendar: calendarId }, limit: 1, calculateTotal: true },
          'c0',
        ],
      ])
      const answer = responses.get<{ total?: number; ids?: Id[] }>('c0')
      return answer.total ?? answer.ids?.length ?? 0
    },

    async eventsInRange(from, to, calendarIds) {
      // Nothing is shown, so nothing is asked for. Sending a filter that names no calendar would
      // ask for EVERYTHING (see `calendarFilter`), which is the opposite of what the caller meant.
      if (calendarIds !== undefined && calendarIds.length === 0) return []

      const builder = client.request()
      const filter = calendarFilter(from, to, calendarIds)

      // What the grid draws: one entry per occurrence. See the note at the top — the server owns
      // recurrence expansion, and the ids it answers with are display ids.
      const occurrenceQuery = builder.invoke(Methods.calendarEventQuery, {
        accountId,
        filter,
        expandRecurrences: true,
      })
      const occurrences = builder.invoke(Methods.calendarEventGet, {
        accountId,
        '#ids': occurrenceQuery.ref('/ids'),
        properties: EVENT_PROPERTIES,
      })
      // What a write may address: the same window WITHOUT expansion, which is the query whose ids
      // are real. Two more calls inside the same request, so it stays one round trip.
      const objectQuery = builder.invoke(Methods.calendarEventQuery, { accountId, filter })
      const objects = builder.invoke(Methods.calendarEventGet, {
        accountId,
        '#ids': objectQuery.ref('/ids'),
        properties: IDENTITY_PROPERTIES,
      })
      const responses = await builder.send()

      /*
       * Identity is a nice-to-have for READING, so a server that refuses the companion query must
       * not take the month down with it. Without it every event reads as unresolved: still drawn,
       * still legible, only not editable — and the screen says which, instead of failing on save.
       */
      let index = EMPTY_INDEX
      try {
        index = indexObjects(responses.get(objects).list)
      } catch {
        index = EMPTY_INDEX
      }

      return (
        responses
          .get(occurrences)
          .list.map((event: CalendarEvent) => placeEvent(event, resolveIdentity(event, index)))
          // An event whose start could not be read is dropped rather than sorted to 1970, where it
          // would appear at the top of every view for ever.
          .filter((placed: PlacedEvent) => placed.startsAt !== null)
          .sort((a: PlacedEvent, b: PlacedEvent) => (a.startsAt as number) - (b.startsAt as number))
      )
    },

    async createEvent(draft, sendInvitations = false) {
      const responses = await client.call([
        [
          Methods.calendarEventSet.name,
          {
            accountId,
            create: { e: draftToEvent(draft) },
            // The flag is spread rather than set to `false`, so an ordinary create is byte for byte
            // the request it always was. See `CalendarClient.createEvent` for why it is a parameter.
            ...(sendInvitations ? { sendSchedulingMessages: true } : {}),
          },
          'c0',
        ],
      ])
      throwIfRefused(responses.get<SetOutcome>('c0'))
    },

    async updateEvent(target, draft, scope = 'all', sendInvitations = false) {
      // The scope question only exists for a series. Routed here rather than at the call site so a
      // caller that forgets the parameter writes the master — which is what every caller did before
      // K-2 and is the right answer for the events they were writing.
      if (scope === 'occurrence' && needsScope(target)) {
        await this.updateOccurrence(target, draft)
        return
      }
      const id = writeIdOf(target)
      const responses = await client.call([
        [
          Methods.calendarEventSet.name,
          {
            accountId,
            update: { [id]: draftToEvent(draft, target.event) },
            ...(sendInvitations ? { sendSchedulingMessages: true } : {}),
          },
          'c0',
        ],
      ])
      throwIfRefused(responses.get<SetOutcome>('c0'))
    },

    async updateOccurrence(target, draft) {
      const id = writeIdOf(target)
      const builder = client.request()
      /*
       * The master is re-read HERE, inside the request that writes it — not taken from
       * `target.event`, which is whatever the month view fetched when it last loaded.
       *
       * That is the entire mitigation for writing the whole map (see `event-recurrence.ts`: a
       * pointer patch into `recurrenceOverrides` is refused by this server, measured). A JMAP batch
       * runs in order on the server, so nothing can land between the `/get` and the `/set`. Reading
       * from the screen's copy instead would widen that window to however long the dialog was open,
       * and the cost of losing the race is another client's override silently deleted.
       */
      const before = builder.invoke(Methods.calendarEventGet, {
        accountId,
        ids: [id],
        properties: [
          'id',
          'recurrenceOverrides',
          ...SIGNATURE_PROPERTIES,
          'description',
          'timeZone',
          'alerts',
        ],
      })
      const responses = await builder.send()
      const master = responses.get(before).list[0]
      if (master === undefined) throw new CalendarSetError('notFound', null)

      const key = overrideKeyFor(master, target.event)
      if (key === null) {
        // No `recurrenceId` — this is not an occurrence, and inventing a key would store a ghost.
        // Thrown rather than silently promoted to a whole-series write: "this one" must never
        // quietly become "all of them".
        throw new CalendarSetError('invalidArguments', 'This event has no occurrence to override.')
      }
      const overrides = mergeOverride(
        master,
        key,
        overrideFromDraft(master, draftToEvent(draft, master)),
      )
      const write = await client.call([
        [
          Methods.calendarEventSet.name,
          { accountId, update: { [id]: { recurrenceOverrides: overrides } } },
          'c0',
        ],
      ])
      throwIfRefused(write.get<SetOutcome>('c0'))
    },

    async excludeOccurrence(target) {
      const id = writeIdOf(target)
      const builder = client.request()
      const before = builder.invoke(Methods.calendarEventGet, {
        accountId,
        ids: [id],
        properties: ['id', 'recurrenceOverrides'],
      })
      const responses = await builder.send()
      const master = responses.get(before).list[0]
      if (master === undefined) throw new CalendarSetError('notFound', null)
      const key = overrideKeyFor(master, target.event)
      if (key === null) {
        throw new CalendarSetError('invalidArguments', 'This event has no occurrence to override.')
      }
      const write = await client.call([
        [
          Methods.calendarEventSet.name,
          { accountId, update: { [id]: { recurrenceOverrides: excludeOverride(master, key) } } },
          'c0',
        ],
      ])
      throwIfRefused(write.get<SetOutcome>('c0'))
    },

    async rsvp(target, participantKey, status) {
      const id = writeIdOf(target)
      const responses = await client.call([
        [
          Methods.calendarEventSet.name,
          // ONE pointer, ONE field. See `CalendarClient.rsvp`.
          { accountId, update: { [id]: rsvpPatch(participantKey, status) } },
          'c0',
        ],
      ])
      throwIfRefused(responses.get<SetOutcome>('c0'))
    },

    async listParticipantIdentities() {
      const responses = await client.call([
        [Methods.participantIdentityGet.name, { accountId, ids: null }, 'c0'],
      ])
      return responses.get<{ list: ParticipantIdentity[] }>('c0').list
    },

    async parseIcs(file) {
      // The type is stated rather than taken from the `File`: a `.ics` picked on a machine with no
      // registered handler arrives with `type: ''`, and a blob uploaded as
      // `application/octet-stream` is one `CalendarEvent/parse` has no reason to read.
      const blob = await client.upload(accountId, file, { type: 'text/calendar' })
      const responses = await client.call([
        [Methods.calendarEventParse.name, { accountId, blobIds: [blob.blobId] }, 'c0'],
      ])
      const answer = responses.get<{ parsed?: Record<string, unknown> | null }>('c0')
      // Indexed by the blob id we just sent rather than by "the first key", so a server that echoes
      // something extra cannot make us parse the wrong entry.
      return candidatesFrom(answer.parsed?.[blob.blobId])
    },

    async importEvents(candidates, calendarId) {
      if (candidates.length === 0) return { added: 0, duplicates: 0, failed: 0, reason: null }
      const responses = await client.call([
        [
          Methods.calendarEventSet.name,
          { accountId, create: createsFor(candidates, calendarId) },
          'c0',
        ],
      ])
      // NOT `throwIfRefused`: a `uid` already in the account is the expected answer to importing the
      // same file twice, and turning that into a thrown error would report a working importer as
      // broken. The counts go back to the screen, which says what happened.
      return outcomeFrom(
        responses.get<{
          created?: Record<string, unknown> | null
          notCreated?: Record<
            string,
            { type: string; description?: string | null; properties?: string[] | null }
          > | null
        }>('c0'),
      )
    },

    async destroyEvent(target) {
      const id = writeIdOf(target)
      const builder = client.request()
      /*
       * The copy is taken in the SAME request and BEFORE the destroy — JMAP runs a batch in order —
       * so there is no window in which the event is gone and the copy was never made. `properties`
       * is left unset, meaning every property including the ones no view asks for: an Undo that
       * came back without the alerts, the recurrence rules or the attendees would be a second data
       * loss dressed up as a rescue.
       */
      const snapshot = builder.invoke(Methods.calendarEventGet, { accountId, ids: [id] })
      const destroy = builder.invoke(Methods.calendarEventSet, { accountId, destroy: [id] })
      const responses = await builder.send()
      throwIfRefused(responses.get(destroy) as SetOutcome)

      try {
        return responses.get(snapshot).list[0] ?? null
      } catch {
        // The delete succeeded and only the copy did not. Say "no Undo", never "no delete".
        return null
      }
    },

    async restoreEvent(snapshot) {
      const create: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(snapshot)) {
        if (!SERVER_OWNED.includes(key)) create[key] = value
      }
      const responses = await client.call([
        [Methods.calendarEventSet.name, { accountId, create: { e: create } }, 'c0'],
      ])
      throwIfRefused(responses.get<SetOutcome>('c0'))
    },

    async listPrincipals() {
      // The empty query is "everyone" — `principalSearchFilter` answers `null` for it, and the
      // directory is small enough that a picker listing it whole is the right shape. `null` for
      // `selfPrincipalId` on purpose: asking about your OWN availability is a legitimate thing to
      // do here (it is not a share, so there is nothing odd about naming yourself).
      return await searchPrincipals(client, accountId, '')
    },

    async getAvailability(principalId, from, to) {
      /*
       * The `using` set, and the one thing in this file that could take a whole batch down.
       *
       * `capabilityForMethod` maps by PREFIX, so `Principal/getAvailability` derives
       * `urn:ietf:params:jmap:principals` — not the `...:principals:availability` the RFC assigns
       * it. There is no per-method override table in `@waxwing/jmap`, deliberately (see
       * `Capabilities.principalsAvailability`): one would send the URN unconditionally, and a
       * `using` entry the server does not know answers the WHOLE request with HTTP 400
       * `notRequest` — no method responses at all, every sibling call destroyed.
       *
       * So it is opted into per call and ONLY when the session has been seen to advertise it. On
       * Stalwart it is advertised, so the correct URN goes out; on a server that does not implement
       * the extension nothing extra goes out and the worst case is one method failing rather than
       * the batch. What is NOT measured is whether this server would answer without the URN — the
       * probe that established the method sent all sixteen session URNs at once.
       */
      const advertised = hasCapability(
        client.session,
        Capabilities.principalsAvailability,
        accountId,
      )
      try {
        const responses = await client.call(
          [
            [
              Methods.principalGetAvailability.name,
              {
                accountId,
                id: principalId,
                utcStart: from.toISOString(),
                utcEnd: to.toISOString(),
              },
              'p0',
            ],
          ],
          advertised ? { using: [Capabilities.principalsAvailability] } : {},
        )
        return responses.get<{ list: AvailabilityPeriod[] }>('p0').list
      } catch {
        // `null`, never `[]` — see the interface. "No answer" and "free all week" are different
        // statements and only one of them may be drawn.
        return null
      }
    },
  }
}

/** The refusal maps a `/set` can carry. */
interface SetOutcome {
  notCreated?: Record<string, { type: string; description?: string | null }> | null
  notUpdated?: Record<string, { type: string; description?: string | null }> | null
  notDestroyed?: Record<string, { type: string; description?: string | null }> | null
}

/**
 * A per-object refusal the UI can report.
 *
 * `description` is a FIELD as well as the message, because the screen shows the two halves in two
 * places: its own sentence about which operation failed, and the server's own words underneath.
 * Before this the server's reason ("Deleting synthetic ids is not yet supported.") reached the
 * client and was dropped on the floor — not shown, not logged (T7).
 */
export class CalendarSetError extends Error {
  readonly description: string | null

  constructor(
    readonly type: string,
    description?: string | null,
  ) {
    super(description ?? type)
    this.name = 'CalendarSetError'
    this.description = description ?? null
  }
}

/** The server's own words about a refusal, for showing under the app's sentence. `null` if none. */
export function refusalReason(error: unknown): string | null {
  if (!(error instanceof CalendarSetError)) return null
  return error.description ?? error.type
}

function throwIfRefused(response: SetOutcome): void {
  for (const group of [response.notCreated, response.notUpdated, response.notDestroyed]) {
    const first = Object.values(group ?? {})[0]
    if (first !== undefined) throw new CalendarSetError(first.type, first.description)
  }
}

/**
 * May this account create a calendar?
 *
 * Read from the account's own `urn:ietf:params:jmap:calendars` capability
 * (`mayCreateCalendar`, measured `true` on the fixture), not assumed from the presence of the
 * capability: a shared or read-only calendar account grants the URN and refuses the create, and a
 * `+` that always fails is worse than no `+`. A server that omits the flag is taken at its word —
 * absent means no, because a refused create is a dead end and a missing button is not.
 */
export function mayCreateCalendar(session: JmapSession | null, accountId: string | null): boolean {
  if (session === null || accountId === null) return false
  const account = session.accounts?.[accountId]?.accountCapabilities?.[Capabilities.calendars]
  return (account as { mayCreateCalendar?: boolean } | undefined)?.mayCreateCalendar === true
}

/** Does this server offer calendars for this account? */
export function serverSupportsCalendars(
  session: JmapSession | null,
  accountId: string | null,
): boolean {
  if (session === null || accountId === null) return false
  return hasCapability(session, Capabilities.calendars, accountId)
}
