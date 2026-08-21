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

  it('REFUSES the master of a series', () => {
    expect(
      isEditable(event({ recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'weekly' }] })),
    ).toBe(false)
  })

  it('allows an event whose recurrenceRules is present but empty', () => {
    // An empty list is not a series; refusing it would make ordinary events uneditable on servers
    // that always emit the property.
    expect(isEditable(event({ recurrenceRules: [] }))).toBe(true)
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
      'recurrenceRules',
      'recurrenceOverrides',
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
