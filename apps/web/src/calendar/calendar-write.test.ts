/**
 * Writing calendar events (M5.11, FR-CAL-01).
 *
 * The load-bearing assertion is the refusal: a recurring event is NOT editable here. Changing one
 * occurrence of a series means choosing between "this one", "this and following" and "all", and an
 * editor that quietly picks one loses other people's time.
 */

import type { CalendarEvent } from '@waxwing/jmap'
import { describe, expect, it } from 'vitest'
import {
  draftToEvent,
  type EventDraft,
  isEditable,
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

describe('isEditable', () => {
  it('allows a plain single event', () => {
    expect(isEditable(event())).toBe(true)
  })

  it('REFUSES an expanded occurrence of a series', () => {
    // The instance the month view shows is not the master; editing it in place would silently
    // become an override on a series the user did not know they were touching.
    expect(isEditable(event({ recurrenceId: '2026-08-20T10:00:00' }))).toBe(false)
  })

  it('REFUSES the master of a series, spelled the way THIS server spells one', () => {
    /*
     * `recurrenceRule`, singular, one object — `draft-ietf-calext-jscalendarbis`, which is what
     * Stalwart implements (ADR-025). This is the assertion the whole correction exists for: before
     * it, `isEditable` looked only for RFC 8984's `recurrenceRules` array, so a weekly meeting's
     * master answered "yes, editable" and a series editor built on that would have written a
     * single-event patch straight onto a series.
     */
    expect(
      isEditable(event({ recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'weekly' } })),
    ).toBe(false)
    // Without the rule it is an ordinary event again — the refusal is the rule, not the fixture.
    expect(isEditable(event({ title: 'Weekly-looking but single' }))).toBe(true)
  })

  it('also REFUSES the RFC 8984 spelling, which it does not ask for', () => {
    // Refusing to edit is the safe direction, so a server that volunteers the old plural array
    // gets the same answer. It is not in EVENT_PROPERTIES, though: asking a jscalendarbis server
    // for `recurrenceRules` is how the master came back looking like a plain event in the first
    // place.
    expect(
      isEditable(event({ recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'weekly' }] })),
    ).toBe(false)
  })

  it('allows an event whose recurrence rule is present but empty', () => {
    // Neither an empty list nor an absent rule is a series; refusing them would make ordinary
    // events uneditable on servers that always emit the property.
    expect(isEditable(event({ recurrenceRules: [] }))).toBe(true)
    expect(isEditable(event())).toBe(true)
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

  it('refuses a series with the SERIES reason, even when it has a write id', () => {
    // The master is writable; that is not the reason it is refused. Editing one occurrence of a
    // series is a decision this editor cannot present, so it never opens.
    expect(refuseEdit(placed({}, { writeId: '7', series: true }))).toBe('series')
  })

  it('refuses an unresolved occurrence with its own reason', () => {
    // Two refusals rather than one, because the sentences differ: this one is not a limit we chose,
    // it is an id we could not trace — and telling the reader "this repeats" would be a lie.
    expect(refuseEdit(placed({}, { writeId: null, series: false }))).toBe('unresolved')
  })

  it('calls a recurring event a series even where identity says nothing', () => {
    expect(
      refuseEdit(placed({ recurrenceId: '2026-08-20T10:00:00' }, { writeId: '0', series: false })),
    ).toBe('series')
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
