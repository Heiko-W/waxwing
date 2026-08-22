/**
 * Static checks on the share dialog's phone layout — the half no component test can see.
 *
 * jsdom has no layout: `getBoundingClientRect` is all zeros and no media query ever applies, so a
 * rendering test can prove the row EXISTS and never that it fits. The person row carries a name, an
 * address, a role picker and a remove button; at 390 px that is four things fighting over ~330 px,
 * and the loser is always the name — the only part that says who the row is about.
 *
 * Invariants, not values: "the row wraps below the phone breakpoint and the name claims a full line"
 * survives a change from `flex-basis: 100%` to a grid, where "`.shareName` is 100%" would have to be
 * rewritten by whoever next touches the design — and a check that is rewritten to stay green is a
 * check that is gone.
 *
 * Runs in the Node "unit" project (see the root `vitest.config.ts`): it reads the CSS from disk.
 */

import { describe, expect, it } from 'vitest'
import { readAppFile } from '../ui/css-sources'

const css = readAppFile('src/sharing/sharing.module.css').text

/** The `@media (max-width: …)` block's body — everything the phone layout says. */
function phoneBlock(): string {
  const start = css.search(/@media\s*\(max-width:/)
  expect(start, 'the stylesheet states no phone layout at all').toBeGreaterThan(-1)
  return css.slice(start)
}

/** The body of a rule inside `source`, by selector. */
function ruleBody(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`(^|[\\n,])\\s*${escaped}\\s*(,[^{]*)?\\{([^{}]*)\\}`).exec(source)
  if (match === null) throw new Error(`no rule for \`${selector}\``)
  return match[3] ?? ''
}

describe('a person row stays readable on a phone', () => {
  it('breaks onto a second line rather than squeezing four controls into one', () => {
    expect(ruleBody(phoneBlock(), '.shareRow')).toMatch(/flex-wrap:\s*wrap/)
  })

  it('gives the name a line of its own, so it is never the part that shrinks', () => {
    // `flex: 1` gives the name a base size of zero: it was never the reason the row ran out of
    // room, it was merely the only part able to shrink — and it shrank the whole way.
    const name = ruleBody(phoneBlock(), '.shareName')
    expect(name).toMatch(/flex-basis:\s*100%/)
  })

  it('keeps the role picker at a 44 px target', () => {
    // The dialog uses a NATIVE `select` on every viewport precisely so a phone gets the platform's
    // own wheel. A 44 px target is the point of that; NFR/target-size asks for it everywhere else.
    const select = ruleBody(phoneBlock(), '.shareRow select')
    const min = /min-block-size:\s*([\d.]+)rem/.exec(select)
    expect(min, '.shareRow select states no minimum height').not.toBeNull()
    expect(Number(min?.[1] ?? 0)).toBeGreaterThanOrEqual(2.75)
  })

  it('stacks the search field and the role picker instead of halving both', () => {
    expect(ruleBody(phoneBlock(), '.shareControls')).toMatch(/flex-direction:\s*column/)
  })
})

/**
 * The same row at every OTHER width, which the block above never looked at.
 *
 * The phone case had been thought about and stated in CSS; the wide case had not, and that is where
 * it was broken. `Select`'s wrapper is `inline-size: 100%` — right in a form column, wrong in a row
 * whose content is a person — so as a flex item it based itself on the WHOLE row while `.shareName`
 * (`flex: 1`) based itself on nothing. Measured at 834 px and 1280 px on 2026-08-22:
 * `carol@waxwing.test` rendered 0 px wide. "Who has access" showed a role picker and a Remove button
 * and did not say whose access it was, on the one surface whose entire subject is who.
 *
 * The second half of the same row: `Button`'s inner `.label` sets `min-inline-size: 0`, so a
 * shrinking button has no content minimum either and "Remove" came out as "Rem / ove" on two lines.
 *
 * Both are one declaration — the controls do not flex — which is why they are one test.
 */
describe('a person row stays readable at every other width', () => {
  /** Everything before the phone block: the rules that apply at all widths. */
  const wide = css.slice(0, css.search(/@media\s*\(max-width:/))

  it('lets the name flex and nothing else', () => {
    expect(ruleBody(wide, '.shareName')).toMatch(/flex:\s*1/)
    expect(
      ruleBody(wide, '.shareRow > :not(.shareName)'),
      'a control sized by what is left over is a control that disappears',
    ).toMatch(/flex:\s*none/)
  })

  it("undoes the role picker's full-width sizing, which flex: none would otherwise freeze", () => {
    // `flex: none` keeps the base size, and `Select`'s base size in a row IS the row.
    expect(ruleBody(wide, '.shareRow > div:has(> select)')).toMatch(/inline-size:\s*auto/)
  })
})

describe('the phone rules are scoped to a phone', () => {
  it('uses the same breakpoint the rest of the app does', () => {
    // 39.999em — one em short of 40em, the value eight other stylesheets in this app already use.
    // A second, nearly-identical breakpoint is how a layout comes apart in a 4 px band nobody tests.
    expect(css).toMatch(/@media\s*\(max-width:\s*39\.999em\)/)
  })
})
