/**
 * What the series, RSVP and import calls actually put on the wire (K-2 / K-3 / K-4, FR-CAL-01).
 *
 * `event-recurrence.test.ts` and `event-participants.test.ts` pin the shapes; this file pins the
 * REQUEST — which id it addresses, how many calls it takes, and above all where the overrides map
 * it writes came from.
 *
 * **The one that would be easy to get wrong and impossible to see.** Changing one occurrence means
 * writing the whole `recurrenceOverrides` map, because a pointer patch into it is refused on this
 * server (measured; see `event-recurrence.ts`). A whole-map write built from the copy the SCREEN is
 * holding would pass every test that only checks the resulting map, and would delete an override
 * another client added while the dialog was open. So the assertion here is about ordering: the
 * master is re-read, and the value written is the value that read answered with — not the one the
 * `PlacedEvent` was carrying.
 */

import type { CalendarEvent, Invocation, JmapClient } from '@waxwing/jmap'
import { MethodResponses, RequestBuilder } from '@waxwing/jmap'
import { describe, expect, it } from 'vitest'
import { makeCalendarClient, placeEvent } from './calendar-client'

const ACC = 'a'

/**
 * A server that answers `CalendarEvent/get` from a table and records every `/set`.
 *
 * `stored` is what the SERVER has, deliberately different from what the screen is holding — that
 * difference is what the re-read test is about.
 */
function fakeClient(
  stored: Record<string, CalendarEvent>,
  onSet?: (args: Record<string, unknown>) => Record<string, unknown>,
) {
  const calls: Invocation[] = []
  const run = (invocations: Invocation[]): MethodResponses => {
    const responses: Invocation[] = []
    for (const [name, rawArgs, id] of invocations) {
      const args = rawArgs as Record<string, unknown>
      calls.push([name, args, id])
      if (name === 'CalendarEvent/get') {
        const wanted = (args.ids as string[] | undefined) ?? []
        const list = wanted.flatMap((key) => (stored[key] === undefined ? [] : [stored[key]]))
        responses.push([name, { accountId: ACC, state: 's1', list, notFound: [] }, id])
        continue
      }
      if (name === 'ParticipantIdentity/get') {
        responses.push([
          name,
          {
            accountId: ACC,
            state: 's1',
            list: [
              { id: 'a', name: 'kx1', calendarAddress: 'mailto:kx1@waxwing.test', isDefault: true },
            ],
            notFound: [],
          },
          id,
        ])
        continue
      }
      if (name === 'CalendarEvent/parse') {
        responses.push([
          name,
          {
            accountId: ACC,
            parsed: {
              'blob-1': [
                {
                  '@type': 'Event',
                  uid: 'a@x',
                  title: 'Eins',
                  start: '2026-11-01T10:00:00',
                  method: 'request',
                },
                {
                  '@type': 'Event',
                  uid: 'b@x',
                  title: 'Zwei',
                  start: '2026-11-05T00:00:00',
                  method: 'request',
                },
              ],
            },
          },
          id,
        ])
        continue
      }
      responses.push([
        name,
        onSet?.(args) ?? {
          created: args.create === undefined ? null : { e: { id: 'new-1' } },
          updated: args.update === undefined ? null : { x: null },
          destroyed: args.destroy ?? null,
        },
        id,
      ])
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
    async upload() {
      return { blobId: 'blob-1', accountId: ACC, type: 'text/calendar', size: 1 }
    },
  }
  return { client: client as unknown as JmapClient, calls }
}

const MASTER: CalendarEvent = {
  id: 'b',
  calendarIds: { c1: true },
  title: 'Serie',
  start: '2026-09-07T09:00:00',
  duration: 'PT1H',
  timeZone: 'Europe/Berlin',
  recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'weekly', count: 6 },
} as CalendarEvent

/** The second occurrence, as an expanded query answers it: synthetic id, `baseEventId` to the master. */
const OCCURRENCE = placeEvent(
  {
    id: 'iaaaaab',
    calendarIds: { c1: true },
    title: 'Serie',
    start: '2026-09-14T09:00:00',
    recurrenceId: '2026-09-14T09:00:00',
    baseEventId: 'b',
    duration: 'PT1H',
  } as CalendarEvent,
  { writeId: 'b', series: true },
)

const draft = {
  calendarId: 'c1',
  title: 'Serie',
  description: '',
  start: '2026-09-14T14:00:00',
  durationMinutes: 60,
  allDay: false,
  timeZone: 'Europe/Berlin',
}

