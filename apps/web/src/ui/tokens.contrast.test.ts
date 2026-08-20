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
  // The accent as TEXT, which is a different question from the accent as a fill and was missing
  // here for four milestones. The browser axe sweep (e2e/tests/a11y.spec.ts) found it: the selected
  // folder in the tree renders `color: var(--waxwing-accent)` on `--waxwing-surface-2` and measured
  // 3.95:1. `surface-2` is the one that fails first — it is the raised fill the selected row uses —
  // so leaving it out of this list is what let the defect ship.
  { fg: 'accent', bg: 'bg', min: TEXT_AA, note: 'accent text on page' },
  { fg: 'accent', bg: 'surface', min: TEXT_AA, note: 'accent text on card' },
  { fg: 'accent', bg: 'surface-2', min: TEXT_AA, note: 'accent text on raised (the selected row)' },
  { fg: 'accent', bg: 'surface-selected', min: TEXT_AA, note: 'accent text on the selected row' },
  { fg: 'danger', bg: 'bg', min: TEXT_AA, note: 'error text on page' },
  { fg: 'danger', bg: 'surface', min: TEXT_AA, note: 'error text on card' },
  { fg: 'danger', bg: 'surface-2', min: TEXT_AA, note: 'error text on raised' },
  { fg: 'danger-contrast', bg: 'danger', min: TEXT_AA, note: 'label on danger fill' },
  { fg: 'success', bg: 'bg', min: TEXT_AA, note: 'success text on page' },
  { fg: 'success', bg: 'surface', min: TEXT_AA, note: 'success text on card' },
  { fg: 'success', bg: 'surface-2', min: TEXT_AA, note: 'success text on raised' },
  { fg: 'success-contrast', bg: 'success', min: TEXT_AA, note: 'label on success fill' },
  { fg: 'warning', bg: 'bg', min: TEXT_AA, note: 'warning text on page' },
  { fg: 'warning', bg: 'surface', min: TEXT_AA, note: 'warning text on card' },
  { fg: 'warning', bg: 'surface-2', min: TEXT_AA, note: 'warning text on raised' },
  { fg: 'warning-contrast', bg: 'warning', min: TEXT_AA, note: 'label on warning fill' },
  { fg: 'border-strong', bg: 'bg', min: UI_AA, note: 'control boundary on page' },
  { fg: 'border-strong', bg: 'surface', min: UI_AA, note: 'control boundary on card' },
  { fg: 'border-strong', bg: 'surface-2', min: UI_AA, note: 'control boundary on raised' },
  { fg: 'focus-ring', bg: 'bg', min: UI_AA, note: 'focus/selection ring on page' },
  { fg: 'focus-ring', bg: 'surface', min: UI_AA, note: 'focus/selection ring on card' },
  // The recessed plane (2026-08-19). It carries the folder rail and the nav rail, so it holds
  // folder names, account captions and the storage readout — body AND secondary text, plus the
  // control boundaries of the rail's own buttons.
  { fg: 'text', bg: 'surface-sunken', min: TEXT_AA, note: 'folder name on the rail' },
  { fg: 'text-muted', bg: 'surface-sunken', min: TEXT_AA, note: 'account caption on the rail' },
  { fg: 'accent', bg: 'surface-sunken', min: TEXT_AA, note: 'the selected folder on the rail' },
  { fg: 'border-strong', bg: 'surface-sunken', min: UI_AA, note: 'control boundary on the rail' },
  { fg: 'focus-ring', bg: 'surface-sunken', min: UI_AA, note: 'focus ring on the rail' },
  { fg: 'text', bg: 'surface-selected-idle', min: TEXT_AA, note: 'text on an unfocused selection' },
  {
    fg: 'text-muted',
    bg: 'surface-selected-idle',
    min: TEXT_AA,
    note: 'preview on an unfocused selection',
  },
]

/**
 * Plane against plane — the question the pairs above cannot ask.
 *
 * Every assertion in this file measures TEXT on a fill, and each one of them passed while
 * `--waxwing-surface-hover` was invisible: drawn as a step above `--waxwing-surface`, it was
 * landing on `--waxwing-bg`, where it measured **1.09:1** in light against **1.50:1** in dark. Same
 * token, same code path, an effect the reader could see in one theme and not the other — and no
 * test in the repo was looking at the two fills together.
 *
 * The corridor is narrow on both sides on purpose. Below it a state change is not perceptible;
 * above it a hover reads as a selection, and a list under a moving pointer starts to flash. The
 * upper bound is what makes this a two-sided check rather than a floor.
 */
