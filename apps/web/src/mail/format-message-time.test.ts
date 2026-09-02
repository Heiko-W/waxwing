import { describe, expect, it } from 'vitest'
import { formatMessageTime, parseReceivedAt } from './format-message-time'

/**
 * The date a non-conforming server can send (R-09).
 *
 * `Intl.DateTimeFormat.format` throws a `RangeError` on an `Invalid Date`, and this function runs
 * once per rendered row — so a single malformed envelope used to take the mail route into the error
 * boundary and keep it there, because the row stays in the replica until it is evicted.
 *
 * TWO classes, and the quiet one is the reason a `try/catch` would not have been enough: `undefined`,
 * `''`, a non-ISO string and an out-of-range one all THROW, while `null` and a bare number are
 * silently the epoch and render a confident "Jan 1, 1970" over mail that has no usable date at all.
 */
describe('parseReceivedAt', () => {
  const NOW = Date.parse('2026-09-01T12:00:00Z')

  it('accepts the shape RFC 8621 actually specifies', () => {
    expect(parseReceivedAt('2026-09-01T10:00:00Z')?.toISOString()).toBe('2026-09-01T10:00:00.000Z')
  })

  it.each([
    ['a missing field', undefined],
    ['an empty string', ''],
    ['prose', 'garbage'],
    ['an out-of-range date', '2026-13-45T00:00:00Z'],
  ])('refuses %s — the class that used to throw', (_name, value) => {
    expect(parseReceivedAt(value)).toBeNull()
  })

  it.each([
    ['null', null],
    ['a bare number', 1234],
  ])('refuses %s — the class that quietly became 1970', (_name, value) => {
    // `new Date(null)` is the epoch and `new Date(1234)` is 1.234 s after it. Neither throws, which
    // is exactly why they are worth a test: nothing else in the app would ever have noticed.
    expect(new Date(value as never).getTime()).not.toBeNaN()
    expect(parseReceivedAt(value)).toBeNull()
  })

  it('is what formatMessageTime returns null for, rather than throwing', () => {
    for (const value of [undefined, '', 'garbage', '2026-13-45T00:00:00Z', null, 1234]) {
      expect(formatMessageTime(value as never, NOW)).toBeNull()
    }
  })

  it('still formats the four age bands it exists for', () => {
    expect(formatMessageTime('2026-09-01T10:00:00Z', NOW)).toBe('2 hours ago')
    expect(formatMessageTime('2026-08-29T10:00:00Z', NOW)).toBe('Sat')
    expect(formatMessageTime('2026-03-03T10:00:00Z', NOW)).toBe('Mar 3')
    expect(formatMessageTime('2025-03-03T10:00:00Z', NOW)).toBe('Mar 3, 2025')
  })
})
