/**
 * The calendar seam on the wire (M5.6/M5.11, FR-CAL-01) — and above all, **which id it writes to**.
 *
 * This file exists because of T1. The month view is fetched with `expandRecurrences: true`, which
 * makes the server answer with one id per OCCURRENCE — `eaaaaa0`, not `0` — and the screen then
 * wrote back with the id it had just read. Stalwart refuses that (`invalidProperties`, "Updating
 * synthetic ids is not yet supported."), so editing and deleting failed for every event in the
 * calendar, including plain single ones that repeat nothing. The same patch addressed to the real
 * id was accepted without complaint: it was never the body, only the id.
 *
 * So the assertions here are about identity rather than about shapes. The load-bearing ones:
 *
 *  - the range query asks the server BOTH ways, in one request;
 *  - a write addresses the id from the unexpanded answer and never the one the grid drew with;
 *  - an occurrence that cannot be traced back to an object is not writable at all, rather than
 *    writable-and-refused;
 *  - and an occurrence that could be traced to TWO objects is not writable either.
 *
 * The join itself is a SIGNATURE and not `uid`, which is the correction this file also pins. The
 * first fix for T1 joined on `uid` and was green here while every event stayed read-only against
 * the real server: measured, Stalwart returns a `uid` only for an event that has one stored, and
 * an event created through this client has none, because `draftToEvent` names none and the server
 * mints none. So the fixtures below carry no `uid` at all — a fixture richer than the server is
 * how a client passes its tests and fails its users.
 *
 * The client is a hand-rolled fake of the `call()`/`request()` seam rather than a real `JmapClient`
 * over a fetch mock: `packages/jmap/src/test-support.ts` is deliberately outside the package's
 * published surface, so app-side tests fake the seam (see `settings/identity-client.test.ts`).
 */

import type { Calendar, CalendarEvent, Invocation, JmapClient } from '@waxwing/jmap'
import { MethodResponses, RequestBuilder } from '@waxwing/jmap'
import { describe, expect, it } from 'vitest'
import {
  CalendarSetError,
  eventSignature,
  indexObjects,
  makeCalendarClient,
  placeEvent,
  refusalReason,
  refuseEdit,
  resolveIdentity,
} from './calendar-client'

const ACC = 'a'
const FROM = new Date('2026-07-26T22:00:00.000Z')
const TO = new Date('2026-09-06T22:00:00.000Z')

/**
 * An event as THIS server describes one: no `uid`, because it does not send one.
 *
 * `timeZone` is set because the views read it — it is deliberately not part of the signature, and
 * `resolveIdentity` ignoring it is asserted below.
 */
const event = (over: Partial<CalendarEvent> = {}): CalendarEvent =>
  ({
    id: 'e1',
    calendarIds: { c1: true },
    title: 'Review',
    start: '2026-08-21T16:00:00',
    duration: 'PT60M',
    timeZone: 'Europe/Berlin',
    ...over,
  }) as CalendarEvent

interface FakeOptions {
  /** What the EXPANDED query resolves to — the ids the grid would draw with. */
  readonly occurrences?: CalendarEvent[]
  /** What the UNEXPANDED query resolves to — the ids a write may address. */
  readonly objects?: CalendarEvent[]
  /** Replaces the answer to `CalendarEvent/set`; used to play back a refusal. */
  readonly onSet?: (args: Record<string, unknown>) => Record<string, unknown>
  /** Makes the unexpanded companion `/get` fail at the method level. */
  readonly breakIdentity?: boolean
  /** What `Calendar/get` resolves to. */
  readonly calendars?: Calendar[]
}

/**
 * A JMAP server that answers the four calls `eventsInRange` makes, plus `/set`.
 *
 * It resolves `#ids` back-references itself, because the whole point of the range query is that the
 * two `query`/`get` pairs are chained inside ONE request — a fake that ignored the reference would
 * not be able to tell the two `get`s apart, which is exactly the distinction under test.
 */
