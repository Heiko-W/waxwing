/**
 * JMAP for Calendars (M5.6) — `draft-ietf-jmap-calendars` + JSCalendar (RFC 8984).
 *
 * The shapes asserted here were **measured against Stalwart 0.16**, not transcribed from the
 * draft: a `Calendar/get` and a `CalendarEvent/set` were run against the live fixture and the
 * responses are reproduced below. That matters for a spec still in the RFC Editor queue — the
 * server is the thing this client has to work with.
 */

import { describe, expect, it } from 'vitest'
import { bearer } from './auth'
import { usingForMethods } from './capabilities'
import { JmapClient } from './client'
import { Methods } from './methods'
import { at, jmapPostMock, makeSession } from './test-support'
import type { CalendarEvent, Invocation } from './types/index'

const ACC = 'b'

/** Exactly what the fixture returned for `CalendarEvent/get` after a minimal create. */
const MEASURED_EVENT: CalendarEvent = {
  '@type': 'Event',
  duration: 'PT1H',
  start: '2026-08-20T10:00:00',
  title: 'Probe',
  timeZone: 'Europe/Berlin',
  id: 'b',
  calendarIds: { b: true },
  isDraft: false,
  isOrigin: true,
}

describe('capability wiring', () => {
  it('binds the calendar methods', () => {
    expect(Methods.calendarGet.name).toBe('Calendar/get')
    expect(Methods.calendarEventGet.name).toBe('CalendarEvent/get')
    expect(Methods.calendarEventQuery.name).toBe('CalendarEvent/query')
    expect(Methods.calendarEventSet.name).toBe('CalendarEvent/set')
  })

  it('auto-adds the calendars capability to `using`', () => {
    const using = usingForMethods(['Calendar/get', 'CalendarEvent/query'])
    expect(using).toContain('urn:ietf:params:jmap:calendars')
    expect(using).toContain('urn:ietf:params:jmap:core')
  })
})

describe('the JSCalendar time model', () => {
  it('keeps `start` as a LOCAL date-time, with the zone beside it', () => {
    // The single most consequential property of this format. `2026-08-20T10:00:00` carries no
    // offset; `timeZone` says how to read it. Parsing it as UTC gets every timed event wrong by
    // its offset — and looks correct to anyone testing in London in winter.
    expect(MEASURED_EVENT.start).toBe('2026-08-20T10:00:00')
    expect(MEASURED_EVENT.start).not.toMatch(/[Zz]$|[+-]\d\d:\d\d$/)
    expect(MEASURED_EVENT.timeZone).toBe('Europe/Berlin')
  })

  it('states length as a duration, not an end instant', () => {
    // A duration survives a move across zones and a DST boundary; an end instant does not.
    expect(MEASURED_EVENT.duration).toBe('PT1H')
  })
})

describe('CalendarEvent/query', () => {
  it('asks the SERVER to expand recurrences over a window', async () => {
    // Expanding a rule in local time across DST is the genuinely hard part of calendaring, and the
    // server has already done it. Asking for occurrences is what makes a month view a list.
    const { fetch, calls } = jmapPostMock((body) => {
      const methodResponses: Invocation[] = body.methodCalls.map(([name, , id]) => [
        name,
        {
          accountId: ACC,
          queryState: 'q',
          canCalculateChanges: true,
          position: 0,
          ids: ['eaaaaab'],
        },
        id,
      ])
      return { methodResponses, sessionState: 's0' }
    })
    const client = new JmapClient({ session: makeSession(), auth: bearer('t'), fetch })

    const builder = client.request()
    builder.invoke(Methods.calendarEventQuery, {
      accountId: ACC,
      filter: { after: '2026-08-01T00:00:00Z', before: '2026-09-01T00:00:00Z' },
      expandRecurrences: true,
    })
    await builder.send()

    const [name, args] = at(at(calls, 0).body.methodCalls, 0)
    expect(name).toBe('CalendarEvent/query')
    expect(args).toEqual({
      accountId: ACC,
      filter: { after: '2026-08-01T00:00:00Z', before: '2026-09-01T00:00:00Z' },
      expandRecurrences: true,
    })
  })
})

describe('CalendarEvent/set', () => {
  it('creates with the shape the fixture accepted', async () => {
    const { fetch, calls } = jmapPostMock((body) => {
      const methodResponses: Invocation[] = body.methodCalls.map(([name, , id]) => [
        name,
        { accountId: ACC, oldState: 'a', newState: 'b', created: { e1: { id: 'b' } } },
        id,
      ])
      return { methodResponses, sessionState: 's0' }
    })
    const client = new JmapClient({ session: makeSession(), auth: bearer('t'), fetch })

    const builder = client.request()
    builder.invoke(Methods.calendarEventSet, {
      accountId: ACC,
      create: {
        e1: {
          '@type': 'Event',
          calendarIds: { b: true },
          title: 'Probe',
          start: '2026-08-20T10:00:00',
          duration: 'PT1H',
          timeZone: 'Europe/Berlin',
        },
      },
    })
    await builder.send()

    const [, args] = at(at(calls, 0).body.methodCalls, 0)
    const create = (args as { create: Record<string, CalendarEvent> }).create
    // `calendarIds` is a SET, not a list — an event can sit in several calendars.
    expect(create.e1?.calendarIds).toEqual({ b: true })
    expect(create.e1?.['@type']).toBe('Event')
  })
})
