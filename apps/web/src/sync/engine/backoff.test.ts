import { describe, expect, it } from 'vitest'
import {
  backoffDelayMs,
  clampRetryAfter,
  DEFAULT_OUTBOX_BACKOFF,
  RETRY_AFTER_CAP_MS,
} from './backoff'

describe('backoffDelayMs', () => {
  it('doubles the window per attempt (measured at jitter=0, i.e. window/2)', () => {
    expect(backoffDelayMs(1, 0)).toBe(1_000) // window 2 s
    expect(backoffDelayMs(2, 0)).toBe(2_000) // window 4 s
    expect(backoffDelayMs(3, 0)).toBe(4_000) // window 8 s
    expect(backoffDelayMs(4, 0)).toBe(8_000)
  })

  it('is half-jittered: the delay stays inside [w/2, w) and is never zero', () => {
    for (const attempts of [1, 2, 5, 9]) {
      const window = Math.min(
        DEFAULT_OUTBOX_BACKOFF.capMs,
        DEFAULT_OUTBOX_BACKOFF.baseMs * DEFAULT_OUTBOX_BACKOFF.factor ** (attempts - 1),
      )
      const low = backoffDelayMs(attempts, 0)
      const high = backoffDelayMs(attempts, 0.999)
      expect(low).toBe(window / 2)
      expect(high).toBeLessThan(window)
      expect(high).toBeGreaterThan(low)
      expect(backoffDelayMs(attempts, 0.5)).toBeGreaterThan(0)
    }
  })

  it('never grows past the cap, however many attempts have failed', () => {
    expect(backoffDelayMs(50, 0.999)).toBeLessThanOrEqual(DEFAULT_OUTBOX_BACKOFF.capMs)
    // `factor ** (n-1)` overflows to Infinity long before this; the cap must still hold.
    expect(backoffDelayMs(5000, 0.999)).toBeLessThanOrEqual(DEFAULT_OUTBOX_BACKOFF.capMs)
    expect(backoffDelayMs(5000, 0)).toBe(DEFAULT_OUTBOX_BACKOFF.capMs / 2)
  })

  it('grows monotonically for a fixed jitter', () => {
    let previous = 0
    for (let attempts = 1; attempts <= 12; attempts += 1) {
      const delay = backoffDelayMs(attempts, 0.25)
      expect(delay).toBeGreaterThanOrEqual(previous)
      previous = delay
    }
  })

  it('treats attempts 0 (or negative) as the first attempt rather than collapsing to no delay', () => {
    expect(backoffDelayMs(0, 0)).toBe(backoffDelayMs(1, 0))
    expect(backoffDelayMs(-3, 0)).toBe(backoffDelayMs(1, 0))
  })

  it('honours a custom curve', () => {
    expect(backoffDelayMs(3, 0, { baseMs: 100, factor: 3, capMs: 10_000 })).toBe(450) // 900/2
    expect(backoffDelayMs(9, 0, { baseMs: 100, factor: 3, capMs: 10_000 })).toBe(5_000) // capped
  })
})

describe('clampRetryAfter', () => {
  it('clamps a hostile or mis-set Retry-After into a sane range', () => {
    expect(clampRetryAfter(30_000)).toBe(30_000)
    expect(clampRetryAfter(-5)).toBe(0)
    expect(clampRetryAfter(3_600_000)).toBe(RETRY_AFTER_CAP_MS) // an hour → 15 min
    expect(clampRetryAfter(Number.POSITIVE_INFINITY)).toBe(RETRY_AFTER_CAP_MS)
    expect(clampRetryAfter(Number.NaN)).toBe(RETRY_AFTER_CAP_MS)
  })
})
