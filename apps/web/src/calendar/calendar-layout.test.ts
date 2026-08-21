import { readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The calendar's grid rules, checked as source (T2, T8, T10).
 *
 * These three findings are pure layout, and jsdom computes none: `getBoundingClientRect()` returns
 * zeroes there, so no rendering test in this repo can see a column that is too narrow or a line
 * sliced in half. What CAN be checked is the rule that decides it, which is what the `*.css.test.ts`
 * family in `src/ui` does for focus rings and display type. Same idea, one stylesheet.
 *
 * The failure they guard against is the classic one: `repeat(7, 1fr)` reads as "seven equal
 * columns" and is not. `1fr` is `minmax(auto, 1fr)`, and `auto` means "no narrower than your
 * content" — so on a 390px phone ONE event title set the width of its column and pushed Thursday
 * through Sunday out of a grid that clips its overflow. Measured: 342px of grid holding 655px of
 * columns, four of the seven days gone and not scrollable.
 *
 * Not named `*.css.test.ts` on purpose: that suffix is excluded from the jsdom project and included
 * only for `src/ui` in the node one, so a file named that way here would be collected by neither
 * and pass for ever without running.
 */

/**
 * The stylesheet, read from disk.
 *
 * By `process.cwd()` and not by `import.meta.url`: under Vite this module's URL is an `http://`
 * one, so `fileURLToPath` refuses it. The two candidates cover the two roots vitest may be started
 * from — the workspace root and the app package.
 */
const CSS = ((): string => {
  const candidates = [
    'apps/web/src/calendar/calendar.module.css',
    'src/calendar/calendar.module.css',
  ]
  for (const candidate of candidates) {
    const path = isAbsolute(candidate) ? candidate : resolve(process.cwd(), candidate)
    try {
      return readFileSync(path, 'utf8')
    } catch {
      // Try the next root.
    }
  }
  throw new Error(`calendar.module.css not found from ${process.cwd()}`)
})()

/** The body of one rule, by selector — nesting-free by construction in this file. */
function ruleBody(selector: string): string {
  const match = new RegExp(
    `(?:^|[,}]|\\*/)\\s*${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`,
    'm',
  ).exec(CSS)
  if (match === null) throw new Error(`No rule for "${selector}" in calendar.module.css`)
  return match[1] ?? ''
}

describe('the month grid columns (T2)', () => {
  it('reads its own stylesheet', () => {
    // Without this the assertions below pass just as well on an empty string.
    expect(CSS.length).toBeGreaterThan(2000)
    expect(CSS).toContain('grid-template-columns')
  })

  it('gives every column an explicit zero minimum', () => {
    expect(CSS).toContain('repeat(7, minmax(0, 1fr))')
  })

  it('never falls back to a bare `repeat(7, 1fr)`', () => {
    // The whole finding in one regex: `1fr` alone is `minmax(auto, 1fr)`.
    expect(CSS).not.toMatch(/repeat\(\s*7\s*,\s*1fr\s*\)/)
  })

  it('lets a day cell be narrower than its longest chip', () => {
    // The per-cell half of the same rule: a grid item's automatic minimum size is its content, so
    // the column's zero minimum is not enough on its own.
    expect(ruleBody('.day')).toMatch(/min-inline-size:\s*0/)
  })
})

describe('the week columns (T10)', () => {
  it('keeps a floor under the day columns, so a title has room on a phone', () => {
    // Seven equal shares of 390px is about 40px a column, which holds a time and nothing else: the
    // week view answered WHEN and never WHAT. Below the floor the strip scrolls sideways instead.
    const head = ruleBody('.weekHead,\n.weekAllDay,\n.weekBody')
    expect(head).toMatch(/repeat\(var\(--waxwing-week-days, 7\), minmax\([\d.]+rem, 1fr\)\)/)
  })

  it('scrolls the week inside its own box rather than the document', () => {
    expect(ruleBody('.week')).toMatch(/overflow:\s*auto/)
  })

  it('keeps the midnight label out from under the sticky day header', () => {
    expect(CSS).toContain('.hourLabel:first-child')
  })
})

describe('the cell overflow (T8)', () => {
  it('sets the chip leading, so three lines fit the cell they are budgeted for', () => {
    // The counter was sliced horizontally at the cell boundary because a cell is one row of a
    // six-row grid and cannot grow. Body leading spends 18px on 12px text; tight spends 15.
    expect(ruleBody('.chip')).toMatch(/line-height:\s*var\(--waxwing-leading-tight\)/)
    expect(ruleBody('.more')).toMatch(/line-height:\s*var\(--waxwing-leading-tight\)/)
  })
})
