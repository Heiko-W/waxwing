import { describe, expect, it } from 'vitest'
import { collectSources, lineOf, type SourceFile } from './css-sources'

/**
 * Portalled overlays are ranked by one scale, and an anchored overlay outranks the dialog it can be
 * opened from.
 *
 * A portal (`ui/internal/Portal.tsx`) appends its host to `<body>`, which means the overlay's place
 * in the stack is decided by `z-index` and by nothing else: no ancestor can contain it, and the
 * source order is whichever portal happened to mount first. Eight components portal, and each had
 * picked its own number — 29, 30, 50, 50, 50, 60, 100, 120 — with nothing anywhere saying what the
 * order was supposed to be.
 *
 * It was wrong. Measured on a 390 px viewport, 2026-08-22: the calendar list is a screen-high sheet
 * below 40em, so on a phone every per-calendar `⋯` opened a menu at z-index 50 UNDER the dialog at
 * 100. `elementFromPoint` on the "Edit" item returned the sheet's own row. Renaming, recolouring and
 * deleting a calendar were unreachable on the only viewport where the sheet exists, and the menu was
 * not merely unclickable — it was invisible, so there was nothing to report but "it does nothing".
 *
 * No test in the repo could see it. jsdom computes no stacking, the component tests query the
 * accessibility tree (where the menu is present and correct), and Playwright's own actionability
 * check reports it as "intercepts pointer events" — which reads like a test bug, and was diagnosed
 * as one twice.
 *
 * So the rule is enforced where it is decidable: statically, over the stylesheets that belong to the
 * components which portal. Every `z-index` in them comes from the scale, and the scale is ordered.
 * A literal is the failure mode this catches — it is how all eight got there.
 *
 * Runs in the Node "unit" project: it reads the shipped CSS from disk.
 */

/**
 * The scale, in the order the reader experiences it, lowest first.
 *
 * Asserting the ORDER rather than the numbers: the gaps are arbitrary and someone will want to slot
 * something in between, which is fine. What is not fine is a popover under a dialog.
 */
const SCALE = ['queued', 'composer', 'dialog', 'popover', 'tooltip', 'toast'] as const

/**
 * Values a portalled stylesheet may still write as a literal.
 *
 * `0` and `1` create a stacking context INSIDE the overlay (the composer's own header over its own
 * body). They are local by construction and say nothing about where the overlay sits in the page.
 */
const LOCAL = new Set(['0', '1'])

/** `z-index: <value>;` — the declaration, wherever it appears. */
const Z_INDEX = /z-index:\s*([^;]+);/g

/** The layer scale as tokens.css defines it, name → number. */
function scaleFromTokens(): Map<string, number> {
  const tokens = collectSources('src', ['tokens.css']).find((file) =>
    file.path.endsWith('ui/tokens.css'),
  )
  expect(tokens, 'ui/tokens.css was not found — the walk is broken').toBeDefined()
  const found = new Map<string, number>()
  const pattern = /--waxwing-layer-([a-z-]+):\s*(\d+)\s*;/g
  let match: RegExpExecArray | null = pattern.exec(tokens?.text ?? '')
  while (match !== null) {
    const [, name = '', value = ''] = match
    found.set(name, Number(value))
    match = pattern.exec(tokens?.text ?? '')
  }
  return found
}

/**
 * The stylesheets of the components that render into a portal.
 *
 * Derived from the source rather than listed: a ninth component that starts portalling has to be
 * ranked too, and a hand-kept list is exactly what would not notice it. The `.module.css` a
 * component imports is the sheet that styles it — the repo has one per component and no exceptions.
 */
function portalledStylesheets(): SourceFile[] {
  const wanted = new Set<string>()
  for (const file of collectSources('src', ['.tsx'])) {
    if (file.path.endsWith('.test.tsx')) continue
    if (!/<Portal[\s/>]/.test(file.text)) continue
    const imported = /from\s+'\.\/([\w.-]+\.module\.css)'/.exec(file.text)
    if (imported === null) continue
    const dir = file.path.slice(0, file.path.lastIndexOf('/'))
    wanted.add(`${dir}/${imported[1]}`)
  }
  const sheets = collectSources('src', ['.module.css']).filter((file) => wanted.has(file.path))
  expect(
    sheets.map((file) => file.path).sort(),
    'the portal walk found stylesheets it did not expect, or lost ones it did',
  ).toEqual([...wanted].sort())
  return sheets
}

describe('portalled overlay layers', () => {
  it('finds the components that portal (a walk can go vacuous)', () => {
    // Eight today: Dialog, Menu, Tooltip, Toast, SenderCard, LabelMenu, ComposerHost, QueuedSends.
    expect(portalledStylesheets().length).toBeGreaterThanOrEqual(8)
  })

  it('defines the whole scale in tokens.css', () => {
    const scale = scaleFromTokens()
    expect([...scale.keys()].sort()).toEqual([...SCALE].sort())
  })

  it('ranks an anchored overlay above the dialog it can be opened from', () => {
    const scale = scaleFromTokens()
    const values = SCALE.map((name) => scale.get(name) ?? Number.NaN)
    const ascending = values.every(
      (value, index) => index === 0 || value > (values[index - 1] ?? 0),
    )
    expect(
      ascending,
      `the layer scale is out of order: ${SCALE.map((n, i) => `${n}=${values[i]}`).join(' < ')}`,
    ).toBe(true)
  })

  it('takes every portalled z-index from the scale, never a literal', () => {
    const offenders: string[] = []
    for (const file of portalledStylesheets()) {
      Z_INDEX.lastIndex = 0
      let match: RegExpExecArray | null = Z_INDEX.exec(file.text)
      while (match !== null) {
        const value = (match[1] ?? '').trim()
        if (!LOCAL.has(value) && !/^var\(--waxwing-layer-[a-z-]+\)$/.test(value)) {
          offenders.push(`${file.path}:${lineOf(file.text, match.index)} — z-index: ${value}`)
        }
        match = Z_INDEX.exec(file.text)
      }
    }
    expect(
      offenders,
      'a portalled overlay ranked itself with a number; use var(--waxwing-layer-…)',
    ).toEqual([])
  })
})
