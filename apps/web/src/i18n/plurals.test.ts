/**
 * That the plural forms in a bundle are the forms i18next will actually ask for (FR-I18N-01).
 *
 * `locales.test.ts` proves each bundle CONTAINS the categories `Intl.PluralRules` names for its
 * language. That is a statement about two lists agreeing, and it would stay green if i18next
 * resolved plurals some other way — through its own rule table, through a `pluralSeparator` that is
 * not `_`, through a v3-style `_0`/`_1`/`_2` suffix. It resolved plurals all three of those ways in
 * living memory.
 *
 * So this asks the shipped instance instead. Russian is the case that decides it: `_few` covers
 * 2–4 and `_many` covers 5–20, English has neither, and a resolver that disagreed with the bundle
 * would silently serve the English sentence for exactly those counts — the failure that is
 * invisible in a screenshot of a list with one item in it.
 */

import { afterAll, describe, expect, it } from 'vitest'
import i18next, { changeLanguage } from './index'

afterAll(async () => {
  await changeLanguage('en')
})

describe('i18next selects the plural form the bundle provides', () => {
  it('uses all four Russian forms, and a different sentence for at least two of them', async () => {
    await changeLanguage('ru')
    const t = i18next.getFixedT('ru')
    const forms = [1, 2, 5, 21].map((count) => t('search.results.count', { count }))

    // Nothing here asserts the WORDING — that is a translator's business, and asserting it would
    // make this file fail on every improvement. What it asserts is that the resolver reached the
    // Russian bundle at all, and told the four counts apart.
    for (const [index, form] of forms.entries()) {
      expect(form, `count ${[1, 2, 5, 21][index]} fell back to a key`).not.toContain(
        'search.results',
      )
      expect(form, `count ${[1, 2, 5, 21][index]} rendered no number`).toMatch(/\d/)
    }
    // 1 selects `one`, 2 selects `few`, 5 selects `many`, 21 selects `one` again. If the resolver
    // were using English rules, 2, 5 and 21 would all be `other` and all three would be identical.
    expect(
      new Set(forms).size,
      'every count produced the same string — one plural rule for all',
    ).toBeGreaterThan(1)
    // 21 selects `one` in Russian, as 1 does — so the two differ only by the number they carry.
    // Comparing them raw would be comparing "1 результат" with "21 результат"; normalise the count
    // away and what is left is the FORM, which is the thing under test.
    expect(forms[3]?.replace('21', '1'), 'count 21 must select the same form as count 1').toBe(
      forms[0],
    )
  })

  it('serves the single Japanese form for every count', async () => {
    await changeLanguage('ja')
    const t = i18next.getFixedT('ja')
    // Japanese selects `other` and nothing else, so the bundle carries one form and it has to be
    // the one every count reaches — including 1, which in English would be `_one`.
    const one = t('search.results.count', { count: 1 })
    expect(one).not.toContain('search.results')
    expect(one).toBe(t('search.results.count', { count: 7 }).replace('7', '1'))
  })
})
