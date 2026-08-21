/**
 * Writing calendar events (M5.11, FR-CAL-01).
 *
 * The load-bearing assertion used to be a refusal: a recurring event was not editable at all. Since
 * K-2 it is — what a repeating event needs is not a closed door but a SCOPE, asked after Save. So
 * the assertion moved rather than disappeared: `needsScope` has to be true for every shape a series
 * arrives in, because the failure it guards against (a single-event patch landing on a repeating
 * meeting) is unchanged.
 */

import type { CalendarEvent } from '@waxwing/jmap'
import { describe, expect, it } from 'vitest'
import {
  draftToEvent,
  type EventDraft,
  isSeriesEvent,
  needsScope,
  placeEvent,
  refuseEdit,
} from './calendar-client'
import { alertsFromEvent } from './event-alerts'

const draft = (over: Partial<EventDraft> = {}): EventDraft => ({
  calendarId: 'c1',
  title: 'Review',
  description: '',
  start: '2026-08-20T10:00:00',
  durationMinutes: 60,
  allDay: false,
  timeZone: 'Europe/Berlin',
  ...over,
})

const event = (over: Partial<CalendarEvent> = {}): CalendarEvent =>
  ({ id: 'e1', calendarIds: { c1: true }, start: '2026-08-20T10:00:00', ...over }) as CalendarEvent

describe('isSeriesEvent', () => {
  it('says no to a plain single event', () => {
    expect(isSeriesEvent(event())).toBe(false)
  })

  it('recognises an expanded occurrence of a series', () => {
    // The instance the month view shows is not the master; a patch written to it as if it were a
    // single event is a change to every occurrence the reader did not ask for.
    expect(isSeriesEvent(event({ recurrenceId: '2026-08-20T10:00:00' }))).toBe(true)
  })

  it('recognises the master of a series, spelled the way THIS server spells one', () => {
    /*
     * `recurrenceRule`, singular, one object — `draft-ietf-calext-jscalendarbis`, which is what
     * Stalwart implements (ADR-025). This is the assertion the whole correction exists for: before
     * it, the test looked only for RFC 8984's `recurrenceRules` array, so a weekly meeting's master
     * answered "ordinary event" and a save would have written a single-event patch onto a series.
     */
    expect(
      isSeriesEvent(event({ recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'weekly' } })),
    ).toBe(true)
    // Without the rule it is an ordinary event again — the answer is the rule, not the fixture.
    expect(isSeriesEvent(event({ title: 'Weekly-looking but single' }))).toBe(false)
  })

  it('also recognises the RFC 8984 spelling, which it does not ask for', () => {
    // Treating a series as a series is the safe direction, so a server that volunteers the old
    // plural array gets the same answer. It is not in EVENT_PROPERTIES, though: asking a
    // jscalendarbis server for `recurrenceRules` is how the master came back looking like a plain
    // event in the first place.
    expect(
      isSeriesEvent(event({ recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'weekly' }] })),
    ).toBe(true)
  })

  it('does not call an empty rule a series', () => {
    // Neither an empty list nor an absent rule is a series; treating them as one would put a scope
    // question in front of every ordinary save on servers that always emit the property.
    expect(isSeriesEvent(event({ recurrenceRules: [] }))).toBe(false)
    expect(isSeriesEvent(event())).toBe(false)
  })
})

describe('draftToEvent', () => {
  it('writes the calendar as a SET, the way JSCalendar models it', () => {
    expect(draftToEvent(draft()).calendarIds).toEqual({ c1: true })
  })

  it('states length as a duration, not an end instant', () => {
    expect(draftToEvent(draft({ durationMinutes: 90 })).duration).toBe('PT90M')
  })

  it('never writes a zero-length duration', () => {
    expect(draftToEvent(draft({ durationMinutes: 0 })).duration).toBe('PT1M')
  })

  it('strips the time of day AND the zone from a whole-day event', () => {
    // A whole-day event with a zone moves across a border — the 20th in Berlin is the 19th in
    // Los Angeles. JSCalendar says such an event has neither.
    const allDay = draftToEvent(draft({ allDay: true }))
    expect(allDay.showWithoutTime).toBe(true)
    expect(allDay.timeZone).toBeNull()
    expect(allDay.duration).toBe('P1D')
  })

  it('keeps the zone on a timed event', () => {
    expect(draftToEvent(draft()).timeZone).toBe('Europe/Berlin')
  })

  it('carries a floating event through as floating', () => {
    expect(draftToEvent(draft({ timeZone: null })).timeZone).toBeNull()
  })

  it('CLEARS an emptied description rather than storing an empty string', () => {
    // RFC 8984 patch semantics: `null` removes the property, `""` stores an empty one.
    expect(draftToEvent(draft({ description: '' })).description).toBeNull()
    expect(draftToEvent(draft({ description: 'Agenda' })).description).toBe('Agenda')
  })

  it('sends the local start verbatim, with no offset attached', () => {
    expect(draftToEvent(draft()).start).toBe('2026-08-20T10:00:00')
  })

  it('NAMES no field the editor cannot show, so an update cannot destroy one', () => {
    /*
     * T11's real risk, and the reason it is a display gap rather than a data-loss bug.
     *
     * On an update this object is a JMAP patch: every property it does not mention survives
     * untouched. A location and an attendee list that the dialog cannot yet edit therefore survive
     * a title change — but only for as long as this stays a patch. The day someone turns it into a
     * full event object, saving a renamed meeting silently cancels everyone's attendance.
     */
    const keys = Object.keys(draftToEvent(draft()))
    for (const untouched of [
      'locations',
      'virtualLocations',
      'participants',
      'recurrenceRule',
      'recurrenceRules',
      'recurrenceOverrides',
      'organizerCalendarAddress',
      // Immutable on this server: an update naming it is refused outright.
      'method',
      // Still absent HERE, because this draft names no reminders. It is no longer absent
      // unconditionally — see the K-5 block below for the two ways it may now appear, and for why
      // the condition is the whole safety property.
      'alerts',
      'privacy',
      'freeBusyStatus',
      'uid',
    ]) {
      expect(keys, `${untouched} must not appear in the patch`).not.toContain(untouched)
    }
  })
})

