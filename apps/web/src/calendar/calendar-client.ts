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

import type { Calendar, CalendarEvent, Id, JmapClient } from '@waxwing/jmap'
import { Capabilities, hasCapability, Methods } from '@waxwing/jmap'
import type { JmapSession } from '../app/session/types'
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
}

export interface CalendarClient {
  listCalendars(): Promise<Calendar[]>
  /** Events overlapping `[from, to)`, recurrences expanded, ordered by start. */
  eventsInRange(from: Date, to: Date, calendarIds?: readonly Id[]): Promise<PlacedEvent[]>
  createEvent(draft: EventDraft): Promise<void>
  /**
   * Writes the draft onto the object behind `target`.
   *
   * Takes the placed occurrence rather than an id, and that is not decoration: an `id` parameter is
   * exactly what let a display id reach the wire (T1). With the occurrence in hand, the call site
   * cannot pass the wrong one — there is only one id on it that a write may use.
   */
  updateEvent(target: PlacedEvent, draft: EventDraft): Promise<void>
  /**
   * Deletes the object behind `target` and returns a **complete copy of what was deleted**, so the
   * caller can offer Undo. `null` when the copy could not be taken — the delete still happened, and
   * a caller holding `null` must not promise a way back.
   */
  destroyEvent(target: PlacedEvent): Promise<CalendarEvent | null>
  /** Re-creates an event from a copy taken by {@link CalendarClient.destroyEvent}. */
  restoreEvent(snapshot: CalendarEvent): Promise<void>
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
 * An expanded instance is recognisable by its `recurrenceId`; a master by its `recurrenceRule`.
 */
export function isEditable(event: CalendarEvent): boolean {
  if (event.recurrenceId !== undefined) return false
  return !isSeriesMaster(event)
}

/**
 * Does this stored object carry a repetition rule?
 *
 * **Both spellings are refused, and only one is asked for.** `recurrenceRule` (singular, one
 * object) is `jscalendarbis` and is what this server answers; `recurrenceRules` (plural, an array)
 * is RFC 8984 and is what the client used to ask for and never get. The plural branch is kept
 * because refusing to edit is the safe direction and a server that volunteers the old spelling
 * should not have its series handed to an editor that cannot write them — but it is deliberately
 * NOT in the property lists, because asking a `jscalendarbis` server for it is how this bug
 * started. An empty array is not a series.
 */
function isSeriesMaster(event: CalendarEvent): boolean {
  const rule: unknown = event.recurrenceRule
  if (typeof rule === 'object' && rule !== null) return true
  const legacy: unknown = event.recurrenceRules
  return Array.isArray(legacy) && legacy.length > 0
}

/** Why an occurrence cannot be edited, or `null` when it can. */
export type EditRefusal = 'series' | 'unresolved'

/**
 * The one question the screen asks before opening the editor.
 *
 * Two refusals, because they need two different sentences. `series` is a deliberate limit we can
 * explain ("this repeats; a series needs a scope editor"). `unresolved` is the honest admission
 * that the server handed back an occurrence we cannot trace to a writable object — rare, but the
 * alternative is an editor whose Save is certain to fail, which is precisely the state T1 left the
 * whole calendar in.
 */
export function refuseEdit(placed: PlacedEvent): EditRefusal | null {
  if (placed.series || !isEditable(placed.event)) return 'series'
  if (placed.writeId === null) return 'unresolved'
  return null
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
    /*
     * Note what is NOT here: `locations`, `participants`, `recurrenceRule`, `alerts`.
     *
     * On an update this object is a JMAP PATCH (RFC 8620 §5.3) — every property it does not name is
     * left exactly as it was. That is what keeps a location and an attendee list the editor cannot
     * yet EDIT (T11) from being destroyed by saving a title change. `calendar-write.test.ts` pins
     * it, because the day someone "tidies" this into a full object is the day those fields go.
     */
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
  // Asked for although no view draws it: `isEditable` tests it, and a property that is never
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
 */
const SERVER_OWNED = ['id', 'created', 'updated', 'isOrigin', 'baseEventId']

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

    async eventsInRange(from, to, calendarIds) {
      const builder = client.request()
      const filter = {
        after: from.toISOString(),
        before: to.toISOString(),
        ...(calendarIds === undefined || calendarIds.length === 0
          ? {}
          : { inCalendars: [...calendarIds] }),
      }

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

    async createEvent(draft) {
      const responses = await client.call([
        [Methods.calendarEventSet.name, { accountId, create: { e: draftToEvent(draft) } }, 'c0'],
      ])
      throwIfRefused(responses.get<SetOutcome>('c0'))
    },

    async updateEvent(target, draft) {
      const id = writeIdOf(target)
      const responses = await client.call([
        [Methods.calendarEventSet.name, { accountId, update: { [id]: draftToEvent(draft) } }, 'c0'],
      ])
      throwIfRefused(responses.get<SetOutcome>('c0'))
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

/** Does this server offer calendars for this account? */
export function serverSupportsCalendars(
  session: JmapSession | null,
  accountId: string | null,
): boolean {
  if (session === null || accountId === null) return false
  return hasCapability(session, Capabilities.calendars, accountId)
}
