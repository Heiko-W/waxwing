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
 * once unexpanded, which is what a write may address. The two are joined by `uid` — RFC 8984 gives
 * every event one, and every occurrence of a series shares the master's — and the resulting
 * {@link PlacedEvent.writeId} is the ONLY id this module will write to. An occurrence that cannot
 * be traced back to an object carries `writeId: null` and is shown read-only, rather than being
 * offered an editor whose Save is guaranteed to fail.
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
 * An expanded instance is recognisable by its `recurrenceId`; a master by its `recurrenceRules`.
 */
export function isEditable(event: CalendarEvent): boolean {
  if (event.recurrenceId !== undefined) return false
  const rules = event.recurrenceRules
  return !(Array.isArray(rules) && rules.length > 0)
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
     * Note what is NOT here: `locations`, `participants`, `recurrenceRules`, `alerts`.
     *
     * On an update this object is a JMAP PATCH (RFC 8620 §5.3) — every property it does not name is
     * left exactly as it was. That is what keeps a location and an attendee list the editor cannot
     * yet EDIT (T11) from being destroyed by saving a title change. `calendar-write.test.ts` pins
     * it, because the day someone "tidies" this into a full object is the day those fields go.
     */
  }
}

/** The properties the views actually read — a whole JSCalendar event is far larger. */
const EVENT_PROPERTIES = [
  'id',
  // The join key back to the writable object (see the note at the top). RFC 8984 requires one on
  // every event, and every occurrence of a series carries its master's.
  'uid',
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
  // Asked for although no view draws it: `isEditable` tests it, and a property that is never
  // fetched always reads as absent — so the master of a series looked like a plain event.
  'recurrenceRules',
  'isDraft',
]

/** What the unexpanded companion query needs, and nothing else — it is asked purely for identity. */
const IDENTITY_PROPERTIES = ['id', 'uid', 'recurrenceRules']

/**
 * Server-owned properties, dropped when an event is re-created from a snapshot.
 *
 * `uid` is deliberately NOT in this list: restoring an event is meant to bring back the same event,
 * and to a CalDAV client on the other side of the same account the uid is what says so.
 */
const SERVER_OWNED = ['id', 'created', 'updated', 'isOrigin']

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

/** What the unexpanded query taught us about the objects in this window. */
export interface IdentityIndex {
  readonly byUid: Map<string, { readonly id: Id; readonly series: boolean }>
  readonly byId: Map<Id, { readonly series: boolean }>
}

const EMPTY_INDEX: IdentityIndex = { byUid: new Map(), byId: new Map() }

/** Builds the index from the unexpanded query's answer. */
export function indexObjects(objects: readonly CalendarEvent[]): IdentityIndex {
  const byUid = new Map<string, { id: Id; series: boolean }>()
  const byId = new Map<Id, { series: boolean }>()
  for (const object of objects) {
    const rules = object.recurrenceRules
    const series = Array.isArray(rules) && rules.length > 0
    byId.set(object.id, { series })
    // First writer wins: two objects sharing a uid means a detached override is in the window, and
    // the master is the one the unexpanded query lists first.
    if (typeof object.uid === 'string' && object.uid !== '' && !byUid.has(object.uid)) {
      byUid.set(object.uid, { id: object.id, series })
    }
  }
  return { byUid, byId }
}

/**
 * Resolves one displayed occurrence to the object behind it.
 *
 * Three ways, in order of certainty:
 *
 * 1. The id is itself an object id. A server that does not synthesise ids when expanding — which
 *    the spec permits — needs no mapping at all, and this keeps such a server working unchanged.
 * 2. The `uid` names an object in the same window. This is the Stalwart case.
 * 3. Neither: `writeId` stays `null` and the screen says so, rather than offering a doomed editor.
 *
 * `series` is taken from the MASTER wherever one was found, not from the occurrence alone: an
 * expanded instance is supposed to carry `recurrenceId`, and a client that believes only the
 * instance is one server quirk away from offering to edit a series in place.
 */
export function resolveIdentity(event: CalendarEvent, index: IdentityIndex): EventIdentity {
  const occurrence = event.recurrenceId !== undefined
  const own = index.byId.get(event.id)
  if (own !== undefined) return { writeId: event.id, series: own.series || occurrence }

  const uid = typeof event.uid === 'string' ? event.uid : ''
  const master = uid === '' ? undefined : index.byUid.get(uid)
  if (master === undefined) return { writeId: null, series: occurrence }
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
        [Methods.calendarGet.name, { accountId, ids: null }, 'c0'],
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
