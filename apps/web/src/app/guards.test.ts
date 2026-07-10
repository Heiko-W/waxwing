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