describe('refuseEdit', () => {
  const placed = (
    over: Partial<CalendarEvent>,
    identity: { writeId: string | null; series: boolean },
  ) => placeEvent(event(over), identity)

  it('lets a resolved single event through', () => {
    expect(refuseEdit(placed({}, { writeId: '0', series: false }))).toBeNull()
  })

  it('LETS A SERIES THROUGH now that a scope can be asked for (K-2)', () => {
    // This is the assertion that inverted. The master is writable and the editor can now present the
    // choice, so the door is open — what used to be a refusal is a question asked after Save.
    expect(refuseEdit(placed({}, { writeId: '7', series: true }))).toBeNull()
  })

  it('still refuses an unresolved occurrence', () => {
    // The one refusal left, and it is not a limit we chose: it is an id we could not trace back to
    // a stored object, so the editor's Save is certain to fail. Better a note than a doomed form.
    expect(refuseEdit(placed({}, { writeId: null, series: false }))).toBe('unresolved')
  })
})

describe('needsScope', () => {
  const placed = (
    over: Partial<CalendarEvent>,
    identity: { writeId: string | null; series: boolean },
  ) => placeEvent(event(over), identity)

  it('asks for a scope when identity says series', () => {
    expect(needsScope(placed({}, { writeId: '7', series: true }))).toBe(true)
  })

  it('asks for a scope from the OCCURRENCE alone, where identity says nothing', () => {
    // The master may be outside the fetched window, so the identity index knows nothing about it —
    // and an occurrence that then saved without a scope question would patch the whole series.
    expect(
      needsScope(placed({ recurrenceId: '2026-08-20T10:00:00' }, { writeId: '0', series: false })),
    ).toBe(true)
  })

  it('does not ask for a plain event', () => {
    expect(needsScope(placed({}, { writeId: '0', series: false }))).toBe(false)
  })
})

describe('draftToEvent and reminders (K-5)', () => {
  const EMAIL_1H = {
    '@type': 'Alert' as const,
    action: 'email' as const,
    trigger: { '@type': 'OffsetTrigger' as const, offset: '-PT1H' },
  }

  it('leaves `alerts` OUT of the patch when the draft says nothing about them', () => {
    /*
     * The line between K-5 being an improvement and K-5 being a data-loss bug.
     *
     * On an update this object is a JMAP patch: a property it does not name survives. Writing
     * `alerts` unconditionally — even as `alerts: draft.alerts ?? null` — would mean every save
     * from a caller that does not model reminders deletes every alarm on the event. Before K-5 the
     * property was simply never named, and that accident is what protected them; now the condition
     * has to do it on purpose.
     */
    expect(Object.keys(draftToEvent(draft()))).not.toContain('alerts')
  })

  it('writes `alerts: null` for a list the reader emptied', () => {
    // The other half of the same distinction: `undefined` is "not touched", an empty EventAlerts is
    // "the reader took the reminder off", and only the second one may reach the wire.
    expect(draftToEvent(draft({ alerts: { offsets: [], opaque: {} } })).alerts).toBeNull()
  })

  it('writes the reminder the reader chose', () => {
    const patch = draftToEvent(draft({ alerts: { offsets: ['-PT15M'], opaque: {} } }))
    expect(Object.values(patch.alerts as Record<string, unknown>)).toEqual([
      {
        '@type': 'Alert',
        action: 'display',
        trigger: { '@type': 'OffsetTrigger', offset: '-PT15M', relativeTo: 'start' },
      },
    ])
  })

  it('carries an EMAIL alarm through a title change untouched', () => {
    /*
     * The event has a reminder this client cannot show, cannot set and must not lose. It arrives
     * from `alertsFromEvent`, sits in `opaque`, and comes back out of `alertsToPatch` under the same
     * key and with the same members — so renaming the meeting leaves the alarm exactly where the
     * phone that set it put it.
     */
    const stored = alertsFromEvent({
      id: 'e1',
      calendarIds: { c1: true },
      start: '2026-08-20T10:00:00',
      alerts: { k2: EMAIL_1H },
    } as unknown as CalendarEvent)

    const patch = draftToEvent(draft({ title: 'Review, renamed', alerts: stored }))
    expect((patch.alerts as Record<string, unknown>).k2).toEqual(EMAIL_1H)
  })

  it('keeps that alarm even when the reader clears the reminder they CAN see', () => {
    // The most likely way to lose it: the row the reader can reach is set to "None" and the whole
    // map is rewritten from what the dialog knows. `opaque` is what the dialog does not know.
    const patch = draftToEvent(draft({ alerts: { offsets: [], opaque: { k2: EMAIL_1H } } }))
    expect(patch.alerts).toEqual({ k2: EMAIL_1H })
  })
})
