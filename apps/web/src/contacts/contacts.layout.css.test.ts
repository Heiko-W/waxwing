/**
 * Static checks on the contacts stylesheet — the two findings of the 21 August walkthrough that are
 * pure layout, pinned as rules rather than as pixels.
 *
 * jsdom computes no styles, so no component test in this folder can see a button pushed 29px past
 * the right edge of a 390px phone or a value field 36px narrower than the picker beside it. Both
 * were shipped and both were invisible to a green suite, which is the situation
 * `settings/settings.layout.css.test.ts` and `ui/display-type.css.test.ts` already answer: check the
 * STATEMENT, in the file that makes it.
 *
 * These assert invariants, not values. "The row may wrap and the value asks for more width than the
 * picker" survives a change from 9rem to 10rem; "`.commType` is 9rem" would have to be rewritten by
 * the next person who touches the design, and a check that is rewritten to stay green is a check
 * that is gone.
 *
 * Runs in the Node "unit" project (see the root `vitest.config.ts`): it reads the CSS from disk.
 */

import { describe, expect, it } from 'vitest'
import { readAppFile } from '../ui/css-sources'

const css = readAppFile('src/contacts/contacts.module.css').text

/** The body of a rule, by selector. The file is nesting-free apart from `@media`. */
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`(^|[\\n,])\\s*${escaped}\\s*(,[^{]*)?\\{([^{}]*)\\}`).exec(css)
  if (match === null) throw new Error(`no rule for \`${selector}\``)
  return match[3] ?? ''
}

/** A length in `rem`, so two boxes stated in the same unit can be compared. */
function remOf(declaration: string | undefined): number {
  const value = /(-?[\d.]+)rem/.exec(declaration ?? '')?.[1]
  expect(value, `\`${declaration}\` must state a rem length`).toBeDefined()
  return Number(value)
}

describe('the contact header never puts a control off the screen (F2)', () => {
  it('wraps instead of overflowing', () => {
    // Three content-sized boxes in a non-wrapping row have no way to fail gracefully: at 390px
    // "More actions" was measured at x = 373…419, i.e. 29px of it outside the viewport, and at
    // 820px both it and "Edit" ran past the pane's edge. A row that may wrap gives the actions a
    // line of their own instead — which is what Apple Contacts shows on a phone anyway.
    expect(ruleBody('.detailHeader')).toMatch(/flex-wrap:\s*wrap/)
  })

  it('never lets the buttons be the thing that gives way', () => {
    // `flex-shrink` on the action group would squeeze the buttons themselves — a 30px "Delete" is
    // no more usable than one off the edge. They keep their size; the wrap is the release valve.
    const actions = ruleBody('.detailActions')
    expect(actions).toMatch(/flex:\s*0\s+0\s+auto/)
  })

  it('keeps the name inside its own box', () => {
    /*
     * The overlap half of F2, which is a separate defect from the overflow: `.detailIdentity` is
     * allowed to shrink to nothing (`min-inline-size: 0`), and a heading in a shrunken box does not
     * shrink with it — it draws straight over whatever is beside it. That is how "Delete" came to
     * be printed through the second line of a contact's name on all three viewports.
     *
     * Both halves are needed and neither implies the other: the wrap decides where the buttons go,
     * the clamp decides that the name stops at its own edge.
     */
    const name = ruleBody('.detailName')
    expect(name, 'a long word must break rather than spill').toMatch(/overflow-wrap:\s*anywhere/)
    expect(name, 'and the box must clip what is left').toMatch(/overflow:\s*hidden/)
    expect(name).toMatch(/-webkit-line-clamp:/)
  })

  it('gives the name a share of the row rather than all of it', () => {
    // `flex: 1` (basis 0) would let the identity claim the whole line and wrap the actions even on
    // a desktop; a basis states the width below which the two stop sharing a line.
    const identity = ruleBody('.detailIdentity')
    expect(identity).toMatch(/flex:\s*1\s+1\s+[\d.]+rem/)
    expect(identity, 'and it still has to be allowed to shrink').toMatch(/min-inline-size:\s*0/)
  })
})

describe('a communication row favours the field over the picker (N2)', () => {
  it('asks for more width for the value than the type picker takes', () => {
    // The measured defect: 108px of value against 144px of picker on a tablet, showing
    // "spiel-firma.de" of a perfectly ordinary address. The comparison is between the two
    // DECLARATIONS, so it holds at every viewport — which is the point, since the previous fix was
    // a fixed width chosen at one.
    const picker = remOf(/inline-size:\s*[^;]+/.exec(ruleBody('.commType'))?.[0])
    const value = remOf(/flex:\s*\d+\s+\d+\s+[^;]+/.exec(ruleBody('.commValue'))?.[0])
    expect(value, 'the field being typed into is the wider box').toBeGreaterThan(picker)
  })

  it('lets the row wrap where it cannot seat both', () => {
    // Because there IS a width where 9rem + 12rem + a remove button do not fit, and the answer to
    // that must not be to ration the value down to a third of the picker. Wrapped, the field gets
    // the whole row — still the wider of the two.
    expect(ruleBody('.commRow')).toMatch(/flex-wrap:\s*wrap/)
  })

  it('does not let the picker grow at the value field’s expense', () => {
    // `flex: none` — spare width goes to the value, always. A picker that grew would put the ratio
    // back the wrong way round on exactly the wide screens where it currently looks fine.
    expect(ruleBody('.commType')).toMatch(/flex:\s*none/)
  })
})