function fakeClient(options: FakeOptions = {}): {
  client: JmapClient
  calls: Invocation[]
} {
  const calls: Invocation[] = []
  const occurrences = options.occurrences ?? []
  const objects = options.objects ?? []
  const calendars = options.calendars ?? []

  const run = (invocations: Invocation[]): MethodResponses => {
    const responses: Invocation[] = []
    /** Which ids each `query` answered with, so a chained `get` can resolve its `#ids`. */
    const queryIds = new Map<string, string[]>()
    /** Which of those queries was the UNEXPANDED one — the companion `get` chains off it. */
    const identityQueries = new Set<string>()

    for (const [name, rawArgs, id] of invocations) {
      const args = rawArgs as Record<string, unknown>
      calls.push([name, args, id])

      if (name === 'Calendar/get') {
        responses.push([name, { accountId: ACC, state: 's1', list: calendars, notFound: [] }, id])
        continue
      }

      if (name === 'CalendarEvent/query') {
        const expanded = args.expandRecurrences === true
        const list = expanded ? occurrences : objects
        const ids = list.map((entry) => entry.id)
        queryIds.set(id, ids)
        if (!expanded) identityQueries.add(id)
        responses.push([name, { accountId: ACC, ids, queryState: 'q1' }, id])
        continue
      }

      if (name === 'CalendarEvent/get') {
        const reference = args['#ids'] as { resultOf: string } | undefined
        const wanted =
          reference === undefined
            ? (args.ids as string[] | undefined)
            : queryIds.get(reference.resultOf)
        // The identity call is the one chained off the unexpanded query — recognised by WHAT IT
        // ASKED, not by how many properties it named, so growing the property list cannot silently
        // turn this fake into one that answers both `get`s the same way.
        const isCompanion = reference !== undefined && identityQueries.has(reference.resultOf)
        if (isCompanion && options.breakIdentity === true) {
          responses.push(['error', { type: 'invalidArguments' }, id])
          continue
        }
        const pool = [...occurrences, ...objects]
        const list = (wanted ?? []).flatMap((wantedId) => {
          const found = pool.find((entry) => entry.id === wantedId)
          return found === undefined ? [] : [found]
        })
        responses.push([name, { accountId: ACC, state: 's1', list, notFound: [] }, id])
        continue
      }

      const echo = options.onSet?.(args) ?? {
        created: args.create === undefined ? null : { e: { id: 'new-1' } },
        updated: args.update === undefined ? null : { x: null },
        destroyed: args.destroy ?? null,
      }
      responses.push([name, echo, id])
    }
    return new MethodResponses(responses, 'session-1', undefined)
  }

  const client = {
    async call(invocations: Invocation[]) {
      return run(invocations)
    },
    request() {
      return new RequestBuilder(async (builder) => run(builder.invocations))
    },
  }
  return { client: client as unknown as JmapClient, calls }
}

/**
 * The occurrence a Stalwart-shaped server hands back for a plain, non-repeating event.
 *
 * Measured: identical to the stored event in every property the identity query asks for, with a
 * synthetic id swapped in. That equality IS the join — there is nothing else to join on.
 */
const SYNTHETIC = event({ id: 'eaaaaa0' })
/** The same event as the unexpanded query names it. */
const REAL = event({ id: '0' })

