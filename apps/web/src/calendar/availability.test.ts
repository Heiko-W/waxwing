/**
 * Free/busy geometry (S-6) — the arithmetic, without a DOM.
 *
 * The three things that go wrong in a layer like this, and each has a test that fails without the
 * code that prevents it:
 *
 * 1. **Overlaps double the ink.** Two periods covering the same hour, drawn as two translucent
 *    bands, make that hour darker than its neighbour — which reads as "busier". The data contains
 *    no such distinction, so the periods are merged.
 * 2. **A period across midnight belongs to two columns.** Clamped into one, an overnight trip either
 *    overflows its column or vanishes from the second day.
 * 3. **Garbage from another account reaches the style attribute.** An unparseable timestamp becomes
 *    `NaN`, and `blockSize: NaNpx` is a band that either does not render or renders at full height
 *    over the whole day. It is dropped instead.
 */

import type { AvailabilityPeriod } from '@waxwing/jmap'
import { describe, expect, it } from 'vitest'
import { busyBandsForDay, toBusyPeriods } from './availability'

/** A period in LOCAL time, expressed the way the server would: an absolute UTC instant. */
function period(
  startLocal: Date,
  endLocal: Date,
  busyStatus: AvailabilityPeriod['busyStatus'] = 'confirmed',
): AvailabilityPeriod {
  return {
    utcStart: startLocal.toISOString(),
    utcEnd: endLocal.toISOString(),
    busyStatus,
  }
}

const DAY = new Date(2026, 7, 25)
const at = (hour: number, minute = 0): Date => new Date(2026, 7, 25, hour, minute)

describe('toBusyPeriods', () => {
  it('keeps a plain period as it is', () => {
    const periods = toBusyPeriods([period(at(10), at(12))])
    expect(periods).toHaveLength(1)
    expect(periods[0]?.startsAt).toBe(at(10).getTime())
    expect(periods[0]?.endsAt).toBe(at(12).getTime())
  })

  it('merges two periods that overlap into one band', () => {
    const periods = toBusyPeriods([period(at(10), at(12)), period(at(11), at(13))])
    expect(periods).toHaveLength(1)
    expect(periods[0]?.startsAt).toBe(at(10).getTime())
    expect(periods[0]?.endsAt).toBe(at(13).getTime())
  })

  it('merges periods that merely touch — 10–11 and 11–12 is one busy stretch', () => {
    expect(toBusyPeriods([period(at(10), at(11)), period(at(11), at(12))])).toHaveLength(1)
  })

  it('leaves a real gap alone', () => {
    expect(toBusyPeriods([period(at(9), at(10)), period(at(11), at(12))])).toHaveLength(2)
  })

  it('merges regardless of the order they arrive in', () => {
    const periods = toBusyPeriods([period(at(11), at(13)), period(at(10), at(12))])
    expect(periods).toHaveLength(1)
    expect(periods[0]?.startsAt).toBe(at(10).getTime())
  })

  it('keeps the STRONGEST status when two merge, so merging cannot understate', () => {
    const periods = toBusyPeriods([
      period(at(10), at(12), 'tentative'),
      period(at(11), at(13), 'confirmed'),
    ])
    expect(periods[0]?.status).toBe('confirmed')
  })

  it('drops a period whose timestamps do not parse', () => {
    expect(
      toBusyPeriods([{ utcStart: 'not a date', utcEnd: 'nor this', busyStatus: 'confirmed' }]),
    ).toEqual([])
  })

  it('drops a zero-length and a backwards period', () => {
    expect(toBusyPeriods([period(at(10), at(10))])).toEqual([])
    expect(toBusyPeriods([period(at(12), at(10))])).toEqual([])
  })

  it('answers an empty list for an empty answer — "free", not "unknown"', () => {
    expect(toBusyPeriods([])).toEqual([])
  })
})

describe('busyBandsForDay', () => {
  it('places a period at the right minutes from local midnight', () => {
    const bands = busyBandsForDay(toBusyPeriods([period(at(10), at(12))]), DAY)
    expect(bands).toEqual([{ startMinute: 600, endMinute: 720, status: 'confirmed' }])
  })

  it('clamps a period that starts the day before to the top of the column', () => {
    const yesterday = new Date(2026, 7, 24, 22)
    const bands = busyBandsForDay(toBusyPeriods([period(yesterday, at(2))]), DAY)
    expect(bands[0]?.startMinute).toBe(0)
    expect(bands[0]?.endMinute).toBe(120)
  })

  it('gives a period across midnight a band in EACH day it touches', () => {
    const periods = toBusyPeriods([period(at(22), new Date(2026, 7, 26, 2))])
    expect(busyBandsForDay(periods, DAY)[0]).toEqual({
      startMinute: 1320,
      endMinute: 1440,
      status: 'confirmed',
    })
    expect(busyBandsForDay(periods, new Date(2026, 7, 26))[0]).toEqual({
      startMinute: 0,
      endMinute: 120,
      status: 'confirmed',
    })
  })

  it('is half-open: a period ending exactly at midnight is the day before’s alone', () => {
    const periods = toBusyPeriods([period(at(22), new Date(2026, 7, 26))])
    expect(busyBandsForDay(periods, DAY)).toHaveLength(1)
    expect(busyBandsForDay(periods, new Date(2026, 7, 26))).toEqual([])
  })

  it('draws nothing on a day the person is free', () => {
    expect(busyBandsForDay(toBusyPeriods([period(at(10), at(12))]), new Date(2026, 7, 26))).toEqual(
      [],
    )
  })

  it('never produces a NaN or a negative height', () => {
    const bands = busyBandsForDay(toBusyPeriods([period(at(9), at(17))]), DAY)
    for (const band of bands) {
      expect(Number.isFinite(band.startMinute)).toBe(true)
      expect(band.endMinute).toBeGreaterThan(band.startMinute)
    }
  })
})
