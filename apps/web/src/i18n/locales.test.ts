/**
 * Locale integrity (M4.6, FR-I18N-01).
 *
 * The Done-when is "a language switch en↔de shows zero untranslated strings", and the failure mode
 * is quiet: i18next falls back to the key or to English, so a missing German entry renders as
 * something plausible-looking rather than as an error. Nobody notices until a German speaker does.
 *
 * Checks the very JSON the app bundles, so what is verified is what ships.
 */

import { describe, expect, it } from 'vitest'
import { SUPPORTED_LANGUAGES } from './index'
import de from './locales/de/common.json'
import en from './locales/en/common.json'

type Tree = { [key: string]: string | Tree }

/**
 * The shipped bundles, imported rather than read from disk — the same choice `pwa-options.test.ts`
 * makes for the manifest, and the one that works in the jsdom project (vitest resolves the import to
 * the very file the app bundles, while `node:fs` has no usable cwd there).
 */
const BUNDLES: Record<string, Tree> = {
  en: en as unknown as Tree,
  de: de as unknown as Tree,
}

function load(language: string): Tree {
  const tree = BUNDLES[language]
  if (tree === undefined) throw new Error(`no locale bundle for ${language} — add it to BUNDLES`)
  return tree
}

/** Dotted key → string, so two trees can be compared as flat sets. */
function flatten(tree: Tree, prefix = ''): Map<string, string> {
  const out = new Map<string, string>()
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix === '' ? key : `${prefix}.${key}`
    if (typeof value === 'string') out.set(path, value)
    else for (const [k, v] of flatten(value, path)) out.set(k, v)
  }
  return out
}

const placeholders = (text: string): string[] =>
  [...text.matchAll(/\{\{\s*([\w.]+)/g)].map((m) => m[1] ?? '').sort()

const locales = new Map(SUPPORTED_LANGUAGES.map((lang) => [lang, flatten(load(lang))]))
const [base, ...others] = [...locales.keys()]
if (base === undefined) throw new Error('no supported languages')
const baseKeys = locales.get(base) ?? new Map<string, string>()

describe('locale files', () => {
  it('ships a locale per supported language, with a plausible number of keys', () => {
    // Guards the whole file going vacuous if a path or a glob changes — the failure this repo has
    // been bitten by before (B22).
    expect(locales.size).toBe(SUPPORTED_LANGUAGES.length)
    expect(baseKeys.size).toBeGreaterThan(500)
  })

  // Key-set parity itself lives in `app/guards.test.ts` ("en and de expose the identical key set")
  // and is deliberately not repeated here. What follows are the classes that a key-set comparison
  // cannot see: a key can be present in both locales and still render wrongly.

  it.each(others)('%s never invents a placeholder en does not have', (language) => {
    const theirs = locales.get(language) ?? new Map<string, string>()
    const invented: string[] = []
    for (const [key, text] of theirs) {
      const source = baseKeys.get(key)
      if (source === undefined) continue
      const extra = placeholders(text).filter((name) => !placeholders(source).includes(name))
      if (extra.length > 0) invented.push(`${key}: ${extra.join(', ')}`)
    }
    // Deliberately ASYMMETRIC. A translation may DROP a placeholder — "vom letzten Tag" is better
    // German than "vom letzten {{count}} Tag", and the singular form does not need the number. But
    // one it INVENTS has nothing to interpolate, so i18next renders the braces literally and the
    // user sees `{{count}}` on screen.
    expect(invented, `${language} interpolates something en does not provide`).toEqual([])
  })

  it.each(others)('%s carries both plural forms wherever en does', (language) => {
    const theirs = locales.get(language) ?? new Map<string, string>()
    const broken: string[] = []
    for (const key of baseKeys.keys()) {
      if (!key.endsWith('_one')) continue
      const other = `${key.slice(0, -'_one'.length)}_other`
      if (!baseKeys.has(other)) continue
      if (!theirs.has(key) || !theirs.has(other)) broken.push(key)
    }
    // Half a plural set is worse than none: the missing form falls back to English mid-sentence.
    expect(broken, `${language} has an incomplete plural set`).toEqual([])
  })

  it.each(others)('%s leaves no value empty', (language) => {
    const theirs = locales.get(language) ?? new Map<string, string>()
    const empty = [...theirs].filter(([, value]) => value.trim() === '').map(([key]) => key)
    // An empty string is the one "translation" that renders as nothing at all — a blank button.
    expect(empty).toEqual([])
  })
})

/**
 * Typographic consistency, which nothing else was watching.
 *
 * Found by reading the bundle end to end: the SAME sentence appeared twice, one line apart in
 * meaning — `list.delete.body` with "This can’t be undone." and `reading.delete.body` with "This
 * can't be undone." — plus "Send canceled" against "Send cancelled" and "Accent colour" against
 * "Change color". None of it is wrong in isolation, which is exactly why it survives review: it is
 * only visible when two of them are on screen together, and by then nobody is reading for
 * punctuation.
 */
describe('typographic consistency', () => {
  it('uses the typographic apostrophe, never the straight one', () => {
    const offenders: string[] = []
    for (const [language, strings] of locales) {
      for (const [key, value] of strings) {
        // Between letters only: a straight quote elsewhere is a quotation mark or code.
        if (/[\p{L}]'[\p{L}]/u.test(value)) offenders.push(`${language}: ${key} — ${value}`)
      }
    }
    expect(offenders, "use ’ (U+2019), not ' — Apple's style and this bundle's majority").toEqual(
      [],
    )
  })

  it('spells each word one way', () => {
    // One spelling per word, not one variety per file: the bundle is otherwise American, so these
    // three are the outliers rather than the rule.
    const PAIRS: readonly (readonly [RegExp, RegExp, string])[] = [
      [/\bcancelled\b/i, /\bcanceled\b/i, 'canceled'],
      [/\bcolour\b/i, /\bcolor\b/i, 'color'],
    ]
    const english = locales.get('en') ?? new Map<string, string>()
    for (const [wrong, , preferred] of PAIRS) {
      const found = [...english].filter(([, value]) => wrong.test(value))
      expect(
        found.map(([key, value]) => `${key} — ${value}`),
        `prefer "${preferred}"`,
      ).toEqual([])
    }
  })
})