describe('eventsInRange', () => {
  it('asks the server BOTH ways in one request', async () => {
    // The expanded answer is what the grid draws; the unexpanded one is what a write may address.
    // Two round trips would be two chances to disagree, so both live in the same request.
    const { client, calls } = fakeClient({ occurrences: [SYNTHETIC], objects: [REAL] })
    await makeCalendarClient(client, ACC).eventsInRange(FROM, TO)

    const queries = calls.filter(([name]) => name === 'CalendarEvent/query')
    expect(queries).toHaveLength(2)
    expect((queries[0]?.[1] as Record<string, unknown>).expandRecurrences).toBe(true)
    expect((queries[1]?.[1] as Record<string, unknown>).expandRecurrences).toBeUndefined()
    // Same window, or the two answers would be about different months.
    expect((queries[0]?.[1] as { filter: unknown }).filter).toEqual(
      (queries[1]?.[1] as { filter: unknown }).filter,
    )
  })

  it('gives a displayed occurrence the id of the OBJECT behind it, not its own', async () => {
    // T1 in one line: `eaaaaa0` is what the grid drew with, `0` is what a `/set` may touch.
    const { client } = fakeClient({ occurrences: [SYNTHETIC], objects: [REAL] })
    const [placed] = await makeCalendarClient(client, ACC).eventsInRange(FROM, TO)

    expect(placed?.event.id).toBe('eaaaaa0')
    expect(placed?.writeId).toBe('0')
  })

  it('refuses to write when the occurrence cannot be traced to an object', async () => {
    // No uid match and no id match: the honest answer is "not editable", not "editable and then
    // refused by the server", which is the state the whole calendar was in.
    const { client } = fakeClient({
      occurrences: [event({ id: 'eaaaaa9', title: 'Somebody else', start: '2026-08-22T09:00:00' })],
      objects: [REAL],
    })
    const [placed] = await makeCalendarClient(client, ACC).eventsInRange(FROM, TO)

    expect(placed?.writeId).toBeNull()
    expect(placed && refuseEdit(placed)).toBe('unresolved')
  })

  it('still draws the month when the identity query fails', async () => {
    // Reading must not depend on being able to write. A server that refuses the companion call
    // costs the reader the editor, not the calendar.
    const { client } = fakeClient({
      occurrences: [SYNTHETIC],
      objects: [REAL],
      breakIdentity: true,
    })
    const placed = await makeCalendarClient(client, ACC).eventsInRange(FROM, TO)

    expect(placed).toHaveLength(1)
    expect(placed[0]?.writeId).toBeNull()
  })

  it('marks an occurrence as a series from the MASTER, not from the occurrence alone', async () => {
    // The FIRST occurrence of a weekly series starts where its master does, so it is the one
    // occurrence the signature does resolve — and it must come back marked as a series, not as an
    // ordinary event that happens to be writable.
    const { client } = fakeClient({
      occurrences: [event({ id: 'eaaaaa1' })],
      objects: [
        event({ id: '7', recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'weekly' } }),
      ],
    })
    const [placed] = await makeCalendarClient(client, ACC).eventsInRange(FROM, TO)

    expect(placed?.series).toBe(true)
    expect(placed && refuseEdit(placed)).toBe('series')
  })

  it('asks BOTH gets for every field the signature reads', async () => {
    // The join compares two answers, so it breaks the moment they are asked for different things:
    // a property that was not requested reads as absent, and two events both "missing" a title
    // would look alike. `recurrenceRule` is there for the series flag, which nothing else answers.
    const { client, calls } = fakeClient({ occurrences: [SYNTHETIC], objects: [REAL] })
    await makeCalendarClient(client, ACC).eventsInRange(FROM, TO)

    const gets = calls.filter(([name]) => name === 'CalendarEvent/get')
    expect(gets).toHaveLength(2)
    for (const get of gets) {
      const properties = (get[1] as { properties: string[] }).properties
      for (const field of ['calendarIds', 'title', 'start', 'duration', 'showWithoutTime']) {
        expect(properties, `${field} must be asked for on both sides`).toContain(field)
      }
      // SINGULAR (ADR-025). The plural RFC 8984 spelling this line used to assert was never
      // answered by this server, which is exactly why the master of a series read as a plain
      // event — and why asserting the old name here kept the bug green for months.
      expect(properties).toContain('recurrenceRule')
      expect(properties).not.toContain('recurrenceRules')
    }
    // And `uid` on neither: the server does not send it, so asking for it only suggests it matters.
    expect((gets[0]?.[1] as { properties: string[] }).properties).not.toContain('uid')
  })

  it('asks the EXPANDED get for `baseEventId`, which is the server naming the master', async () => {
    // Not a nice-to-have: it is the only branch of `resolveIdentity` that resolves an occurrence
    // whose start has moved away from its master's, and a property that is never requested always
    // reads as absent.
    const { client, calls } = fakeClient({ occurrences: [SYNTHETIC], objects: [REAL] })
    await makeCalendarClient(client, ACC).eventsInRange(FROM, TO)

    const gets = calls.filter(([name]) => name === 'CalendarEvent/get')
    expect((gets[0]?.[1] as { properties: string[] }).properties).toContain('baseEventId')
  })

  it('drops an event whose start cannot be read rather than sorting it to 1970', async () => {
    const { client } = fakeClient({
      occurrences: [event({ id: 'eaaaaa2', start: 'not a date' }), SYNTHETIC],
      objects: [REAL],
    })
    expect(await makeCalendarClient(client, ACC).eventsInRange(FROM, TO)).toHaveLength(1)
  })
})

