/**
 * The language picker's labels (FR-I18N-01).
 *
 * The picker used to read its names out of the bundle (`t('language.de')`), which meant every
 * language had to name every other one: 14 × 14 strings, all of them translatable and none of them
 * checkable. `languageName` replaces that table with `Intl.DisplayNames`, and these are the three
 * things that decision has to keep true.
 */

import { describe, expect, it } from 'vitest'
import { languageName, SUPPORTED_LANGUAGES } from './index'

describe('languageName', () => {
  it('names a language in its own words, not the reader’s', () => {
    // The point of the change. A reader who has landed in a language they cannot read is looking
    // for their own, and it has to be spelled the way they would spell it.
    expect(languageName('de')).toBe('Deutsch')
    expect(languageName('ru')).toBe('Русский')
    expect(languageName('ja')).toBe('日本語')
    expect(languageName('zh')).toBe('中文')
  })

  it('capitalises the first letter for the list, in the language’s own casing', () => {
    // CLDR gives "français" and "русский" lowercase, because that is how they are written
    // mid-sentence. A picker in which half the rows are capitalised and half are not looks broken.
    expect(languageName('fr')).toBe('Français')
    expect(languageName('cs')).toBe('Čeština')
    // Turkish is why this is `toLocaleUpperCase(tag)` and not `toUpperCase()`: the language whose
    // own name starts with a dotted `i` must get `İ`, not `I`.
    expect(languageName('tr')).toBe('Türkçe')
  })

  it('has a name for every language that ships', () => {
    // The failure this catches is a runtime built with small-icu, where `of()` hands the tag back
    // for everything and the settings menu offers "cs, de, en, es…". The tag is a correct fallback
    // and a useless label, so it should never be what a SHIPPED language resolves to.
    for (const language of SUPPORTED_LANGUAGES) {
      expect(languageName(language), `no display name for ${language}`).not.toBe(language)
    }
  })

  it('hands an unusable tag straight back rather than inventing a name', () => {
    // `Intl.DisplayNames` throws RangeError on a malformed tag and echoes an unknown one. Neither
    // may become a title-cased "Xx" that reads like a language nobody has heard of.
    expect(languageName('xx')).toBe('xx')
    expect(languageName('')).toBe('')
    expect(languageName('not a tag')).toBe('not a tag')
  })
})
