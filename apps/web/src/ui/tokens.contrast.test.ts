import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { contrastRatio, roundRatio } from './contrast'

// Runs in the Node "unit" project (see vitest.config.ts): pure color math over the shipped
// CSS, no DOM. Vitest stubs `.css` imports to empty in the jsdom project, so the tokens are
// read from disk here, where `import.meta.url` is a real file URL.
const css = readFileSync(fileURLToPath(new URL('./tokens.css', import.meta.url)), 'utf8')

/**
 * Machine-verified WCAG 2.2 AA contrast for the design tokens (FR-A11Y-01, M1.1:
 * "contrast-check every token pair (WCAG AA) and record results in the doc"). This test
 * IS that check: it parses the shipped tokens.css, reconstructs the effective light and
 * dark palettes, and asserts every color pair the app relies on. The verified numbers
 * are transcribed into docs/design-system.md; this test is what keeps that table honest
 * as tokens change.
 *
 * Not asserted (documented exemptions, see tokens.css):
 *  - `--waxwing-border` is a subtle divider (< 3:1 by design); control boundaries use
 *    `--waxwing-border-strong` (asserted below).
 *  - the accent as a fill/graphic is config-overridable and never a sole state indicator,
 *    so its background contrast is intentionally not guaranteed. Its LABEL legibility on
 *    the default accent (`--waxwing-accent-contrast`) is asserted.
 */

function parseBlock(selectorSource: string): Record<string, string> {
  const match = css.match(new RegExp(`${selectorSource}\\s*\\{([^}]*)\\}`))
  if (!match) throw new Error(`token block not found: ${selectorSource}`)
  const tokens: Record<string, string> = {}
  for (const line of (match[1] ?? '').split('\n')) {
    // A plain colour, or one behind a per-theme slot: `var(--waxwing-accent-light, #2f6fe0)`.
    // The FALLBACK is the effective value whenever no accent palette is selected (FR-THEME-03), so
    // it is what these assertions are about — the shipped default. The palettes themselves are
    // proved separately, over the same pairs, in `accent.test.ts`.
    const decl = line.match(
      /--waxwing-([\w-]+):\s*(?:var\(--waxwing-[\w-]+,\s*)?(#[0-9a-fA-F]{3,8})\s*\)?\s*;/,
    )
    if (decl?.[1] && decl[2]) tokens[decl[1]] = decl[2]
  }
  return tokens
}

// Base :root carries the full light palette; the dark block overrides only colors.
const light = parseBlock(':root')
const dark = { ...light, ...parseBlock(':root\\[data-theme="dark"\\]') }

const TEXT_AA = 4.5 // WCAG 1.4.3 normal text
const UI_AA = 3.0 // WCAG 1.4.11 non-text UI components

interface Pair {
  fg: string
  bg: string
  min: number
  note: string
}

// Every pair Waxwing controls and requires. fg/bg are token names.
const PAIRS: Pair[] = [
  { fg: 'text', bg: 'bg', min: TEXT_AA, note: 'body text on page' },
  { fg: 'text', bg: 'surface', min: TEXT_AA, note: 'body text on card' },
  { fg: 'text', bg: 'surface-2', min: TEXT_AA, note: 'body text on raised' },
  { fg: 'text-muted', bg: 'bg', min: TEXT_AA, note: 'secondary text on page' },
  { fg: 'text-muted', bg: 'surface', min: TEXT_AA, note: 'secondary text on card' },
  { fg: 'text-muted', bg: 'surface-2', min: TEXT_AA, note: 'secondary text on raised' },
  // Row states (M1.6, defined M3.9). A list row keeps `--waxwing-text` / `--waxwing-text-muted` on
  // top of these fills, so both have to carry body AND secondary text. These pairs are the reason
  // the fills are tokens at all rather than literals at the call site: the eight milestones during
  // which they were referenced-but-undefined were invisible precisely because no test looked here.
  { fg: 'text', bg: 'surface-hover', min: TEXT_AA, note: 'row text under the pointer' },
  { fg: 'text-muted', bg: 'surface-hover', min: TEXT_AA, note: 'row preview under the pointer' },
  { fg: 'text', bg: 'surface-selected', min: TEXT_AA, note: 'text on the selected row' },
  { fg: 'text-muted', bg: 'surface-selected', min: TEXT_AA, note: 'preview on the selected row' },
  { fg: 'accent-contrast', bg: 'accent', min: TEXT_AA, note: 'label on default accent fill' },
  { fg: 'danger', bg: 'bg', min: TEXT_AA, note: 'error text on page' },
  { fg: 'danger', bg: 'surface', min: TEXT_AA, note: 'error text on card' },
  { fg: 'danger-contrast', bg: 'danger', min: TEXT_AA, note: 'label on danger fill' },
  { fg: 'success', bg: 'bg', min: TEXT_AA, note: 'success text on page' },
  { fg: 'success', bg: 'surface', min: TEXT_AA, note: 'success text on card' },
  { fg: 'success-contrast', bg: 'success', min: TEXT_AA, note: 'label on success fill' },
  { fg: 'warning', bg: 'bg', min: TEXT_AA, note: 'warning text on page' },
  { fg: 'warning', bg: 'surface', min: TEXT_AA, note: 'warning text on card' },
  { fg: 'warning-contrast', bg: 'warning', min: TEXT_AA, note: 'label on warning fill' },
  { fg: 'border-strong', bg: 'bg', min: UI_AA, note: 'control boundary on page' },
  { fg: 'border-strong', bg: 'surface', min: UI_AA, note: 'control boundary on card' },
  { fg: 'border-strong', bg: 'surface-2', min: UI_AA, note: 'control boundary on raised' },
  { fg: 'focus-ring', bg: 'bg', min: UI_AA, note: 'focus/selection ring on page' },
  { fg: 'focus-ring', bg: 'surface', min: UI_AA, note: 'focus/selection ring on card' },
]

for (const [themeName, palette] of [
  ['light', light],
  ['dark', dark],
] as const) {
  describe(`token contrast — ${themeName} theme`, () => {
    for (const pair of PAIRS) {
      it(`${pair.fg} on ${pair.bg} meets ${pair.min}:1 (${pair.note})`, () => {
        const fg = palette[pair.fg]
        const bg = palette[pair.bg]
        if (fg === undefined || bg === undefined) {
          throw new Error(`missing token: --waxwing-${pair.fg} or --waxwing-${pair.bg}`)
        }
        const ratio = roundRatio(contrastRatio(fg, bg))
        expect(ratio, `${pair.fg} on ${pair.bg} = ${ratio}:1`).toBeGreaterThanOrEqual(pair.min)
      })
    }
  })
}
