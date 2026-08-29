/**
 * That the locale checker can actually fail — on a bundle built to break each rule.
 *
 * `locales.test.ts` runs `checkLocale` against the fourteen bundles that ship and expects zero
 * problems from each. That is the right assertion and it is **vacuous on its own**: a rule that
 * silently checks nothing produces exactly the same green. This repository has shipped that shape
 * before (B22), so every rule here is proven against an input that violates it.
 *
 * The case that motivated the file is the fourth one. `checkLocale` looked its English counterpart
 * up as `ours.get(stripPlural(path)) ?? ours.get(path)`, and a Russian `_few` key has neither: `en`
 * has only `_one` and `_other`, and the base alone is not a key at all. So `origin` came back
 * undefined and every placeholder and brand check below it was skipped — for precisely the forms
 * that exist only in the languages nobody reviewing an English diff can read.
 *
 * The module lives in `scripts/` because its other caller is a CLI with no build step; the test
 * lives here because this is where the vitest projects are.
 */

import { describe, expect, it } from 'vitest'
import { checkLocale, type LocaleTree } from '../../../../scripts/locale-rules.mjs'

/** A minimal source bundle: one plain string, one plural pair, one list. */
const EN: LocaleTree = {
  app: {
    save: 'Save',
    greeting: 'Welcome to {{product}}',
    hint: 'Loading…',
    count_one: '{{count}} message',
    count_other: '{{count}} messages',
    keywords: ['attached', 'enclosed'],
  },
}

/** A translation that breaks exactly one rule, built from a correct one. */
function bundle(overrides: Record<string, unknown>, categories: readonly string[]): LocaleTree {
  const app: Record<string, unknown> = {
    save: 'Speichern',
    greeting: 'Willkommen bei {{product}}',
    hint: 'Wird geladen…',
    keywords: ['anbei', 'beigefügt'],
  }
  for (const category of categories) app[`count_${category}`] = `${category}: {{count}} Nachrichten`
  return { app: { ...app, ...overrides } } as LocaleTree
}

const TWO = ['one', 'other']
const FOUR = ['one', 'few', 'many', 'other']

describe('checkLocale passes a correct bundle', () => {
  it('says nothing about a two-form language that got everything right', () => {
    expect(checkLocale('de', bundle({}, TWO), EN)).toEqual([])
  })

  it('says nothing about a four-form language that got everything right', () => {
    expect(checkLocale('ru', bundle({}, FOUR), EN)).toEqual([])
  })

  it('says nothing about a one-form language that ships only `_other`', () => {
    expect(checkLocale('ja', bundle({}, ['other']), EN)).toEqual([])
  })
})

describe('checkLocale fails a bundle that is wrong', () => {
  const problems = (overrides: Record<string, unknown>, categories = TWO, language = 'de') =>
    checkLocale(language, bundle(overrides, categories), EN).join(' | ')

  it('names a missing key', () => {
    const short = bundle({}, TWO)
    delete (short.app as Record<string, unknown>).save
    expect(checkLocale('de', short, EN).join(' | ')).toContain('missing key: app.save')
  })

  it('names a key en does not have', () => {
    expect(problems({ extra: 'Zusatz' })).toContain('key that en does not have: app.extra')
  })

  it('names a plural form the language selects and the bundle lacks', () => {
    // A two-form file offered to a four-form language: `_few` covers 2–4 in Russian, and its
    // absence falls back to the English sentence for exactly those counts.
    expect(problems({}, TWO, 'ru')).toContain('missing plural form: app.count_few')
  })

  it('names a plural form the language never selects', () => {
    expect(problems({}, FOUR, 'de')).toContain('plural form de never selects: app.count_few')
  })

  it('sees an invented placeholder in a form only four-form languages have', () => {
    // The regression this file exists for. `_few` has no counterpart in `en` under its own name,
    // so an implementation that gives up when the lookup misses reports nothing here.
    expect(problems({ count_few: '{{count}} из {{bogus}}' }, FOUR, 'ru')).toContain(
      'app.count_few: invents {{bogus}}',
    )
  })

  it('sees a dropped {{product}} and a hardcoded brand name', () => {
    expect(problems({ greeting: 'Willkommen' })).toContain('drops {{product}}')
    expect(problems({ greeting: 'Willkommen bei Waxwing' })).toContain('names Waxwing')
  })

  it('sees an empty value, a straight apostrophe and three periods', () => {
    expect(problems({ save: '   ' })).toContain('app.save: empty')
    expect(problems({ save: "l'enregistrer" })).toContain("not '")
    expect(problems({ hint: 'Wird geladen...' })).toContain('not three periods')
    expect(problems({ hint: 'Wird geladen …' })).toContain('"Loading…", not "Loading …"')
  })

  it('sees a list that was replaced by a string, or emptied', () => {
    expect(problems({ keywords: 'anbei' })).toContain('en has a non-empty list here')
    expect(problems({ keywords: [] })).toContain('en has a non-empty list here')
    expect(problems({ keywords: ['anbei', ''] })).toContain('non-empty string')
  })

  it('sees a file that is the English one copied', () => {
    const copy = { app: { ...(EN.app as object) } } as LocaleTree
    expect(checkLocale('nl', copy, EN).join(' | ')).toContain('untranslated')
    // …and does not accuse a real translation that happens to share a short label.
    expect(checkLocale('de', bundle({ save: 'Save' }, TWO), EN)).toEqual([])
  })
})
