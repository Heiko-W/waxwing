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
 *    writable-and-refused.
 *
 * The client is a hand-rolled fake of the `call()`/`request()` seam rather than a real `JmapClient`
 * over a fetch mock: `packages/jmap/src/test-support.ts` is deliberately outside the package's
 * published surface, so app-side tests fake the seam (see `settings/identity-client.test.ts`).
 */

import type { CalendarEvent, Invocation, JmapClient } from '@waxwing/jmap'
import { MethodResponses, RequestBuilder } from '@waxwing/jmap'
import { describe, expect, it } from 'vitest'
import {
  CalendarSetError,
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

const event = (over: Partial<CalendarEvent> = {}): CalendarEvent =>
  ({
    id: 'e1',
    uid: 'uid-1',
    calendarIds: { c1: true },
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

  const run = (invocations: Invocation[]): MethodResponses => {
    const responses: Invocation[] = []
    /** Which ids each `query` answered with, so a chained `get` can resolve its `#ids`. */
    const queryIds = new Map<string, string[]>()

    for (const [name, rawArgs, id] of invocations) {
      const args = rawArgs as Record<string, unknown>
      calls.push([name, args, id])

      if (name === 'CalendarEvent/query') {
        const list = args.expandRecurrences === true ? occurrences : objects
        const ids = list.map((entry) => entry.id)
        queryIds.set(id, ids)
        responses.push([name, { accountId: ACC, ids, queryState: 'q1' }, id])
        continue
      }

      if (name === 'CalendarEvent/get') {
        const reference = args['#ids'] as { resultOf: string } | undefined
        const wanted =
          reference === undefined
            ? (args.ids as string[] | undefined)
            : queryIds.get(reference.resultOf)
        // The identity call is the one asking for the three-property set; nothing else does.
        const properties = args.properties as string[] | undefined
        const isCompanion = properties?.length === 3 && properties.includes('recurrenceRules')
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

/** The occurrence a Stalwart-shaped server hands back for a plain, non-repeating event. */
const SYNTHETIC = event({ id: 'eaaaaa0', uid: 'uid-1' })
/** The same event as the unexpanded query names it. */
const REAL = event({ id: '0', uid: 'uid-1' })

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
      occurrences: [event({ id: 'eaaaaa9', uid: 'uid-other' })],
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
    const { client } = fakeClient({
      occurrences: [event({ id: 'eaaaaa1', uid: 'uid-w' })],
      objects: [
        event({
          id: '7',
          uid: 'uid-w',
          recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'weekly' }],
        }),
      ],
    })
    const [placed] = await makeCalendarClient(client, ACC).eventsInRange(FROM, TO)

    expect(placed?.series).toBe(true)
    expect(placed && refuseEdit(placed)).toBe('series')
  })

  it('asks for uid and recurrenceRules, without which neither question can be answered', async () => {
    const { client, calls } = fakeClient({ occurrences: [SYNTHETIC], objects: [REAL] })
    await makeCalendarClient(client, ACC).eventsInRange(FROM, TO)

    const gets = calls.filter(([name]) => name === 'CalendarEvent/get')
    const properties = (gets[0]?.[1] as { properties: string[] }).properties
    expect(properties).toContain('uid')
    expect(properties).toContain('recurrenceRules')
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
})

describe('resolveIdentity', () => {
  const index = indexObjects([
    event({ id: '0', uid: 'uid-1' }),
    event({
      id: '7',
      uid: 'uid-w',
      recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'weekly' }],
    }),
  ])

  it('maps a synthetic occurrence onto its object by uid', () => {
    expect(resolveIdentity(event({ id: 'eaaaaa0', uid: 'uid-1' }), index)).toEqual({
      writeId: '0',
      series: false,
    })
  })

  it('accepts an id the unexpanded query itself named', () => {
    // A server that does not synthesise ids when expanding needs no mapping, and must keep working.
    expect(resolveIdentity(event({ id: '0', uid: 'uid-1' }), index).writeId).toBe('0')
  })

  it('refuses an occurrence with no uid at all', () => {
    const anonymous = {
      id: 'eaaaaa5',
      calendarIds: {},
      start: '2026-08-21T16:00:00',
    } as CalendarEvent
    expect(resolveIdentity(anonymous, index).writeId).toBeNull()
  })

  it('carries the series flag over from the master', () => {
    expect(resolveIdentity(event({ id: 'eaaaaa7', uid: 'uid-w' }), index).series).toBe(true)
  })

  it('treats a recurrenceId as a series even where the master says nothing', () => {
    expect(
      resolveIdentity(
        event({ id: 'eaaaaa0', uid: 'uid-1', recurrenceId: '2026-08-21T16:00:00' }),
        index,
      ).series,
    ).toBe(true)
  })
})

describe('placeEvent', () => {
  it('defaults to NOT writable', () => {
    // The safe default is the point: a caller who forgets to resolve identity gets an event that
    // cannot be written, not one that writes with a display id.
    expect(placeEvent(event()).writeId).toBeNull()
  })
})
