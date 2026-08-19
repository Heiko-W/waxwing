/**
 * Week/day layout (M5.13, FR-CAL-01).
 *
 * Overlap is the whole difficulty of a time-axis view: two meetings at the same hour must share
 * the width rather than hide each other, and a later one that overlaps neither must not be
 * squeezed for the rest of the day.
 */

import { describe, expect, it } from 'vitest'
import { layoutDay, overlapsDay, weekDays, weekRange } from './week-grid'

const DAY = new Date(2026, 7, 19)
/** An event on 19 August 2026, given local hours. */
const at = (fromHour: number, toHour: number, item = `${fromHour}-${toHour}`) => ({
  item,
  startsAt: new Date(2026, 7, 19, fromHour).getTime(),
  endsAt: new Date(2026, 7, 19, toHour).getTime(),
})

describe('overlapsDay', () => {
  it('includes an event inside the day', () => {
    expect(overlapsDay(at(9, 10).startsAt, at(9, 10).endsAt, DAY)).toBe(true)
  })

  it('includes one that starts the day before and runs into it', () => {
    const start = new Date(2026, 7, 18, 22).getTime()
    const end = new Date(2026, 7, 19, 2).getTime()
    expect(overlapsDay(start, end, DAY)).toBe(true)
  })

  it('EXCLUDES one that ends exactly at midnight', () => {
    // Half-open: otherwise a meeting ending at 00:00 appears on both days, which reads as two.
    const start = new Date(2026, 7, 18, 22).getTime()
    const end = new Date(2026, 7, 19, 0).getTime()
    expect(overlapsDay(start, end, DAY)).toBe(false)
  })
})

describe('layoutDay', () => {
  it('gives a lone event the full width', () => {
    const [slot] = layoutDay([at(9, 10)], DAY)
    expect(slot?.column).toBe(0)
    expect(slot?.columns).toBe(1)
  })

  it('places an event at the right minutes from midnight', () => {
    const [slot] = layoutDay([at(9, 10)], DAY)
    expect(slot?.startMinute).toBe(540)
    expect(slot?.endMinute).toBe(600)
  })

  it('splits the width between two overlapping events', () => {
    const slots = layoutDay([at(9, 11), at(10, 12)], DAY)
    expect(slots.map((slot) => slot.column)).toEqual([0, 1])
    expect(slots.every((slot) => slot.columns === 2)).toBe(true)
  })

  it('does NOT squeeze a later, non-overlapping event', () => {
    // Two at nine, one at four. The afternoon meeting is its own cluster and gets the full width;
    // a naive "widest of the day" would give it a third for no reason.
    const slots = layoutDay([at(9, 11), at(10, 12), at(16, 17)], DAY)
    expect(slots[2]?.columns).toBe(1)
    expect(slots[0]?.columns).toBe(2)
  })

  it('reuses a column once its event has ended', () => {
    // 9–10 and 10–11 do not overlap, so the second takes the first's column back.
    const slots = layoutDay([at(9, 10), at(10, 11)], DAY)
    expect(slots.map((slot) => slot.column)).toEqual([0, 0])
  })

  it('handles three at once', () => {
    const slots = layoutDay([at(9, 12), at(9, 12), at(9, 12)], DAY)
    expect(slots.map((slot) => slot.column)).toEqual([0, 1, 2])
    expect(slots.every((slot) => slot.columns === 3)).toBe(true)
  })

  it('clamps an event that began the day before to midnight', () => {
    const slots = layoutDay(
      [
        {
          item: 'overnight',
          startsAt: new Date(2026, 7, 18, 22).getTime(),
          endsAt: new Date(2026, 7, 19, 2).getTime(),
        },
      ],
      DAY,
    )
    expect(slots[0]?.startMinute).toBe(0)
    expect(slots[0]?.endMinute).toBe(120)
  })

  it('gives a zero-length event a minimum height, so it stays clickable', () => {
    const slots = layoutDay([at(9, 9)], DAY)
    expect((slots[0]?.endMinute ?? 0) - (slots[0]?.startMinute ?? 0)).toBeGreaterThanOrEqual(15)
  })

  it('drops events belonging to another day', () => {
    const other = {
      item: 'x',
      startsAt: new Date(2026, 7, 21, 9).getTime(),
      endsAt: new Date(2026, 7, 21, 10).getTime(),
    }
    expect(layoutDay([other], DAY)).toEqual([])
  })
})

describe('weekDays', () => {
  it('starts on the given weekday and runs seven days', () => {
    const monday = weekDays(DAY, 1)
    expect(monday).toHaveLength(7)
    expect(monday[0]?.getDay()).toBe(1)
    expect(monday[0]?.getDate()).toBe(17)
  })

  it('honours a Sunday-first locale', () => {
    expect(weekDays(DAY, 0)[0]?.getDay()).toBe(0)
  })

  it('never repeats a date across a DST transition', () => {
    // Late October, when Europe's clocks go back.
    const days = weekDays(new Date(2026, 9, 27), 1)
    expect(new Set(days.map((day) => day.getDate())).size).toBe(7)
  })
})

describe('weekRange', () => {
  it('covers the whole week, half-open', () => {
    const { from, to } = weekRange(DAY, 1)
    expect(from.getDate()).toBe(17)
    // Exclusive end: the day after Sunday the 23rd.
    expect(to.getDate()).toBe(24)
  })
})