describe('updateEvent', () => {
  it('addresses the write id — never the id the view was drawn with', async () => {
    const { client, calls } = fakeClient({ occurrences: [SYNTHETIC], objects: [REAL] })
    const calendar = makeCalendarClient(client, ACC)
    const [placed] = await calendar.eventsInRange(FROM, TO)
    if (placed === undefined) throw new Error('expected one event')

    await calendar.updateEvent(placed, {
      calendarId: 'c1',
      title: 'Changed',
      description: '',
      start: '2026-08-22T08:00:00',
      durationMinutes: 60,
      allDay: false,
      timeZone: 'Europe/Berlin',
    })

    const set = calls.find(([name]) => name === 'CalendarEvent/set')
    const update = (set?.[1] as { update: Record<string, unknown> }).update
    expect(Object.keys(update)).toEqual(['0'])
    expect(Object.keys(update)).not.toContain('eaaaaa0')
  })

  it('reports the reason the server gave for a refusal', async () => {
    const { client } = fakeClient({
      occurrences: [SYNTHETIC],
      objects: [REAL],
      onSet: () => ({
        notUpdated: {
          '0': {
            type: 'invalidProperties',
            description: 'Updating synthetic ids is not yet supported.',
          },
        },
      }),
    })
    const calendar = makeCalendarClient(client, ACC)
    const [placed] = await calendar.eventsInRange(FROM, TO)
    if (placed === undefined) throw new Error('expected one event')

    const failure = await calendar
      .updateEvent(placed, {
        calendarId: 'c1',
        title: 'Changed',
        description: '',
        start: '2026-08-22T08:00:00',
        durationMinutes: 60,
        allDay: false,
        timeZone: 'Europe/Berlin',
      })
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(CalendarSetError)
    expect(refusalReason(failure)).toBe('Updating synthetic ids is not yet supported.')
  })
})

describe('destroyEvent', () => {
  it('addresses the write id and takes a full copy BEFORE deleting', async () => {
    // The copy is what makes the deletion undoable, and it has to be read in the same request and
    // ahead of the destroy — afterwards there is nothing left to copy.
    const { client, calls } = fakeClient({ occurrences: [SYNTHETIC], objects: [REAL] })
    const calendar = makeCalendarClient(client, ACC)
    const [placed] = await calendar.eventsInRange(FROM, TO)
    if (placed === undefined) throw new Error('expected one event')

    const snapshot = await calendar.destroyEvent(placed)

    const writes = calls.slice(4)
    expect(writes.map(([name]) => name)).toEqual(['CalendarEvent/get', 'CalendarEvent/set'])
    expect((writes[0]?.[1] as { ids: string[] }).ids).toEqual(['0'])
    expect((writes[1]?.[1] as { destroy: string[] }).destroy).toEqual(['0'])
    // No `properties`: an Undo missing the alerts or the attendees is a second loss, not a rescue.
    expect((writes[0]?.[1] as Record<string, unknown>).properties).toBeUndefined()
    expect(snapshot?.id).toBe('0')
  })

  it('reports a refusal instead of claiming a deletion', async () => {
    const { client } = fakeClient({
      occurrences: [SYNTHETIC],
      objects: [REAL],
      onSet: () => ({
        notDestroyed: {
          '0': {
            type: 'invalidProperties',
            description: 'Deleting synthetic ids is not yet supported.',
          },
        },
      }),
    })
    const calendar = makeCalendarClient(client, ACC)
    const [placed] = await calendar.eventsInRange(FROM, TO)
    if (placed === undefined) throw new Error('expected one event')

    const failure = await calendar.destroyEvent(placed).catch((error: unknown) => error)
    expect(refusalReason(failure)).toBe('Deleting synthetic ids is not yet supported.')
  })

  it('never sends a write for an occurrence with no write id', async () => {
    const { client, calls } = fakeClient({ occurrences: [SYNTHETIC], objects: [] })
    const calendar = makeCalendarClient(client, ACC)
    const [placed] = await calendar.eventsInRange(FROM, TO)
    if (placed === undefined) throw new Error('expected one event')

    await expect(calendar.destroyEvent(placed)).rejects.toThrow(/writable/)
    expect(calls.some(([name]) => name === 'CalendarEvent/set')).toBe(false)
  })
})

