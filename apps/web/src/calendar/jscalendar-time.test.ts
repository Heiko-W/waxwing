/**
 * JSCalendar local-time handling (M5.6).
 *
 * These are the assertions that separate a calendar which is right for everyone from one that is
 * right for whoever wrote it. The DST cases matter most: they are the ones that pass in July and
 * fail in November.
 */

import { describe, expect, it } from 'vitest'
import { durationToMs, localToInstant, parseLocal, zoneDiffersFromLocal } from './jscalendar-time'

describe('parseLocal', () => {
  it('reads a full local date-time', () => {
    expect(parseLocal('2026-08-20T10:00:00')).toEqual({
      year: 2026,
      month: 8,
      day: 20,
      hour: 10,
      minute: 0,
      second: 0,
    })
  })

  it('defaults the time part of a date-only value', () => {
    expect(parseLocal('2026-08-20')?.hour).toBe(0)
  })

  it('returns null rather than a wrong answer for nonsense', () => {
    expect(parseLocal('not a date')).toBeNull()
    expect(parseLocal('')).toBeNull()
  })
})

describe('localToInstant', () => {
  it('reads a summer time correctly (Berlin is UTC+2 in August)', () => {
    // 10:00 in Berlin on 20 August 2026 is 08:00 UTC.
    const instant = localToInstant('2026-08-20T10:00:00', 'Europe/Berlin')
    expect(new Date(instant as number).toISOString()).toBe('2026-08-20T08:00:00.000Z')
  })

  it('reads a WINTER time correctly (Berlin is UTC+1 in January)', () => {
    // The case a summer-only test never reaches: the same wall clock, one hour earlier in UTC.
    const instant = localToInstant('2026-01-20T10:00:00', 'Europe/Berlin')
    expect(new Date(instant as number).toISOString()).toBe('2026-01-20T09:00:00.000Z')
  })

  it('handles a zone on the other side of the world', () => {
    // 09:00 in Auckland on 1 July 2026 (NZST, UTC+12) is 21:00 UTC the day BEFORE.
    const instant = localToInstant('2026-07-01T09:00:00', 'Pacific/Auckland')
    expect(new Date(instant as number).toISOString()).toBe('2026-06-30T21:00:00.000Z')
  })

  it('handles a half-hour offset', () => {
    // Kolkata is UTC+5:30 — an offset a naive hour-based conversion gets wrong.
    const instant = localToInstant('2026-08-20T10:00:00', 'Asia/Kolkata')
    expect(new Date(instant as number).toISOString()).toBe('2026-08-20T04:30:00.000Z')
  })

  it('treats a missing zone as floating, in the reader’s own zone', () => {
    const instant = localToInstant('2026-08-20T10:00:00', null)
    const asLocal = new Date(2026, 7, 20, 10, 0, 0).getTime()
    expect(instant).toBe(asLocal)
  })

  it('falls back to floating for an unknown zone instead of throwing', () => {
    expect(localToInstant('2026-08-20T10:00:00', 'Mars/Olympus_Mons')).not.toBeNull()
  })

  it('returns null for an unparseable value, so it cannot sort to 1970', () => {
    expect(localToInstant('later', 'Europe/Berlin')).toBeNull()
  })
})

describe('durationToMs', () => {
  it('reads the forms JSCalendar events use', () => {
    expect(durationToMs('PT1H')).toBe(3_600_000)
    expect(durationToMs('PT30M')).toBe(1_800_000)
    expect(durationToMs('P1D')).toBe(86_400_000)
    expect(durationToMs('P1W')).toBe(604_800_000)
    expect(durationToMs('PT1H30M')).toBe(5_400_000)
  })

  it('is zero for a missing or malformed duration', () => {
    expect(durationToMs(null)).toBe(0)
    expect(durationToMs('an hour')).toBe(0)
  })
})

describe('zoneDiffersFromLocal', () => {
  it('is false for a floating event', () => {
    expect(zoneDiffersFromLocal(null)).toBe(false)
    expect(zoneDiffersFromLocal('')).toBe(false)
  })

  it('is true for a zone the reader is not in', () => {
    const mine = Intl.DateTimeFormat().resolvedOptions().timeZone
    const other = mine === 'Pacific/Auckland' ? 'Europe/Berlin' : 'Pacific/Auckland'
    expect(zoneDiffersFromLocal(other)).toBe(true)
  })
})
