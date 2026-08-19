/**
 * Snooze (M5.8, FR-ORG-03).
 *
 * The presets are where a snooze feature is quietly wrong: "later today" at 23:00 and "this
 * weekend" on a Sunday both have to mean a time in the future, not one in the past.
 */

import { describe, expect, it } from 'vitest'
import {
  coerceSnoozeMap,
  dueIds,
  SNOOZE_KEYWORD,
  SNOOZE_PRESETS,
  withoutIds,
  withSnoozed,
} from './snooze'

const preset = (id: string) => SNOOZE_PRESETS.find((entry) => entry.id === id)

describe('the stored map', () => {
  it('reads a well-formed map', () => {
    expect(coerceSnoozeMap({ e1: 1000, e2: 2000 })).toEqual({ e1: 1000, e2: 2000 })
  })

  it('is empty for anything that is not an object map', () => {
    for (const value of [null, undefined, [], 'x', 42]) {
      expect(coerceSnoozeMap(value)).toEqual({})
    }
  })

  it('drops entries whose wake time is not a number', () => {
    expect(coerceSnoozeMap({ e1: 'soon', e2: 5 })).toEqual({ e2: 5 })
  })
})

describe('dueIds', () => {
  it('returns what is due, including exactly now', () => {
    expect(dueIds({ a: 90, b: 100, c: 110 }, 100).sort()).toEqual(['a', 'b'])
  })

  it('is empty when nothing is due', () => {
    expect(dueIds({ a: 200 }, 100)).toEqual([])
  })
})

describe('withSnoozed / withoutIds', () => {
  it('adds and removes', () => {
    const map = withSnoozed({}, ['a', 'b'], 500)
    expect(map).toEqual({ a: 500, b: 500 })
    expect(withoutIds(map, ['a'])).toEqual({ b: 500 })
  })
})

describe('presets', () => {
  it('"later today" is three hours on, while that is still today', () => {
    const at = preset('laterToday')?.at(new Date(2026, 7, 19, 9, 0))
    expect(at?.getHours()).toBe(12)
    expect(at?.getDate()).toBe(19)
  })

  it('"later today" at 23:00 falls forward to tomorrow morning, not into the past', () => {
    // Three hours after 23:00 is 02:00 the next day, which is not "later today" in any useful
    // sense — the honest answer is the morning.
    const at = preset('laterToday')?.at(new Date(2026, 7, 19, 23, 0))
    expect(at?.getDate()).toBe(20)
    expect(at?.getHours()).toBe(8)
  })

  it('"tomorrow" is the next morning at eight', () => {
    const at = preset('tomorrow')?.at(new Date(2026, 7, 19, 15, 0))
    expect(at?.getDate()).toBe(20)
    expect(at?.getHours()).toBe(8)
  })

  it('"this weekend" from a Wednesday is the coming Saturday', () => {
    // 19 August 2026 is a Wednesday.
    const at = preset('thisWeekend')?.at(new Date(2026, 7, 19, 10, 0))
    expect(at?.getDay()).toBe(6)
    expect(at?.getDate()).toBe(22)
  })

  it('"this weekend" ON a Saturday means the NEXT one, never today', () => {
    // Otherwise the message would come back the moment it was snoozed.
    const at = preset('thisWeekend')?.at(new Date(2026, 7, 22, 10, 0))
    expect(at?.getDate()).toBe(29)
  })

  it('"next week" is the coming Monday, and never today', () => {
    const fromWednesday = preset('nextWeek')?.at(new Date(2026, 7, 19, 10, 0))
    expect(fromWednesday?.getDay()).toBe(1)
    expect(fromWednesday?.getDate()).toBe(24)

    // 24 August 2026 is itself a Monday.
    const fromMonday = preset('nextWeek')?.at(new Date(2026, 7, 24, 10, 0))
    expect(fromMonday?.getDate()).toBe(31)
  })

  it('every preset lands in the future, from any hour of any day', () => {
    // The property that matters, checked across a whole week and every hour.
    for (let day = 17; day <= 23; day += 1) {
      for (let hour = 0; hour < 24; hour += 1) {
        const now = new Date(2026, 7, day, hour, 30)
        for (const entry of SNOOZE_PRESETS) {
          expect(entry.at(now).getTime()).toBeGreaterThan(now.getTime())
        }
      }
    }
  })
})

describe('the keyword', () => {
  it('is a private-use keyword, so other clients ignore it rather than break', () => {
    expect(SNOOZE_KEYWORD).toBe('$snoozed')
  })
})