describe('restoreEvent', () => {
  it('re-creates everything except what the server owns', async () => {
    const { client, calls } = fakeClient()
    await makeCalendarClient(client, ACC).restoreEvent(
      event({
        id: '0',
        uid: 'uid-1',
        created: '2026-08-01T09:00:00Z',
        updated: '2026-08-02T09:00:00Z',
        isOrigin: true,
        alerts: { a1: { '@type': 'Alert' } },
        participants: { p1: { '@type': 'Participant', name: 'Bob' } },
      }),
    )

    const body = (calls[0]?.[1] as { create: { e: Record<string, unknown> } }).create.e
    expect(body.id).toBeUndefined()
    expect(body.created).toBeUndefined()
    expect(body.updated).toBeUndefined()
    expect(body.isOrigin).toBeUndefined()
    // The uid stays: restoring an event means bringing back THAT event, and to a CalDAV client on
    // the same account the uid is what says so.
    expect(body.uid).toBe('uid-1')
    // And everything the editor cannot show comes back with it.
    expect(body.alerts).toEqual({ a1: { '@type': 'Alert' } })
    expect(body.participants).toEqual({ p1: { '@type': 'Participant', name: 'Bob' } })
  })

  /**
   * Measured, not reasoned: Stalwart v0.16.18 refuses `method` in **create** with
   * `{"type":"invalidProperties","description":"This property is immutable."}` — the same answer
   * it gives to an update. An event that arrived by iMIP carries one, so without this the delete
   * would succeed, the Undo toast would appear, and pressing it would fail. Offering an Undo that
   * cannot run is worse than offering none.
   */
  it('drops `method`, which this server refuses on create as well as on update', async () => {
    const { client, calls } = fakeClient()
    await makeCalendarClient(client, ACC).restoreEvent(
      event({ id: '0', method: 'request', title: 'Invitation' }),
    )

    const body = (calls[0]?.[1] as { create: { e: Record<string, unknown> } }).create.e
    expect(body.method).toBeUndefined()
    expect(body.title).toBe('Invitation')
  })
})

describe('eventSignature', () => {
  it('is equal for the two answers the server gives about ONE event', () => {
    // The whole join in one assertion: the expanded occurrence and the stored object differ in
    // their id and in nothing else the signature reads.
    expect(eventSignature(event({ id: 'eaaaaa0' }))).toBe(eventSignature(event({ id: '0' })))
  })

  it('IGNORES timeZone, which the two answers disagree about', () => {
    /*
     * Measured against the fixture: for a whole-day or floating event the expanded query answers
     * `Etc/UTC` and a direct read of the same event answers `null` (the same discrepancy T12 found
     * in the agenda). A signature that read the zone would therefore fail to resolve exactly those
     * events — and they are the ones a reader is most likely to have made by hand.
     */
    expect(eventSignature(event({ timeZone: 'Etc/UTC' }))).toBe(
      eventSignature(event({ timeZone: null })),
    )
  })

  it('separates events that differ in any field it does read', () => {
    const base = eventSignature(event())
    expect(eventSignature(event({ title: 'Other' }))).not.toBe(base)
    expect(eventSignature(event({ start: '2026-08-21T17:00:00' }))).not.toBe(base)
    expect(eventSignature(event({ duration: 'PT90M' }))).not.toBe(base)
    expect(eventSignature(event({ calendarIds: { c2: true } }))).not.toBe(base)
    expect(eventSignature(event({ showWithoutTime: true }))).not.toBe(base)
  })

  it('does not depend on the order the calendar set arrives in', () => {
    // `calendarIds` is a SET; JSON object key order is an accident of the encoder, not a fact
    // about the event. Two orderings that meant the same thing must not read as two events.
    expect(eventSignature(event({ calendarIds: { c1: true, c2: true } }))).toBe(
      eventSignature(event({ calendarIds: { c2: true, c1: true } })),
    )
  })

  it('reads a missing field and an empty one the same way', () => {
    // The tolerant direction on purpose: this can only ever cause a COLLISION, which costs an edit,
    // never a false match, which would cost the wrong event.
    const bare = {
      id: 'x',
      calendarIds: { c1: true },
      start: '2026-08-21T16:00:00',
    } as CalendarEvent
    expect(eventSignature(bare)).toBe(
      eventSignature({ ...bare, title: '', duration: '', showWithoutTime: false } as CalendarEvent),
    )
  })

  it('survives an event whose calendarIds is not a set at all', () => {
    // Nothing about a malformed answer may throw here: this runs over every event in the month,
    // and one bad record would take the whole calendar down rather than one row's Edit button.
    const broken = {
      id: 'x',
      start: '2026-08-21T16:00:00',
      calendarIds: null,
    } as unknown as CalendarEvent
    expect(() => eventSignature(broken)).not.toThrow()
  })

  it('cannot be forged by a title that contains the encoding', () => {
    // Joined with a separator instead of encoded, a crafted title would collide with another
    // event and hand the reader someone else's id to write to.
    expect(eventSignature(event({ title: '","2026-08-21T16:00:00' }))).not.toBe(
      eventSignature(event({ title: '' })),
    )
  })
})

