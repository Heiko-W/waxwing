/**
 * The month grid (M5.6).
 *
 * Pure date arithmetic, and every assertion here is about a case that a naive implementation gets
 * wrong: DST days, month lengths, and the locale's first weekday.
 */

import { describe, expect, it } from 'vitest'
import { addMonths, fromIsoDate, isSameDay, monthGrid, monthRange, toIsoDate } from './month-grid'

describe('monthGrid', () => {
  const august = new Date(2026, 7, 15)
  const today = new Date(2026, 7, 19)

  it('is always six weeks, so the page does not change height between months', () => {
    expect(monthGrid(august, 'de-DE', today)).toHaveLength(42)
    expect(monthGrid(new Date(2026, 1, 1), 'de-DE', today)).toHaveLength(42)
  })

  it('starts on Monday for a locale that does, and Sunday for one that does not', () => {
    const de = monthGrid(august, 'de-DE', today)[0]?.date.getDay()
    const us = monthGrid(august, 'en-US', today)[0]?.date.getDay()
    expect(de).toBe(1)
    expect(us).toBe(0)
  })

  it('marks the neighbouring months as outside', () => {
    const days = monthGrid(august, 'de-DE', today)
    expect(days[0]?.inMonth).toBe(false)
    expect(days.filter((day) => day.inMonth)).toHaveLength(31)
  })

  it('marks today, and only today', () => {
    const days = monthGrid(august, 'de-DE', today)
    expect(days.filter((day) => day.isToday)).toHaveLength(1)
    expect(days.find((day) => day.isToday)?.date.getDate()).toBe(19)
  })

  it('never repeats a date across a DST transition', () => {
    // Europe's clocks go back in October. Building days by adding 86 400 000 ms lands on 23:00 the
    // previous day and the grid shows the same date twice; local-time construction does not.
    const october = new Date(2026, 9, 15)
    const days = monthGrid(october, 'de-DE', today)
    const stamps = days.map((day) => toIsoDate(day.date))
    expect(new Set(stamps).size).toBe(42)
  })
})

describe('monthRange', () => {
  it('covers the whole grid, not just the month', () => {
    // The view shows the neighbouring days, so a fetch of the month alone leaves them empty.
    const { from, to } = monthRange(new Date(2026, 7, 15), 'de-DE')
    expect(from.getMonth()).toBe(6)
    expect(to.getMonth()).toBe(8)
  })
})

describe('toIsoDate / fromIsoDate', () => {
  it('round-trips a local day', () => {
    const date = new Date(2026, 7, 20)
    expect(toIsoDate(date)).toBe('2026-08-20')
    expect(isSameDay(fromIsoDate('2026-08-20') as Date, date)).toBe(true)
  })

  it('rejects a malformed or rolled-over value instead of showing another day', () => {
    // `new Date(2026, 12, 40)` silently becomes 9 January 2027.
    expect(fromIsoDate('2026-13-40')).toBeNull()
    expect(fromIsoDate('tomorrow')).toBeNull()
    expect(fromIsoDate(undefined)).toBeNull()
  })
})

describe('addMonths', () => {
  it('clamps the day rather than rolling into the next month', () => {
    // 31 January + 1 month is 28 February, not 3 March.
    const result = addMonths(new Date(2026, 0, 31), 1)
    expect(result.getMonth()).toBe(1)
    expect(result.getDate()).toBe(28)
  })

  it('goes backwards too', () => {
    expect(addMonths(new Date(2026, 0, 15), -1).getMonth()).toBe(11)
  })
})
