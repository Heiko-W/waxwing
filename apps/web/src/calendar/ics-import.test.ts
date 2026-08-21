/**
 * Reading a `.ics` into events (K-4, FR-CAL-01).
 *
 * **The assertion that matters is a count.** `CalendarEvent/parse` answers an ARRAY per blob, and a
 * client that reads it as an object keeps the first event and loses every other one — with no error
 * anywhere, on a file the reader watched themselves pick. The fixture below is the verbatim answer
 * v0.16.18 gave for a two-VEVENT `.ics` on 21.08.2026, and the test says: two rows.
 *
 * The second is the strip list. `method` is measured immutable on CREATE as well as on update
 * (`"This property is immutable."`), so a parsed invitation — which always carries
 * `method: "request"` — fails the whole create if it is left in.
 */

import { describe, expect, it } from 'vitest'
import { candidatesFrom, createsFor, outcomeFrom } from './ics-import'

/**
 * `parsed[blobId]` exactly as Stalwart v0.16.18 answered it for a VCALENDAR holding two VEVENTs:
 * a timed, repeating, invited one and a whole-day one.
 */
const PARSED = [
  {
    '@type': 'Event',
    uid: 'probe-1@waxwing.test',
    title: 'Erster Termin',
    start: '2026-11-01T10:00:00',
    timeZone: 'Europe/Berlin',
    duration: 'PT1H',
    updated: '2026-08-01T10:00:00Z',
    method: 'request',
    organizerCalendarAddress: 'mailto:kx1@waxwing.test',
    recurrenceRule: { frequency: 'weekly', count: 3 },
    locations: { 'e9a8bfce-00de-59cb-8906-5be5d868206c': { '@type': 'Location', name: 'Raum 1' } },
    participants: {
      '869f4b19-1cd7-5423-a40a-4d6ba04525a7': {
        '@type': 'Participant',
        calendarAddress: 'mailto:kx2@waxwing.test',
        participationStatus: 'needs-action',
      },
    },
    iCalendar: { convertedProperties: { duration: { name: 'dtend' } }, name: 'vevent' },
  },
  {
    '@type': 'Event',
    uid: 'probe-2@waxwing.test',
    title: 'Zweiter Termin',
    description: 'Ganztaegig',
    start: '2026-11-05T00:00:00',
    duration: 'P1D',
    showWithoutTime: true,
    updated: '2026-08-01T10:00:00Z',
    method: 'request',
    iCalendar: {
      convertedProperties: { start: { parameters: { value: 'DATE' } } },
      name: 'vevent',
    },
  },
]

describe('candidatesFrom', () => {
  it('gives TWO rows for a blob holding two VEVENTs', () => {
    // The whole point. `parsed[blobId]` is an array; a client typed for an object drops the second
    // event silently, and the reader finds out weeks later by not being at a meeting.
    const rows = candidatesFrom(PARSED)
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.title)).toEqual(['Erster Termin', 'Zweiter Termin'])
  })

  it('reads the facts the preview shows, including that one of them repeats', () => {
    // "1 event" that is really a weekly meeting for a year is a surprise the reader should get
    // before the import, not after.
    const [first, second] = candidatesFrom(PARSED)
    expect(first?.repeats).toBe(true)
    expect(first?.uid).toBe('probe-1@waxwing.test')
    expect(second?.allDay).toBe(true)
    expect(second?.repeats).toBe(false)
  })

  it('strips exactly what a create may not carry — and keeps `uid`', () => {
    /*
     * `method` is the one that is not a judgement call: measured refused on create with
     * `"This property is immutable."`, and every parsed VEVENT of an invitation carries it. `uid`
     * is kept for the opposite reason — it is what turns a second import of the same file into a
     * per-object refusal the importer can report as "already there".
     */
    const [first] = candidatesFrom(PARSED)
    expect(first?.event).not.toHaveProperty('method')
    expect(first?.event).not.toHaveProperty('iCalendar')
    expect(first?.event).not.toHaveProperty('updated')
    expect(first?.event.uid).toBe('probe-1@waxwing.test')
    // What the server understood stays: an imported meeting keeps its room and its attendees.
    expect(first?.event).toHaveProperty('locations')
    expect(first?.event).toHaveProperty('participants')
    expect(first?.event).toHaveProperty('recurrenceRule')
  })

  it('tolerates a single object and refuses to guess at anything else', () => {
    // The array is what this server sends; accepting a bare object costs three lines and keeps a
    // server that sends one working. Anything else is no events, not a crash.
    expect(candidatesFrom(PARSED[0])).toHaveLength(1)
    expect(candidatesFrom(null)).toHaveLength(0)
    expect(candidatesFrom('nonsense')).toHaveLength(0)
  })
})

describe('createsFor', () => {
  it('puts every chosen event in the target calendar and nowhere else', () => {
    const creates = createsFor(candidatesFrom(PARSED), 'cal-9')
    expect(Object.keys(creates)).toHaveLength(2)
    for (const payload of Object.values(creates)) {
      expect(payload.calendarIds).toEqual({ 'cal-9': true })
    }
  })
})

describe('outcomeFrom', () => {
  it('counts a duplicate `uid` as a SKIP, not as a failure', () => {
    /*
     * Importing the same file twice is what people do, because they cannot remember whether they
     * did. The server answers per object — `{"type":"invalidProperties","properties":["uid"],
     * "description":"An event with UID probe-1@waxwing.test already exists."}` — so the importer can
     * say "1 added, 1 already there". Calling that an error teaches the reader to distrust an
     * importer that is working exactly as intended.
     */
    expect(
      outcomeFrom({
        created: { i0: { id: 'g' } },
        notCreated: {
          i1: {
            type: 'invalidProperties',
            description: 'An event with UID probe-2@waxwing.test already exists.',
            properties: ['uid'],
          },
        },
      }),
    ).toEqual({ added: 1, duplicates: 1, failed: 0, reason: null })
  })

  it('keeps the server’s own sentence for a refusal that is not a duplicate', () => {
    // T7's lesson: the server said why, and the client dropped it on the floor.
    expect(
      outcomeFrom({
        created: null,
        notCreated: {
          i0: {
            type: 'invalidProperties',
            description: 'This property is immutable.',
            properties: ['method'],
          },
        },
      }),
    ).toEqual({ added: 0, duplicates: 0, failed: 1, reason: 'This property is immutable.' })
  })
})
