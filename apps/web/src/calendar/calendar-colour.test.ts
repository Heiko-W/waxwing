/**
 * The derived calendar colour (#79).
 *
 * The defect this file pins is not a crash — it is a screen that looks finished and says nothing.
 * Measured against the fixture before this existed: both accounts' default calendars come back from
 * `Calendar/get` with no colour, so the merged grid drew alice's appointments and carol's in the
 * same neutral chip. On a phone, where the title truncates to three characters, that leaves the
 * reader with no way at all to tell whose afternoon they are looking at.
 */

import type { Calendar } from '@waxwing/jmap'
import { describe, expect, it } from 'vitest'
import { CALENDAR_COLORS } from './CalendarDialog'
import { calendarColor } from './calendar-colour'

const calendar = (id: string, over: Partial<Calendar> = {}): Calendar =>
  ({ id, name: id, ...over }) as Calendar

const PALETTE = CALENDAR_COLORS.map((entry) => entry.value)

describe('calendarColor', () => {
  it('keeps the calendar’s own colour, always', () => {
    // The owner chose it — on a shared calendar it is not even the reader's to override.
    expect(calendarColor('a', calendar('c1', { color: '#123456' }))).toBe('#123456')
  })

  it('THE ONE: a calendar with no colour still gets one, from the palette', () => {
    // Without this the whole feature is invisible on the commonest setup there is: a server that
    // never sets `color`, which is what Stalwart's default calendar does.
    const derived = calendarColor('a', calendar('c1'))
    expect(PALETTE).toContain(derived)
  })

  it('gives the same calendar the same colour every time', () => {
    /*
     * Stability is the whole value. The lists arrive from several accounts over several round trips
     * that finish in whatever order the network decides, so anything derived from ARRIVAL — a
     * running index, a position in a merged list — would repaint the same calendar differently
     * between two loads of one screen. A colour that moves is worse than no colour: it teaches a
     * mapping and then breaks it.
     */
    const first = calendarColor('a', calendar('c1'))
    for (let i = 0; i < 20; i += 1) expect(calendarColor('a', calendar('c1'))).toBe(first)
  })

  it('does not collide two accounts that both call a calendar `c1` (ADR-018)', () => {
    /*
     * The id collision this feature exists for. JMAP calendar ids are per-account and short, so two
     * accounts meeting on `c1` is routine rather than unlucky — and the one thing the merged grid
     * must never do is paint a group's calendar in the reader's own colour.
     *
     * Asserted over many pairs rather than one, because a single pair could differ by luck.
     */
    const collisions = Array.from({ length: 40 }, (_, i) => i).filter(
      (i) =>
        calendarColor(`acc${i}`, calendar('c1')) === calendarColor(`other${i}`, calendar('c1')),
    )
    // With eight colours a chance match is expected in roughly one pair in eight; what must not
    // happen is EVERY pair matching, which is what ignoring the account id looks like.
    expect(collisions.length).toBeLessThan(20)
  })

  it('spreads calendars of one account across the palette', () => {
    // A hash that answered the same colour for everything would pass every test above.
    const used = new Set(
      Array.from({ length: 24 }, (_, i) => calendarColor('a', calendar(`cal-${i}`))),
    )
    expect(used.size).toBeGreaterThan(3)
  })

  it('treats an empty colour string as no colour', () => {
    // A server that sends `""` means "unset"; drawing an empty custom property paints nothing.
    expect(PALETTE).toContain(calendarColor('a', calendar('c1', { color: '' })))
  })
})