describe('resolveIdentity', () => {
  const single = event({ id: '0', title: 'Single' })
  const weekly = event({
    id: '7',
    title: 'Weekly',
    // Singular: how `jscalendarbis`, and therefore this server, reports a repetition (ADR-025).
    recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'weekly' },
  })
  const index = indexObjects([single, weekly])

  it('takes `baseEventId` as the write id WITHOUT consulting the signature', () => {
    /*
     * The measured shape, straight off the wire:
     *   {"start":"2026-09-14T11:00:00","title":"Wochenmeeting (verschoben)",
     *    "recurrenceId":"2026-09-14T11:00:00","id":"eaaaaaf","baseEventId":"f"}
     *
     * The index here holds NOTHING that matches: no id `f`, no matching signature. The old code
     * therefore answered `writeId: null` and the occurrence was shown read-only-because-unresolved,
     * even though the server had named its master in the payload. That is the whole point of the
     * new branch — it resolves an occurrence whose `start` has moved away from its master's, which
     * is every occurrence of a series after the first.
     */
    const moved = event({
      id: 'eaaaaaf',
      title: 'Wochenmeeting (verschoben)',
      start: '2026-09-14T11:00:00',
      recurrenceId: '2026-09-14T11:00:00',
      baseEventId: 'f',
    })
    expect(resolveIdentity(moved, index)).toEqual({ writeId: 'f', series: true })
  })

  it('does NOT read `baseEventId` as "this repeats"', () => {
    /*
     * Stalwart puts it on every event an expanded query answers with, including instances of
     * events that repeat nothing — `Principal/getAvailability` showed `{"id":"iaaaaab",
     * "baseEventId":"b"}` for a plain single event. Treating its presence as a series flag would
     * turn every event in the month read-only, which is a worse bug than the one it fixes.
     */
    const instance = event({ id: 'iaaaaa0', title: 'Single', baseEventId: '0' })
    expect(resolveIdentity(instance, index)).toEqual({ writeId: '0', series: false })
  })

  it('still carries the series flag over when the index HAS the named master', () => {
    expect(resolveIdentity(event({ id: 'eaaaaa7', baseEventId: '7' }), index).series).toBe(true)
  })

  it('ignores an empty `baseEventId` rather than writing to nothing', () => {
    const blank = event({ id: 'eaaaaa0', title: 'Single', baseEventId: '' })
    expect(resolveIdentity(blank, index).writeId).toBe('0')
  })

  it('maps a synthetic occurrence onto its object by signature', () => {
    expect(resolveIdentity(event({ id: 'eaaaaa0', title: 'Single' }), index)).toEqual({
      writeId: '0',
      series: false,
    })
  })

  it('accepts an id the unexpanded query itself named', () => {
    // A server that does not synthesise ids when expanding needs no mapping, and must keep working.
    expect(resolveIdentity(event({ id: '0', title: 'Single' }), index).writeId).toBe('0')
  })

  it('refuses an occurrence nothing in the window looks like', () => {
    // An occurrence of a series lands here: it starts at a different time from its master, so it
    // matches nothing — which is the same answer `isEditable` gives it anyway.
    expect(
      resolveIdentity(
        event({ id: 'eaaaaa5', title: 'Weekly', start: '2026-08-28T16:00:00' }),
        index,
      ).writeId,
    ).toBeNull()
  })

  it('refuses an occurrence that TWO objects look like', () => {
    /*
     * The ambiguity case, and the reason the map stores `null` rather than the last writer.
     *
     * Two events at the same time, the same length, the same title, in the same calendar cannot be
     * told apart by anything this join can see. Picking one would mean the reader opens the second
     * and edits the first — silently, and with no way to notice. Read-only is the honest answer.
     */
    const twins = indexObjects([event({ id: 'x' }), event({ id: 'y' })])
    expect(resolveIdentity(event({ id: 'eaaaaa0' }), twins).writeId).toBeNull()
    // A collision poisons ONE signature, not the index: a third, distinct object still resolves.
    const mixed = indexObjects([event({ id: 'x' }), event({ id: 'y' }), single])
    expect(resolveIdentity(event({ id: 'eaaaaa0' }), mixed).writeId).toBeNull()
    expect(resolveIdentity(event({ id: 'eaaaaa2', title: 'Single' }), mixed).writeId).toBe('0')
  })

  it('refuses an occurrence with no usable fields at all', () => {
    const anonymous = { id: 'eaaaaa9', calendarIds: {}, start: '' } as unknown as CalendarEvent
    expect(resolveIdentity(anonymous, index).writeId).toBeNull()
  })

  it('carries the series flag over from the master', () => {
    expect(resolveIdentity(event({ id: 'eaaaaa7', title: 'Weekly' }), index).series).toBe(true)
  })

  it('treats a recurrenceId as a series even where the master says nothing', () => {
    expect(
      resolveIdentity(
        event({ id: 'eaaaaa0', title: 'Single', recurrenceId: '2026-08-21T16:00:00' }),
        index,
      ).series,
    ).toBe(true)
  })
})

