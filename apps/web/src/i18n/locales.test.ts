/**
 * Locale integrity (M4.6, FR-I18N-01).
 *
 * The Done-when is "a language switch shows zero untranslated strings", and the failure mode is
 * quiet: i18next falls back to the key or to English, so a missing entry renders as something
 * plausible-looking rather than as an error. Nobody notices until a speaker of that language does.
 *
 * Checks the very JSON the app bundles (`import.meta.glob` resolves to the files Vite ships), so
 * what is verified is what ships.
 *
 * ── WHERE THE RULES LIVE ──────────────────────────────────────────────────────────────────────
 *
 * In `scripts/locale-rules.mjs`, not here. A translator needs the same verdict in a loop while a
 * bundle is half-written, and `pnpm test` is the wrong shape for that — it reports all fourteen
 * languages at once, so somebody working on Russian reads three screens of Ukrainian. That loop is
 * `node scripts/check-locales.mjs ru`. Two callers, one implementation: a rule that only the CLI
 * knew would not block a release, and a rule that only the gate knew would ambush the translator
 * at the end.
 */

import { describe, expect, it } from 'vitest'
import { checkLocale, flatten, type LocaleTree } from '../../../../scripts/locale-rules.mjs'
import { DEFAULT_LANGUAGE, SUPPORTED_LANGUAGES } from './index'

const bundles = import.meta.glob('./locales/*/common.json', {
  eager: true,
  import: 'default',
}) as Record<string, LocaleTree>

/** `./locales/en/common.json` → `en`. */
const byLanguage = new Map<string, LocaleTree>(
  Object.entries(bundles).map(([path, tree]) => [path.split('/')[2] ?? path, tree]),
)

function bundleFor(language: string): LocaleTree {
  const tree = byLanguage.get(language)
  if (tree === undefined) throw new Error(`no locale bundle for ${language}`)
  return tree
}

const source = bundleFor(DEFAULT_LANGUAGE)

describe('locale files', () => {
  it('ships exactly one bundle per supported language', () => {
    // Both directions. A tag without a bundle is a runtime crash the moment somebody picks it from
    // the settings menu; a bundle without a tag is work nobody can reach, which is how a language
    // gets translated twice.
    expect([...byLanguage.keys()].sort()).toEqual([...SUPPORTED_LANGUAGES].sort())
  })

  it('has a plausible number of keys to translate', () => {
    // Guards the whole file going vacuous if a path or a glob changes — the failure this repo has
    // been bitten by before (B22).
    expect(flatten(source).size).toBeGreaterThan(500)
  })

  it.each([...SUPPORTED_LANGUAGES])('%s is a shippable bundle', (language) => {
    // Key parity (plural variants collapsed), the plural forms the language actually selects,
    // invented placeholders, a dropped `{{product}}`, a hardcoded brand, empty values, the
    // typographic apostrophe and ellipsis, and the triage/sort name collision. See
    // `scripts/locale-rules.mjs` for why each of those and not a spellchecker.
    expect(checkLocale(language, bundleFor(language), source)).toEqual([])
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
 *
 * The marks themselves (’ and …) are enforced for EVERY language by the rules module above. What
 * is left here is the one rule that cannot be: which of two correct spellings this bundle uses.
 */
describe('the source bundle spells each word one way', () => {
  it('is American, including where British is also correct', () => {
    // One spelling per word, not one variety per file: the bundle is otherwise American, so these
    // are the outliers rather than the rule. English only — the other bundles have their own
    // orthographies and no business being measured against this one.
    const PAIRS: readonly (readonly [RegExp, string])[] = [
      [/\bcancelled\b/i, 'canceled'],
      [/\bcolour\b/i, 'color'],
    ]
    const english = flatten(source)
    for (const [wrong, preferred] of PAIRS) {
      const found = [...english].filter(
        ([, value]) => typeof value === 'string' && wrong.test(value),
      )
      expect(
        found.map(([key, value]) => `${key} — ${String(value)}`),
        `prefer "${preferred}"`,
      ).toEqual([])
    }
  })
})

/**
 * Punctuation is part of the translation (R-50).
 *
 * A colon and a bracketed count look like layout and are not: French sets a narrow no-break space
 * before a colon, and a number in a sentence is what `{{count}}` and the plural forms exist for.
 * Two places in the JSX assembled them outside `t()` — `{t('reading.to')}: {…}` and
 * `{t('reading.attachments.title')} ({items.length})` — while the search chips next door had the
 * right shape all along (`search.chip.to`: "To: {{value}}").
 *
 * A SOURCE scan rather than a rendering test, because what has to be prevented is the shape coming
 * back somewhere else. The two patterns are the ones the review's own grep used.
 */
describe('no punctuation is assembled outside the translation', () => {
  const sources = import.meta.glob('../**/*.tsx', {
    eager: true,
    query: '?raw',
    import: 'default',
  }) as Record<string, string>

  it('scans a plausible number of files', () => {
    // Same guard as the key count above: a changed glob would make every assertion below vacuous.
    expect(Object.keys(sources).length).toBeGreaterThan(50)
  })

  /*
   * The JSX form specifically — `{t('x')}: {value}` and `{t('x')} ({n.length})` — plus the one
   * template-literal shape that is decidable without an allowlist: an `aria-label` assembled from
   * one. `MailScreen`'s back button was built that way (`` `${t('shell.reading.back')}: ${title}` ``)
   * and it is the same defect with the same consequence — French sets a narrow no-break space
   * before a colon, Japanese and Chinese use a full-width `：`, and neither is expressible outside
   * the string. An accessible name is prose read aloud, so there is no case where assembling one in
   * the source is right; every other `${t('x')}: ` left in the tree is `MessageView`'s
   * forwarded-message header block, where the colon belongs to a quasi-RFC header format rather
   * than to a sentence. That distinction is what this rule encodes instead of an allowlist, because
   * an allowlist is how a rule stops meaning anything.
   */
  it.each([
    ["a colon after a t() call — `')}: {`", /'\)\}:\s\{/],
    ['a bracketed count — `} ({…length})`', /\}\s\(\{[^}]*\.length\}\)/],
    ['an aria-label built in a template literal', /aria-label=\{`/],
  ])('has no %s', (_name, pattern) => {
    const offenders = Object.entries(sources)
      .filter(([, text]) => pattern.test(text))
      .map(([path]) => path)
    expect(offenders).toEqual([])
  })

  it('carries the French spacing the colon rule exists for', () => {
    // U+202F, the narrow no-break space French sets before a colon. Only reachable because the
    // colon is inside the string.
    const line = flatten(bundleFor('fr')).get('reading.toLine')
    expect(typeof line === 'string' ? line : '').toMatch(/\u202f:|\u00a0:| :/)
  })
})