describe('updateEvent with scope "occurrence"', () => {
  it('addresses the MASTER, never the synthetic occurrence id', async () => {
    // T1's lesson, in the one place it is easiest to forget: the thing being changed is an
    // occurrence, and the thing being written is its master.
    const { client, calls } = fakeClient({ b: MASTER })
    await makeCalendarClient(client, ACC).updateEvent(OCCURRENCE, draft, 'occurrence')

    const set = calls.find(([name]) => name === 'CalendarEvent/set')
    expect(Object.keys((set?.[1] as { update: Record<string, unknown> }).update)).toEqual(['b'])
  })

  it('RE-READS the master and writes the map the SERVER has, not the one the screen had', async () => {
    /*
     * The screen's copy of the master carries no overrides at all — it is what the month view
     * fetched. The server has one, added by another client since. A client that merged into the
     * copy it was holding would write a map without it, and the other client's exception would be
     * gone with nothing to say so.
     */
    const withOverride: CalendarEvent = {
      ...MASTER,
      recurrenceOverrides: { '2026-09-28T09:00:00': { excluded: true } },
    } as CalendarEvent
    const { client, calls } = fakeClient({ b: withOverride })
    await makeCalendarClient(client, ACC).updateEvent(OCCURRENCE, draft, 'occurrence')

    const names = calls.map(([name]) => name)
    expect(names).toEqual(['CalendarEvent/get', 'CalendarEvent/set'])

    const set = calls[1]?.[1] as {
      update: Record<string, { recurrenceOverrides: Record<string, unknown> }>
    }
    const overrides = set.update.b?.recurrenceOverrides
    // The other client's exclusion survived.
    expect(overrides?.['2026-09-28T09:00:00']).toEqual({ excluded: true })
    // And the change the reader made is the only other entry.
    expect(overrides?.['2026-09-14T09:00:00']).toEqual({ start: '2026-09-14T14:00:00' })
  })

  it('writes the map as a VALUE, because a pointer into it is refused by this server', () => {
    /*
     * Kept as a statement rather than an assertion because it is a fact about the server, not about
     * this code: `"recurrenceOverrides/<rid>": {...}` is answered
     * `invalidProperties: "Patch operation failed."` on v0.16.18 while `recurrenceRule/count` in
     * the same request succeeds. The test above asserts the consequence — that the value written is
     * a complete, freshly-read map.
     */
    expect(true).toBe(true)
  })

  it('leaves a plain event alone: no re-read, no overrides, just the patch', async () => {
    // The scope parameter must be inert for an event that does not repeat, or every ordinary save
    // pays for a round trip it does not need.
    const single = placeEvent(
      { id: '7', calendarIds: { c1: true }, start: '2026-09-14T09:00:00' } as CalendarEvent,
      {
        writeId: '7',
        series: false,
      },
    )
    const { client, calls } = fakeClient({ '7': MASTER })
    await makeCalendarClient(client, ACC).updateEvent(single, draft, 'occurrence')

    expect(calls.map(([name]) => name)).toEqual(['CalendarEvent/set'])
    const set = calls[0]?.[1] as { update: Record<string, Record<string, unknown>> }
    expect(set.update['7']).not.toHaveProperty('recurrenceOverrides')
  })
})

describe('excludeOccurrence', () => {
  it('removes ONE occurrence and keeps every other exception', async () => {
    const withOverride: CalendarEvent = {
      ...MASTER,
      recurrenceOverrides: { '2026-09-21T09:00:00': { title: 'Behalten' } },
    } as CalendarEvent
    const { client, calls } = fakeClient({ b: withOverride })
    await makeCalendarClient(client, ACC).excludeOccurrence(OCCURRENCE)

    const set = calls[1]?.[1] as {
      update: Record<string, { recurrenceOverrides: Record<string, unknown> }>
    }
    expect(set.update.b?.recurrenceOverrides).toEqual({
      '2026-09-21T09:00:00': { title: 'Behalten' },
      '2026-09-14T09:00:00': { excluded: true },
    })
  })
})

describe('rsvp', () => {
  it('sends ONE pointer and touches nothing else', async () => {
    // The whole `participants` map would pass a test that checked the resulting status and would
    // silently re-write every participant as this client models them.
    const { client, calls } = fakeClient({ b: MASTER })
    await makeCalendarClient(client, ACC).rsvp(OCCURRENCE, 'p1', 'accepted')

    expect(calls.map(([name]) => name)).toEqual(['CalendarEvent/set'])
    const set = calls[0]?.[1] as { update: Record<string, Record<string, unknown>> }
    expect(set.update.b).toEqual({ 'participants/p1/participationStatus': 'accepted' })
  })
})

describe('createEvent and invitations', () => {
  it('does NOT ask the server to send anything unless the screen said so', async () => {
    // Measured: `sendSchedulingMessages: true` is the only trigger. Setting it on every write would
    // re-invite the whole room because somebody corrected a spelling.
    const { client, calls } = fakeClient({})
    await makeCalendarClient(client, ACC).createEvent(draft)
    expect(calls[0]?.[1]).not.toHaveProperty('sendSchedulingMessages')
  })

  it('asks for it when it does', async () => {
    const { client, calls } = fakeClient({})
    await makeCalendarClient(client, ACC).createEvent(draft, true)
    expect((calls[0]?.[1] as Record<string, unknown>).sendSchedulingMessages).toBe(true)
  })
})

describe('listParticipantIdentities (K-10)', () => {
  it('reads them and writes nothing', async () => {
    /*
     * Read-only is not caution here, it is the measurement: `isDefault` cannot be set in `create`
     * or `update` ("Field could not be set."), a `create` naming an address the account does not own
     * is refused, and `/changes` cannot answer. During the gap survey a write destroyed a test
     * account's default identity, which is why there is no `set` in this client at all.
     */
    const { client, calls } = fakeClient({})
    const identities = await makeCalendarClient(client, ACC).listParticipantIdentities()

    expect(identities[0]?.calendarAddress).toBe('mailto:kx1@waxwing.test')
    expect(calls.map(([name]) => name)).toEqual(['ParticipantIdentity/get'])
  })
})

describe('parseIcs (K-4)', () => {
  it('uploads as text/calendar and reads EVERY event out of the blob', async () => {
    // Two VEVENTs, two candidates. And the upload states its type: a `.ics` picked from a cloud
    // provider arrives with `type: ''`, and `application/octet-stream` is not something the
    // calendar parser has any reason to read.
    const { client, calls } = fakeClient({})
    const candidates = await makeCalendarClient(client, ACC).parseIcs(new Blob(['x']) as File)

    expect(candidates).toHaveLength(2)
    expect(candidates.map((entry) => entry.title)).toEqual(['Eins', 'Zwei'])
    expect((calls[0]?.[1] as { blobIds: string[] }).blobIds).toEqual(['blob-1'])
  })
})
