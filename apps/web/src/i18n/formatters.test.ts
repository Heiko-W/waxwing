import { afterEach, describe, expect, it } from 'vitest'
import { formatBytes, formatDate, formatNumber, formatRelativeTime } from './formatters'
import { changeLanguage } from './index'

/*
 * These formatters memoize their `Intl.*Format` instances (see the file header for the measurement
 * that motivates it). A cache keyed wrongly would not be slow — it would be WRONG, and wrong in the
 * way nobody looks at: the app would keep formatting in the language it was started in. That is what
 * this file is for. The speed is not asserted; the correctness under a language switch is.
 *
 * The switch goes through this module's own `changeLanguage`, NOT `i18next.changeLanguage`: only the
 * wrapper loads the bundle first, and without a loaded bundle i18next leaves `resolvedLanguage` on
 * the previous language — which `activeLocale()` reads. Calling the bare i18next method here would
 * produce a test that fails against correct code, which is how this comment came to be written.
 */

const FIXED = Date.UTC(2026, 2, 3, 14, 30)

afterEach(async () => {
  await changeLanguage('en')
})

describe('locale-aware formatters', () => {
  it('formats the same input the same way twice (the cache returns an equivalent formatter)', () => {
    expect(formatDate(FIXED)).toBe(formatDate(FIXED))
    expect(formatBytes(2_500_000)).toBe(formatBytes(2_500_000))
  })

  it('keeps distinct option shapes apart', () => {
    const short = formatDate(FIXED, { weekday: 'short' })
    const full = formatDate(FIXED, { year: 'numeric', month: 'short', day: 'numeric' })
    expect(short).not.toBe(full)
    // And asking again for the first shape does not hand back the second one's formatter.
    expect(formatDate(FIXED, { weekday: 'short' })).toBe(short)
  })

  it('follows a language switch instead of serving the previous language from cache', async () => {
    const english = formatDate(FIXED, { month: 'long' })
    await changeLanguage('de')
    const german = formatDate(FIXED, { month: 'long' })
    expect(german).not.toBe(english)
    expect(german).toContain('März')
    // Back again — the English entry is still correct, not a stale German one.
    await changeLanguage('en')
    expect(formatDate(FIXED, { month: 'long' })).toBe(english)
  })

  it('switches number and byte formatting too, decimal separator included', async () => {
    expect(formatNumber(1234.5)).toBe('1,234.5')
    await changeLanguage('de')
    // German uses a comma for the decimal separator and a dot for thousands.
    expect(formatNumber(1234.5)).toBe('1.234,5')
    expect(formatBytes(2_500_000)).toContain(',')
  })

  it('switches relative time', async () => {
    const base = FIXED
    expect(formatRelativeTime(base - 2 * 3_600_000, base)).toContain('hours')
    await changeLanguage('de')
    expect(formatRelativeTime(base - 2 * 3_600_000, base)).toContain('Stunden')
  })
})
