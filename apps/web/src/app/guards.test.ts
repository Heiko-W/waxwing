/**
 * Project-wide guardrails (M1.4 DoD): i18n en/de key parity, and no user-visible product name
 * hardcoded in the UI (FR-THEME-02 — the name always comes from config.branding.productName).
 * Uses Vite's `import.meta.glob` so it runs in the jsdom "web" project without fs/path plumbing.
 */

import { describe, expect, it } from 'vitest'

const locales = import.meta.glob('../i18n/locales/*/common.json', {
  eager: true,
  import: 'default',
}) as Record<string, Record<string, unknown>>

const tsxSources = import.meta.glob('../**/*.tsx', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>

function keyPaths(value: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key
    return child && typeof child === 'object' && !Array.isArray(child)
      ? keyPaths(child as Record<string, unknown>, path)
      : [path]
  })
}

function localeFor(lang: string): Record<string, unknown> {
  const entry = Object.entries(locales).find(([path]) => path.includes(`/${lang}/`))
  if (!entry) throw new Error(`missing ${lang} locale`)
  return entry[1]
}

describe('i18n key parity', () => {
  it('en and de expose the identical key set', () => {
    const en = keyPaths(localeFor('en')).sort()
    const de = keyPaths(localeFor('de')).sort()
    expect(de).toEqual(en)
  })
})

describe('every translated key actually resolves (FR-I18N-01)', () => {
  /**
   * The Done-when for M4.6 is "zero untranslated strings", and key-set parity above cannot see the
   * failure that produces them: a `t('some.key')` whose key exists in NEITHER locale. i18next then
   * renders the key itself, so the user reads `settings.about.verison` on screen — a typo that no
   * type checks, no test asserts, and that looks like a layout bug rather than a missing string.
   */
  const CALLS = /\bt\(\s*['"]([a-z][\w.]*)['"]/g
  const EXEMPT_SOURCE = /\/(demo|gallery)\/|\.test\./

  it('resolves every literal t() key in both locales', () => {
    const en = new Set(keyPaths(localeFor('en')))
    const de = new Set(keyPaths(localeFor('de')))
    const missing: string[] = []
    for (const [path, source] of Object.entries(tsxSources)) {
      if (EXEMPT_SOURCE.test(path)) continue
      CALLS.lastIndex = 0
      for (const match of source.matchAll(CALLS)) {
        const key = match[1] ?? ''
        // A pluralised call site names the base key; i18next appends the suffix, so accept either
        // the bare key or a complete `_one`/`_other` pair.
        const resolves = (set: Set<string>) =>
          set.has(key) || (set.has(`${key}_one`) && set.has(`${key}_other`))
        if (!resolves(en) || !resolves(de)) missing.push(`${path}: ${key}`)
      }
    }
    expect(missing, 'a t() key that would render as itself').toEqual([])
  })
})

describe('branding is never hardcoded (FR-THEME-02)', () => {
  // A quoted or JSX-text "Waxwing" literal in a component is a hardcoded brand; identifiers
  // (WaxwingConfig) and comments are not matched. Dev-only surfaces are exempt.
  const HARDCODED = /['"`>]Waxwing\b/
  const EXEMPT = /\/(demo|gallery)\//

  it('no shipped .tsx renders a literal product name', () => {
    const offenders = Object.entries(tsxSources)
      .filter(([path]) => !EXEMPT.test(path) && !path.includes('.test.'))
      .filter(([, source]) => HARDCODED.test(source))
      .map(([path]) => path)
    expect(offenders).toEqual([])
  })

  it('the locale strings use the {{product}} placeholder, not a literal name', () => {
    for (const lang of ['en', 'de']) {
      expect(JSON.stringify(localeFor(lang))).not.toContain('Waxwing')
    }
  })
})
