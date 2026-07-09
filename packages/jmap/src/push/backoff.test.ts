import { describe, expect, it } from 'vitest'
import { Backoff, DEFAULT_BACKOFF } from './backoff'

describe('Backoff', () => {
  it('grows the window exponentially with full jitter', () => {
    // random() fixed at 1 ⇒ delay == the full window == initial · factor^attempt.
    const backoff = new Backoff({
      initialDelay: 100,
      factor: 2,
      maxDelay: 100_000,
      random: () => 1,
    })
    expect(backoff.next()).toBe(100) // attempt 0: 100 · 2^0
    expect(backoff.next()).toBe(200) // attempt 1: 100 · 2^1
    expect(backoff.next()).toBe(400) // attempt 2
    expect(backoff.next()).toBe(800) // attempt 3
  })

  it('applies full jitter within [0, window)', () => {
    const backoff = new Backoff({ initialDelay: 1000, factor: 2, random: () => 0.5 })
    expect(backoff.next()).toBe(500) // floor(0.5 · 1000)
    expect(backoff.next()).toBe(1000) // floor(0.5 · 2000)
  })

  it('never returns a negative delay (random at 0)', () => {
    const backoff = new Backoff({ random: () => 0 })
    expect(backoff.next()).toBe(0)
    expect(backoff.next()).toBe(0)
  })

  it('caps the window at maxDelay', () => {
    const backoff = new Backoff({ initialDelay: 1000, factor: 10, maxDelay: 5000, random: () => 1 })
    expect(backoff.next()).toBe(1000) // 1000
    expect(backoff.next()).toBe(5000) // 10000 capped to 5000
    expect(backoff.next()).toBe(5000) // capped
  })

  it('reset() returns the sequence to the start', () => {
    const backoff = new Backoff({ initialDelay: 100, factor: 2, random: () => 1 })
    backoff.next()
    backoff.next()
    expect(backoff.attempts).toBe(2)
    backoff.reset()
    expect(backoff.attempts).toBe(0)
    expect(backoff.next()).toBe(100)
  })

  it('uses the documented defaults', () => {
    expect(DEFAULT_BACKOFF).toEqual({ initialDelay: 1000, maxDelay: 30_000, factor: 2 })
    const backoff = new Backoff({ random: () => 1 })
    expect(backoff.next()).toBe(1000)
  })
})
