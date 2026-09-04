/**
 * That a number inside a sentence is written the way the reader's language writes it — and that
 * making it so did not cost the plural form (FR-I18N-01).
 *
 * The message list is the first surface in this app that regularly writes four- and five-digit
 * numbers at a reader: "10000 selected" is a number you have to count, "10,000 selected" is one you
 * read. Which separator that is belongs to the language and to nobody else — `10,000` / `10.000` /
 * `10 000` / `10 000` are all correct somewhere in the fourteen bundles here — so it has to come
 * out of `Intl`, which is what `{{count, number}}` in the bundle now asks for.
 *
 * THE HALF THAT WOULD FAIL SILENTLY, and the reason this file exists rather than an assertion in
 * `formatters.test.ts`: the obvious implementation is `t(key, { count: formatNumber(count) })`, and
 * it breaks the sentence it is formatting. i18next chooses the plural form FROM `count`, a string
 * selects nothing, and Russian would then serve one form for 1, 2 and 5 — in a bundle that has all
 * four and a test suite that would still be green, because English has no `_few` to notice. So the
 * Russian case is asserted here beside the formatting it could have broken.
 */

import { afterAll, describe, expect, it } from 'vitest'
import i18next, { changeLanguage } from './index'

afterAll(async () => {
  await changeLanguage('en')
})

/** The digits with whatever the language puts between them — the thing under test, normalised. */
function grouped(text: string): string {
  // Any run of whitespace collapses to one space: what is compared is the GROUPING, and the
  // words stripped out from between two numbers leave their own spaces behind.
  return text
    .replace(/[^\d.,\s]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

describe('a number in a sentence follows the language', () => {
  it('groups thousands in English', async () => {
    await changeLanguage('en')
    expect(i18next.t('list.selected', { count: 12345 })).toBe('12,345 selected')
    expect(i18next.t('list.selectAllInQuery', { total: 1200 })).toBe('Select all 1,200')
    expect(i18next.t('list.selectAllTooMany', { max: 10000 })).toContain('10,000')
    expect(i18next.t('search.results.count', { count: 4321 })).toBe('4,321 results')
  })

  it('groups them the German way, in the same keys', async () => {
    await changeLanguage('de')
    const t = i18next.getFixedT('de')
    expect(grouped(t('list.selected', { count: 12345 }))).toBe('12.345')
    expect(grouped(t('list.selectedOfTotal', { count: 1200, total: 12345 }))).toBe('1.200 12.345')
    // Not the English separator, which is the failure a hardcoded format would produce.
    expect(t('list.selected', { count: 12345 })).not.toContain('12,345')
  })

  it('leaves a number that needs no separator alone', async () => {
    await changeLanguage('en')
    // The everyday case, and the one every other test in the suite asserts on: three digits or
    // fewer must render exactly as they did before the formatter existed.
    expect(i18next.t('list.selected', { count: 300 })).toBe('300 selected')
    expect(i18next.t('list.selectedOfTotal', { count: 50, total: 60 })).toBe('50 of 60 selected')
  })

  it('still picks the plural form from the number, in a language with four of them', async () => {
    await changeLanguage('ru')
    const t = i18next.getFixedT('ru')
    const forms = [1, 2, 5].map((count) => t('list.confirmDeleteBody', { count }))
    // `one`, `few` and `many` are three different sentences in the Russian bundle. If `count` had
    // stopped being a number on the way in, all three would be the same one.
    expect(new Set(forms).size, 'the plural resolver saw a string, not a number').toBe(3)
    for (const form of forms) expect(form).not.toContain('confirmDeleteBody')
    // …and the formatting still happens inside the chosen form.
    expect(t('list.selected', { count: 12345 })).toContain('12')
    expect(t('list.selected', { count: 12345 })).not.toContain('12345')
  })
})
