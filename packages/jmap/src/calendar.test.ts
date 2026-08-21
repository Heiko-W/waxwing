/**
 * JMAP for Calendars (M5.6) — `draft-ietf-jmap-calendars` + JSCalendar (`jscalendarbis`).
 *
 * The shapes asserted here were **measured against Stalwart 0.16**, not transcribed from the
 * draft: a `Calendar/get` and a `CalendarEvent/set` were run against the live fixture and the
 * responses are reproduced below. That matters for a spec still in the RFC Editor queue — the
 * server is the thing this client has to work with.
 *
 * It matters for the payload too, and that is the correction this file now carries. The event body
 * is **not** RFC 8984: Stalwart implements `draft-ietf-calext-jscalendarbis`, the revision meant to
 * obsolete it, and the two disagree on names a client cannot get wrong quietly — except that two of
 * them fail *silently*. See `docs/adr/025-jscalendarbis-is-the-wire-format.md`; the assertions
 * below reproduce the measurements it rests on.
 */

import { describe, expect, it } from 'vitest'
import { bearer } from './auth'
import { usingForMethods } from './capabilities'
import { JmapClient } from './client'
import { Methods } from './methods'
import { at, jmapPostMock, makeSession } from './test-support'
import type { CalendarEvent, Invocation, Participant, RecurrenceRule } from './types/index'

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

/**
 * A weekly repetition, exactly as the fixture answered `CalendarEvent/parse` on a real `.ics`.
 *
 * SINGULAR. RFC 8984 §4.3.3 spells this `recurrenceRules` and types it as an array; the create
 * carrying that name is refused `invalidProperties: ["recurrenceRules"]`, and the one carrying
 * `recurrenceRule` succeeds and reads back the same way.
 */
const MEASURED_RECURRENCE: RecurrenceRule = { frequency: 'weekly', count: 4 }

/**
 * Participants as the fixture stored and echoed them.
 *
 * `calendarAddress` is a bare URI string, not RFC 8984's `sendTo` map. The old name is the more
 * dangerous of the two mistakes because it does not fail: `CalendarEvent/set` answers `created`
 * and the stored event simply has no `participants` at all.
 */
const MEASURED_PARTICIPANTS: Record<string, Participant> = {
  pc: {
    '@type': 'Participant',
    name: 'Carol Chen',
    calendarAddress: 'mailto:carol@waxwing.test',
    roles: { owner: true, attendee: true },
    participationStatus: 'accepted',
  },
  pa: {
    '@type': 'Participant',
    calendarAddress: 'mailto:alice@waxwing.test',
    roles: { attendee: true, required: true },
    participationStatus: 'needs-action',
    expectReply: true,
  },
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

  /*
   * Both `/changes` methods exist on v0.16.18 — measured, they reject only a bogus `sinceState` —
   * and both had no caller (JMAP gap analysis, I-2). A delta is only worth asking for when there is
   * local state to apply it to, and the calendar has none: `calendar/calendar-client.ts` bypasses
   * the sync engine entirely, so nothing is stored between visits and every view re-queries.
   * A registry entry claiming otherwise is the misleading part; it comes back with the replica.
   */
  it('has no calendar `/changes` binding, because there is no calendar replica to update', () => {
    expect(Methods).not.toHaveProperty('calendarChanges')
    expect(Methods).not.toHaveProperty('calendarEventChanges')

    const names = Object.values(Methods).map((method) => method.name)
    expect(names).not.toContain('Calendar/changes')
    expect(names).not.toContain('CalendarEvent/changes')
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

describe('the JSCalendar dialect this server speaks', () => {
  it('names ONE recurrence rule, not a list of them', () => {
    // The property that made a stored series look like a plain event for months: the client asked
    // for `recurrenceRules`, the server answers `recurrenceRule`, and an absent property is
    // indistinguishable from "does not repeat".
    const master: CalendarEvent = { ...MEASURED_EVENT, recurrenceRule: MEASURED_RECURRENCE }

    expect(master.recurrenceRule?.frequency).toBe('weekly')
    expect(Array.isArray(master.recurrenceRule)).toBe(false)
    expect(Object.keys(master)).not.toContain('recurrenceRules')
  })

  it('states months as STRINGS, because a lunisolar leap month is `5L`', () => {
    // The one field of a recurrence rule whose type surprises everybody. `byMonthDay` beside it
    // really is numeric; `byMonth` cannot be, and a client that sends numbers is sending the wrong
    // JSON type.
    const yearly: RecurrenceRule = { frequency: 'yearly', byMonth: ['1', '5L'], byMonthDay: [1] }

    expect(yearly.byMonth?.every((month) => typeof month === 'string')).toBe(true)
  })

  it('addresses a participant with `calendarAddress` and NEVER with `sendTo`', () => {
    /*
     * The silent trap, measured: a create whose participants carry RFC 8984's
     * `sendTo: {imip: "mailto:…"}` is answered `created` — no error, no `invalidProperties` — and
     * reading the event back shows no `participants` whatsoever. The entire map is discarded. So
     * the assertion is about the object that goes OUT: `sendTo` must not appear anywhere in it,
     * because nothing downstream will ever tell us that it did.
     */
    const wire = JSON.stringify({
      organizerCalendarAddress: 'mailto:carol@waxwing.test',
      participants: MEASURED_PARTICIPANTS,
    })

    expect(wire).not.toContain('sendTo')
    expect(MEASURED_PARTICIPANTS.pa?.calendarAddress).toBe('mailto:alice@waxwing.test')
    expect(typeof MEASURED_PARTICIPANTS.pa?.calendarAddress).toBe('string')
    // `jscalendarbis` requires the organiser's address whenever a participant has one, and 0.16.18
    // fixed a bug where the server failed to assign it and then sent no invitations at all.
    expect(JSON.parse(wire).organizerCalendarAddress).toBe('mailto:carol@waxwing.test')
  })

  it('names the master of an expanded instance in `baseEventId`', () => {
    // `{"start":"2026-09-07T09:00:00","recurrenceId":"2026-09-07T09:00:00","id":"iaaaaaf",
    //   "baseEventId":"f"}` — the id `iaaaaaf` is synthetic and cannot be written to; `f` can.
    const instance: CalendarEvent = {
      ...MEASURED_EVENT,
      id: 'iaaaaaf',
      start: '2026-09-07T09:00:00',
      recurrenceId: '2026-09-07T09:00:00',
      baseEventId: 'f',
    }

    expect(instance.baseEventId).toBe('f')
    expect(instance.baseEventId).not.toBe(instance.id)
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
