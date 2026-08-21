/**
 * Static checks on the files stylesheet — the half of N-1 that no component test can see.
 *
 * `use-row-actions.test.tsx` checks the arithmetic that moves actions into the `⋯` menu. This file
 * checks the rule that arithmetic reads back, and that holds without it: the name's minimum width.
 * The two are not the same claim. The menu is what makes a 390px row look right; the minimum is
 * what makes it *correct* — with a stylesheet and no script the row simply breaks into two lines,
 * and the name is still legible. Delete the declaration and the hook measures a reserve of zero,
 * every action fits, and the row is back to 33px of file name with a green suite.
 *
 * Invariants, not values: "the name states a minimum and it is not zero" survives a change from
 * 12rem to 14rem, where "`.name` is 12rem" would have to be rewritten by whoever next touches the
 * design — and a check that is rewritten to stay green is a check that is gone.
 *
 * Runs in the Node "unit" project (see the root `vitest.config.ts`): it reads the CSS from disk.
 */

import { describe, expect, it } from 'vitest'
import { readAppFile } from '../ui/css-sources'

const css = readAppFile('src/files/files.module.css').text

/** The body of a rule, by selector. The file is nesting-free apart from `@media`. */
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`(^|[\\n,])\\s*${escaped}\\s*(,[^{]*)?\\{([^{}]*)\\}`).exec(css)
  if (match === null) throw new Error(`no rule for \`${selector}\``)
  return match[3] ?? ''
}

describe('a file row keeps its name readable (N-1)', () => {
  it('states a minimum width for the name', () => {
    /*
     * The measured defect: five 44px controls in a 342px row left the name 33px, so
     * `protokoll-neu.txt` read as "p" and two files in one folder were indistinguishable. `flex: 1`
     * gives the name a base size of zero, so it was never the reason the row ran out of room — it
     * was merely the only part able to shrink, and it shrank the whole way.
     */
    const name = ruleBody('.name')
    const min = /min-inline-size:\s*([\d.]+)rem/.exec(name)
    expect(min, '`.name` must state its minimum in rem, so it scales with the text').not.toBeNull()
    expect(Number(min?.[1]), 'and a minimum of zero is the defect itself').toBeGreaterThan(0)
  })

  it('lets the row break rather than squeeze the name below it', () => {
    // The safety net under the overflow menu. Where the actions cannot sit beside a name of at
    // least that width, the flex line has to have somewhere else to put them; without `wrap` the
    // minimum would simply overflow the row and take the horizontal scrollbar with it.
    expect(ruleBody('.row')).toMatch(/flex-wrap:\s*wrap/)
  })

  it('never lets a control be the thing that gives way', () => {
    // A 30px "Delete" is no more usable than one that is missing — and a shrinking action group
    // would also make the measurement circular, since its width is what decides the count.
    expect(ruleBody('.rowActions')).toMatch(/flex:\s*none/)
  })

  it('still ellipsizes what does not fit the minimum', () => {
    // The minimum is a floor, not a licence to overflow: a long name is cut with an ellipsis
    // inside its box. `overflow: hidden` is also what lets `.nameText` shrink inside `.name` at
    // all — it zeroes the flex item's automatic minimum size.
    const nameText = ruleBody('.nameText')
    expect(nameText).toMatch(/overflow:\s*hidden/)
    expect(nameText).toMatch(/text-overflow:\s*ellipsis/)
  })

  it('sizes the controls from the touch token the measurement reads back', () => {
    // `use-row-actions.ts` asks a rendered control for its `min-inline-size` rather than carrying
    // 34/44 in JavaScript. That only works while the control IS sized by the token — which
    // `IconButton` does, and which this row relies on for its own 44px folder target.
    expect(ruleBody('.name')).toMatch(/min-block-size:\s*var\(--waxwing-control-min\)/)
  })
})

/**
 * The surfaces added on 2026-08-21 (D-1, D-2, D-3), under the same rule as the row above them.
 *
 * All four findings landed on a screen whose row already could not hold what it had — which is why
 * `use-row-actions.ts` exists — so every new element here had to answer "and on a 390px phone?"
 * before it was allowed on. What follows are the four answers that are stated in CSS rather than in
 * JavaScript, and that no component test can see: jsdom reports every width as 0.
 */
describe('the phone answer for selection, search and the move picker', () => {
  it('keeps the name’s minimum while the list is in selection mode', () => {
    // A checkbox in front of the name does not make the name less the point of the row. Without
    // this the selectable row is back to the N-1 defect: `protokoll-neu.txt` as "p".
    const select = ruleBody('.selectName')
    const min = /min-inline-size:\s*([\d.]+)rem/.exec(select)
    expect(min, '`.selectName` must state the same kind of minimum `.name` does').not.toBeNull()
    expect(Number(min?.[1])).toBeGreaterThan(0)
    expect(select).toMatch(/min-block-size:\s*var\(--waxwing-control-min\)/)
  })

  it('lets the selection bar take a second line rather than scroll sideways', () => {
    // Five controls at `--waxwing-control-min` (44px under `pointer: coarse`) do not fit 390px. A
    // second line is untidy; a horizontal scroll with nothing to say it scrolls is unreachable.
    expect(ruleBody('.selectionBar')).toMatch(/flex-wrap:\s*wrap/)
  })

  it('never lets a search hit’s location be the thing that gives way', () => {
    // Same rule as `.rowActions`, one column over: "in Invoices" squeezed to "in I" states nothing,
    // and stating WHICH `report.txt` this is, is the entire reason an account-wide search is usable.
    expect(ruleBody('.location')).toMatch(/flex:\s*none/)
  })

  it('bounds the move picker so its own confirm button stays on screen', () => {
    // A level of forty folders would otherwise push the dialog footer — and with it "Move here" —
    // off the bottom of a phone, leaving a picker you can browse and cannot use.
    expect(ruleBody('.picker')).toMatch(/max-block-size:/)
    expect(ruleBody('.pickerList')).toMatch(/overflow-y:\s*auto/)
  })

  it('sizes a destination row from the touch token, like every other row target', () => {
    expect(ruleBody('.pickerItem')).toMatch(/min-block-size:\s*var\(--waxwing-control-min\)/)
  })
})