describe('a series as this server actually reports one', () => {
  /*
   * Measured twice, and the second measurement corrected the first.
   *
   * The original run put a weekly `RRULE` in over CalDAV and recorded that the stored master
   * answered WITHOUT its rule "even when asked for it by name" — so the "series flag from the
   * master" belt looked unfastened and `recurrenceId` seemed to carry the whole load. The gap
   * survey of 21 Aug 2026 found the cause: the client was asking for `recurrenceRules`, and this
   * server speaks `jscalendarbis`, where the property is `recurrenceRule` (ADR-025). A create
   * carrying the plural name is refused with `invalidProperties: ["recurrenceRules"]`; the
   * singular one is accepted and read back. So the master below carries its rule, because that is
   * what the server sends when asked correctly.
   *
   * This block keeps the occurrences WITHOUT `baseEventId` on purpose: it pins the signature
   * fallback, i.e. what happens on a server that does not send it. The block after it is the same
   * series as Stalwart really answers, with `baseEventId` on every instance.
   */
  const master = event({
    id: 'b',
    title: 'CalDAV Weekly Probe',
    start: '2026-08-03T09:00:00',
    recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'weekly' },
  })
  const occurrence = (start: string, id: string) =>
    event({ id, title: 'CalDAV Weekly Probe', start, recurrenceId: start })

  it('refuses the FIRST occurrence, which the signature does resolve', () => {
    // It starts where its master starts, so it is the one instance with a write id — and it must
    // still not open an editor. `refuseEdit` asks about the series before it asks about the id.
    const identity = resolveIdentity(
      occurrence('2026-08-03T09:00:00', 'eaaaaab'),
      indexObjects([master]),
    )
    expect(identity.writeId).toBe('b')
    expect(identity.series).toBe(true)
    expect(refuseEdit(placeEvent(occurrence('2026-08-03T09:00:00', 'eaaaaab'), identity))).toBe(
      'series',
    )
  })

  it('refuses every later occurrence, which the signature resolves to nothing', () => {
    const identity = resolveIdentity(
      occurrence('2026-08-10T09:00:00', 'iaaaaab'),
      indexObjects([master]),
    )
    expect(identity.writeId).toBeNull()
    // `series`, not `unresolved`: the reader is told this repeats, which is true and actionable,
    // rather than that the server said something we could not follow.
    expect(refuseEdit(placeEvent(occurrence('2026-08-10T09:00:00', 'iaaaaab'), identity))).toBe(
      'series',
    )
  })
})

