/**
 * Language detection against a REGION-TAGGED browser locale (FR-I18N-01).
 *
 * `navigator.language` is a BCP-47 tag: a German browser reports `de-DE`, `de-AT` or `de-CH`, never
 * a bare `de`. The resolver compared that whole string against `SUPPORTED_LANGUAGES` — an exact
 * match — so every one of them missed and fell through to English. The app ships a complete German
 * bundle that essentially nobody was being shown.
 *
 * `locales.test.ts` could not catch this: it proves the two bundles agree, not that either is ever
 * selected.
 */

import { describe, expect, it } from 'vitest'
import { resolveLanguage } from './index'

describe('resolveLanguage', () => {
  it('resolves a region-tagged locale to its base language', () => {
    // The actual values Chrome/Firefox report on a German system.
    expect(resolveLanguage('de-DE')).toBe('de')
    expect(resolveLanguage('de-AT')).toBe('de')
    expect(resolveLanguage('de-CH')).toBe('de')
    expect(resolveLanguage('en-GB')).toBe('en')
    expect(resolveLanguage('en-US')).toBe('en')
    // The twelve added in v0.21.0 arrive the same way, and two of them are the interesting cases:
    // a Brazilian browser gets the `pt` bundle, and a Taiwanese one gets `zh` — which is written in
    // Simplified Chinese. Readable, not correct; see the note on `resolveLanguage`.
    expect(resolveLanguage('ru-RU')).toBe('ru')
    expect(resolveLanguage('pt-BR')).toBe('pt')
    expect(resolveLanguage('zh-TW')).toBe('zh')
    expect(resolveLanguage('zh-Hans-CN')).toBe('zh')
  })

  it('still accepts a bare supported tag', () => {
    expect(resolveLanguage('de')).toBe('de')
    expect(resolveLanguage('en')).toBe('en')
  })

  it('is case-insensitive, because a stored preference need not be normalised', () => {
    expect(resolveLanguage('DE-de')).toBe('de')
  })

  it('falls back to English for an unsupported language, region tag or not', () => {
    expect(resolveLanguage('sv')).toBe('en')
    expect(resolveLanguage('sv-SE')).toBe('en')
    expect(resolveLanguage('')).toBe('en')
    expect(resolveLanguage(undefined)).toBe('en')
  })

  it('does not resolve a language that merely starts with a supported one', () => {
    // `den` (Slave) is not German; a prefix match rather than a subtag split would claim it is.
    expect(resolveLanguage('den')).toBe('en')
  })
})
