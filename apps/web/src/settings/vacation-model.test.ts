/**
 * The vacation responder's pure half (M3.7, FR-VAC-01).
 *
 * **No test here hardcodes a UTC offset.** CI does not run in the author's timezone, and a fixed
 * `+02:00` would make these tests a statement about Berlin rather than about the code. Expectations
 * are derived from `Date` itself — which is exactly the conversion under test, so the assertions are
 * round-trips and boundary checks rather than string comparisons.
 */

import type { VacationResponse } from '@waxwing/jmap'
import { describe, expect, it } from 'vitest'
import {
  localInputToUtc,
  toDraft,
  toPatch,
  utcToLocalInput,
  type VacationDraft,
  vacationStatus,
  validateVacation,
} from './vacation-model'

const draft = (over: Partial<VacationDraft> = {}): VacationDraft => ({
  isEnabled: false,
  fromLocal: '',
  toLocal: '',
  subject: '',
  bodyHtml: '',
  ...over,
})

describe('datetime-local ⇄ UTC', () => {
  it('round-trips a local wall-clock value through UTC and back', () => {
    const local = '2026-07-13T09:30'
    const utc = localInputToUtc(local)
    expect(utc).not.toBeNull()
    expect(utcToLocalInput(utc)).toBe(local)
  })

  it('reads the input in the BROWSER’s zone, not as UTC', () => {
    // The whole point: "away from 09:30" means 09:30 where the user is. `new Date('…T09:30')` is
    // local by definition, so the UTC instant differs from the naive string by exactly the offset —
    // whatever that offset happens to be on the machine running this test.
    const utc = localInputToUtc('2026-07-13T09:30')
    const expected = new Date(2026, 6, 13, 9, 30).toISOString()
    expect(utc).toBe(expected)
  })

  it('treats an empty field as "no bound", both ways', () => {
    expect(localInputToUtc('')).toBeNull()
    expect(localInputToUtc('   ')).toBeNull()
    expect(utcToLocalInput(null)).toBe('')
    expect(utcToLocalInput('')).toBe('')
  })

  it('does not throw on garbage — it says "no bound"', () => {
    expect(localInputToUtc('not-a-date')).toBeNull()
    expect(utcToLocalInput('not-a-date')).toBe('')
  })
})

describe('toDraft', () => {
  it('maps the wire nulls onto empty form fields', () => {
    const wire: VacationResponse = {
      id: 'singleton',
      isEnabled: true,
      fromDate: null,
      toDate: null,
      subject: null,
      textBody: null,
      htmlBody: null,
    }
    expect(toDraft(wire)).toEqual({
      isEnabled: true,
      fromLocal: '',
      toLocal: '',
      subject: '',
      bodyHtml: '',
    })
  })
})

describe('toPatch', () => {
  it('sends null — not "" — for an empty subject and body', () => {
    // `""` would be an INSTRUCTION: "auto-reply with a blank subject". `null` means "server, you
    // decide", which is what an empty field actually means.
    expect(toPatch(draft({ isEnabled: true }))).toMatchObject({
      isEnabled: true,
      subject: null,
      htmlBody: null,
      textBody: null,
      fromDate: null,
      toDate: null,
    })
  })

  it('writes BOTH body alternatives, deriving the text from the HTML', () => {
    // A responder that only sent HTML would be unreadable to a plain-text client.
    const patch = toPatch(draft({ bodyHtml: '<p>Back on Monday</p>', subject: '  Away  ' }))
    expect(patch.htmlBody).toContain('Back on Monday')
    expect(patch.textBody).toContain('Back on Monday')
    expect(patch.subject).toBe('Away')
  })

  it('treats a body of empty markup as no body at all', () => {
    expect(toPatch(draft({ bodyHtml: '<p><br></p>' }))).toMatchObject({
      htmlBody: null,
      textBody: null,
    })
  })
})

describe('validateVacation', () => {
  it('rejects an end at or before the start', () => {
    expect(
      validateVacation(draft({ fromLocal: '2026-07-13T09:00', toLocal: '2026-07-12T09:00' })),
    ).toBe('endBeforeStart')
    expect(
      validateVacation(draft({ fromLocal: '2026-07-13T09:00', toLocal: '2026-07-13T09:00' })),
    ).toBe('endBeforeStart')
  })

  it('accepts an open-ended range, and a correctly ordered one', () => {
    expect(validateVacation(draft({ fromLocal: '2026-07-13T09:00' }))).toBeNull()
    expect(validateVacation(draft({ toLocal: '2026-07-13T09:00' }))).toBeNull()
    expect(
      validateVacation(draft({ fromLocal: '2026-07-13T09:00', toLocal: '2026-07-20T09:00' })),
    ).toBeNull()
  })
})

describe('vacationStatus', () => {
  const now = new Date(2026, 6, 13, 12, 0).getTime()
  const localAt = (y: number, m: number, d: number): string =>
    utcToLocalInput(new Date(y, m, d, 12, 0).toISOString())

  it('is off when the switch is off, whatever the dates say', () => {
    expect(vacationStatus(draft({ fromLocal: localAt(2026, 6, 1) }), now)).toBe('off')
  })

  it('is active with no bounds, or inside them', () => {
    expect(vacationStatus(draft({ isEnabled: true }), now)).toBe('active')
    expect(
      vacationStatus(
        draft({ isEnabled: true, fromLocal: localAt(2026, 6, 10), toLocal: localAt(2026, 6, 20) }),
        now,
      ),
    ).toBe('active')
  })

  it('is scheduled before the start, and expired after the end', () => {
    expect(vacationStatus(draft({ isEnabled: true, fromLocal: localAt(2026, 6, 20) }), now)).toBe(
      'scheduled',
    )
    expect(vacationStatus(draft({ isEnabled: true, toLocal: localAt(2026, 6, 1) }), now)).toBe(
      'expired',
    )
  })
})