describe('a series with `baseEventId`, as Stalwart really answers one', () => {
  /*
   * The four instances of event `f` from the 21 Aug 2026 survey, verbatim. Note that the master is
   * NOT in the index: an unexpanded query over the same window returns it, but a reader paging to
   * a later month gets occurrences whose master started before the window. Under the signature
   * join those were unresolvable; here every one of them names `f`.
   */
  const instance = (start: string, id: string, title = 'Wochenmeeting') =>
    event({ id, title, start, recurrenceId: start, baseEventId: 'f' })

  it('resolves EVERY instance to the master, including the ones the signature cannot', () => {
    const empty = indexObjects([])
    for (const [start, id] of [
      ['2026-09-07T09:00:00', 'iaaaaaf'],
      ['2026-09-14T11:00:00', 'eaaaaaf'],
      ['2026-09-28T09:00:00', 'maaaaaf'],
    ] as const) {
      const identity = resolveIdentity(instance(start, id), empty)
      expect(identity.writeId, `${id} must resolve to its master`).toBe('f')
      expect(identity.series).toBe(true)
    }
  })

  it('refuses to open an editor on any of them all the same', () => {
    // Resolving is not permitting. A write id makes Undo and delete possible; the series refusal
    // is what stops a single-event patch reaching a repeating meeting.
    const one = instance('2026-09-14T11:00:00', 'eaaaaaf', 'Wochenmeeting (verschoben)')
    expect(refuseEdit(placeEvent(one, resolveIdentity(one, indexObjects([]))))).toBe('series')
  })
})

describe('listCalendars', () => {
  it('NAMES the properties it needs, `isVisible` above all', async () => {
    /*
     * Measured: `Calendar/get` with no `properties` answers `id, name, description, color,
     * timeZone, sortOrder, isDefault, isSubscribed, myRights` and silently omits `isVisible`,
     * `shareWith`, `includeInAvailability` and both `defaultAlerts*` maps. The call used to send
     * no `properties` at all, so a client that started reading `isVisible` would have seen
     * `undefined` on every calendar and concluded the server does not support hiding one.
     */
    const { client, calls } = fakeClient({ calendars: [] })
    await makeCalendarClient(client, ACC).listCalendars()

    const get = calls.find(([name]) => name === 'Calendar/get')
    const properties = (get?.[1] as { properties?: string[] }).properties
    expect(properties).toBeDefined()
    for (const field of [
      'isVisible',
      'includeInAvailability',
      'defaultAlertsWithTime',
      'defaultAlertsWithoutTime',
      'shareWith',
    ]) {
      expect(properties, `${field} must be asked for or it never arrives`).toContain(field)
    }
    // And nothing the app already reads may fall out of the answer by being left unnamed.
    for (const field of ['id', 'name', 'color', 'isDefault', 'isSubscribed', 'myRights']) {
      expect(properties, `${field} was in the default answer and must stay`).toContain(field)
    }
  })

  it('hands the list back untouched — hiding is a screen decision, not a seam one', async () => {
    const hidden = { id: 'c9', name: 'Privat', isVisible: false } as unknown as Calendar
    const { client } = fakeClient({ calendars: [hidden] })
    expect(await makeCalendarClient(client, ACC).listCalendars()).toEqual([hidden])
  })
})

describe('placeEvent', () => {
  it('defaults to NOT writable', () => {
    // The safe default is the point: a caller who forgets to resolve identity gets an event that
    // cannot be written, not one that writes with a display id.
    expect(placeEvent(event()).writeId).toBeNull()
  })
})