const FILL_MIN = 1.12
const FILL_MAX = 1.75

interface FillPair {
  readonly fill: string
  readonly under: string
  readonly note: string
}

const FILL_PAIRS: FillPair[] = [
  {
    fill: 'surface-hover',
    under: 'surface',
    note: 'a row under the pointer, on the content plane',
  },
  { fill: 'surface-selected', under: 'surface', note: 'the row the reader is on' },
  {
    fill: 'surface-selected-idle',
    under: 'surface',
    note: 'the row the reader was on, while they are elsewhere',
  },
  // On the rail a hover LIFTS to the content plane rather than darkening — a step further back is
  // imperceptible in light, which is how this check earned its keep the day it was written.
  { fill: 'surface', under: 'surface-sunken', note: 'a folder under the pointer, lifted' },
  { fill: 'surface-2', under: 'surface', note: 'a raised inset on the content plane' },
]

/**
 * Fill against fill, where BOTH are neutral — the question FILL_PAIRS cannot ask either.
 *
 * Every pair above measures a state fill against the plane UNDER it, and each one passed while the
 * dark palette had `surface-2`, `surface-hover`, `surface-selected-idle` and `border` on one single
 * value (#3a3a3c). Measured live in a browser: the skeleton gradient ran between three identical
 * stops (1.00:1 — the animation played and nothing moved), and an opened message in the list was
 * indistinguishable from the row merely under the pointer.
 *
 * `surface-selected` is deliberately absent from this list. It is the accent TINT, so it separates
 * from a neutral hover chromatically rather than by luminance, and a luminance floor would force it
 * darker for no gain. The pairs here are the ones that have nothing but lightness to tell them
 * apart.
 */
const DISTINCT_MIN = 1.12

interface DistinctPair {
  readonly a: string
  readonly b: string
  readonly note: string
}

const DISTINCT_PAIRS: DistinctPair[] = [
  {
    a: 'surface-hover',
    b: 'surface-selected-idle',
    note: 'the row under the pointer vs the row the reader came from',
  },
  {
    a: 'surface-2',
    b: 'skeleton-sheen',
    note: 'a loading placeholder and the highlight travelling across it',
  },
  { a: 'surface-hover', b: 'border', note: 'a hovered row and the rule beneath it' },
]

for (const [themeName, palette] of [
  ['light', light],
  ['dark', dark],
] as const) {
  describe(`fill against fill — ${themeName} theme`, () => {
    for (const pair of FILL_PAIRS) {
      it(`${pair.fill} is perceptible on ${pair.under} (${pair.note})`, () => {
        const fill = palette[pair.fill]
        const under = palette[pair.under]
        if (fill === undefined || under === undefined) {
          throw new Error(`missing token: --waxwing-${pair.fill} or --waxwing-${pair.under}`)
        }
        const ratio = roundRatio(contrastRatio(fill, under))
        expect(ratio, `${pair.fill} on ${pair.under} = ${ratio}:1`).toBeGreaterThanOrEqual(FILL_MIN)
        expect(ratio, `${pair.fill} on ${pair.under} = ${ratio}:1`).toBeLessThanOrEqual(FILL_MAX)
      })
    }
  })

  describe(`neutral fills stay distinguishable — ${themeName} theme`, () => {
    for (const pair of DISTINCT_PAIRS) {
      it(`${pair.a} is not ${pair.b} (${pair.note})`, () => {
        const a = palette[pair.a]
        const b = palette[pair.b]
        if (a === undefined || b === undefined) {
          throw new Error(`missing token: --waxwing-${pair.a} or --waxwing-${pair.b}`)
        }
        expect(a, `${pair.a} and ${pair.b} are the same value (${a})`).not.toBe(b)
        const ratio = roundRatio(contrastRatio(a, b))
        expect(ratio, `${pair.a} vs ${pair.b} = ${ratio}:1`).toBeGreaterThanOrEqual(DISTINCT_MIN)
      })
    }
  })

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
