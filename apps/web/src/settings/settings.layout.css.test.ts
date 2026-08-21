/**
 * Static checks on the settings stylesheets — the layer nothing else in this repo can see.
 *
 * jsdom computes no styles, so a component test cannot tell a row that is inset from one whose text
 * starts a pixel behind the card border, nor a rail that scrolls from one that is silently cut off
 * below the fold. Every finding pinned here was invisible to a green suite for exactly that reason,
 * and each has the same shape: a rule *stated in one place* and *relied on in eleven*. So the check
 * is on the statement — the same move `ui/display-type.css.test.ts` makes.
 *
 * These assert INVARIANTS, not values: "the inset is declared on the card and on no one kind of
 * row" survives a change from 12px to 14px, where "`.field` has `padding: 12px 16px`" would not,
 * and a check that has to be edited every time the design is touched is a check that gets deleted.
 *
 * Runs in the Node "unit" project (see the root `vitest.config.ts`): it reads the shipped CSS from
 * disk.
 */

import { describe, expect, it } from 'vitest'
import { readAppFile } from '../ui/css-sources'

const css = readAppFile('src/settings/settings.module.css').text
const filtersCss = readAppFile('src/settings/sieve/filters.module.css').text

/** The body of a rule, by selector. Both files are nesting-free apart from `@media`. */
function ruleBody(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`(^|[\\n,])\\s*${escaped}\\s*(,[^{]*)?\\{([^{}]*)\\}`).exec(source)
  if (match === null) throw new Error(`no rule for \`${selector}\``)
  return match[3] ?? ''
}

/**
 * Everything inside every `@media <query> { … }` block, concatenated.
 *
 * Every, not the first: the phone breakpoint appears twice in this stylesheet (the rules between
 * rail rows, and the layout switch), and "which of the two" is not part of any claim made below.
 */
function mediaBlock(source: string, query: string): string {
  const blocks: string[] = []
  for (let from = 0; ; ) {
    const start = source.indexOf(`@media ${query}`, from)
    if (start === -1) break
    let depth = 0
    let end = source.length
    for (let i = source.indexOf('{', start); i < source.length; i++) {
      if (source[i] === '{') depth += 1
      if (source[i] === '}') {
        depth -= 1
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    blocks.push(source.slice(start, end))
    from = end + 1
  }
  if (blocks.length === 0) throw new Error(`no @media ${query}`)
  return blocks.join('\n')
}

const PHONE = '(max-width: 39.999em)'
const WIDE = '(min-width: 40em)'

describe('the settings card owns the inset of its rows', () => {
  it('states it once, on the card', () => {
    // It was on `.field` alone. Every row that was not a `.field` — a paragraph, a `<dl>`, a
    // `<ul>`, a `<fieldset>`, a rich-text editor, a lone button — therefore had `padding: 0` and
    // began one pixel behind the border, clipping the first letter of nine sections' text.
    expect(ruleBody(css, '.controls > *')).toMatch(/padding:/)
  })

  it('and does not ALSO state it on one particular kind of row', () => {
    // Two statements of one rule is how the two drifted apart, and dropping the second is what
    // lets `.field` be reused in a dialog, where there is no card to be inset from.
    expect(ruleBody(css, '.field')).not.toMatch(/padding/)
    expect(ruleBody(css, '.group')).not.toMatch(/padding/)
  })

  it('lets a button keep the width of its own words', () => {
    // A flex column stretches its items: a button that was a direct child of the card came out
    // 668px wide, one inside a `.field` came out 352px with its caption stranded in the middle,
    // and a third came out at its natural 148px — three widths for four buttons of equal rank.
    expect(ruleBody(css, '.field > button')).toMatch(/align-self:\s*flex-start/)
    expect(ruleBody(filtersCss, '.foreign > button')).toMatch(/align-self:\s*flex-start/)
  })
})

describe('the rail is scrollable where it is the whole screen', () => {
  it('is the FLEXIBLE box once it sits above the panel rather than beside it', () => {
    // `flex: 0 0 auto` pins the WIDTH beside the panel and the HEIGHT above it, so the rail grew
    // to its content, its own `overflow-y: auto` had nothing to scroll, and `.page { overflow:
    // hidden }` cut the surplus off: three of fourteen sections were off-page and untappable on a
    // 390×844 phone, with `elementFromPoint` returning null over all three.
    const rail = ruleBody(mediaBlock(css, PHONE), '.rail')
    const flex = /flex:\s*([^;]+);/.exec(rail)?.[1]?.trim()
    expect(flex, 'the phone rail must re-declare `flex`').toBeDefined()
    const [grow = '0', shrink = '0'] = (flex ?? '').split(/\s+/)
    expect(Number(grow), 'it must take the height the page has left over').toBeGreaterThan(0)
    expect(Number(shrink), 'and be allowed to end up shorter than its content').toBeGreaterThan(0)
  })

  it('keeps the `min-block-size: 0` that lets it shrink at all', () => {
    // Without it a flex item's automatic minimum is its own content height, and `flex: 1 1 0`
    // would reproduce the defect exactly.
    expect(ruleBody(css, '.rail')).toMatch(/min-block-size:\s*0/)
    expect(ruleBody(css, '.rail')).toMatch(/overflow-y:\s*auto/)
  })
})

describe('a panel heading is not a rail caption', () => {
  it('does not repeat the rail-group recipe two points larger', () => {
    // Both were semibold, uppercase, caps-tracked and muted, differing in 14px against 12px — so
    // "GENERAL" appeared twice on one screen in one mark: once naming a group of destinations,
    // once naming the open panel.
    const caption = ruleBody(css, '.railGroupTitle')
    const title = ruleBody(css, '.sectionTitle')
    expect(caption).toMatch(/text-transform:\s*uppercase/)
    expect(title).not.toMatch(/text-transform/)
    expect(title).not.toMatch(/tracking-caps/)
    expect(title).not.toMatch(/text-muted/)
  })
})

describe('a list of records inside the card is rows, not a second card (G2)', () => {
  it('draws no edge of its own on an identity row', () => {
    // The `<li>` carried `border`, `border-radius` and `background`, so it drew a bordered box
    // exactly 1px inside the card's: card `x=480 w=672`, row `x=481 w=670`, two concentric arcs at
    // every corner. The `.controls` rework took that shape out of thirteen sections and missed
    // this one, because the offender is an `<li>` and not a nested `.controls` — which is also why
    // the "exactly one card per section" count in `settings.test.tsx` cannot see it, and why the
    // check lives here.
    const row = ruleBody(css, '.identityRow')
    expect(row, 'no border, no radius — a row has neither').not.toMatch(/border/)
    expect(row, 'and no surface of its own: the card is the surface').not.toMatch(/background/)
  })

  it('separates the rows the way the card separates its own', () => {
    // Removing the boxes must not run the records together — a list of addresses is read down a
    // column of rules, exactly like the rows of every other section.
    expect(ruleBody(css, '.identityRow + .identityRow')).toMatch(/border-block-start:/)
  })

  it('gives the rows the card inset the `<ul>` cannot pass on', () => {
    // `.controls > *` insets the LIST, whose rows would then start at the card's border. The list
    // opts out (`padding: 0`) and the rows take the same inset, so an identity lines up with every
    // other row on the screen rather than one gap further in or out.
    expect(ruleBody(css, '.identityList')).toMatch(/padding:\s*0/)
    expect(ruleBody(css, '.identityRow')).toMatch(/padding:/)
  })
})

describe('the phone heading is the page title, and the cascade has to agree', () => {
  it('states the phone size AFTER the base rule it overrides', () => {
    /*
     * Both selectors are one class, and a media query does not raise specificity — so this is
     * decided purely by which rule comes last. The phone override was written inside the layout
     * `@media` block two hundred lines ABOVE `.sectionTitle`, which meant `text-lg` won and every
     * section heading on a phone rendered at 18px next to 17px labels: the 28px was dead code that
     * no test and no green suite could see, because the query itself matched and its other
     * declaration (`flex: 1 1 0` on the rail) arrived correctly.
     *
     * Source ORDER is the invariant, not the two sizes: it survives a change from 28px to 26px,
     * and it is the thing that was wrong.
     */
    const base = /^\.sectionTitle\s*\{/m.exec(css)
    const phone = /^[ \t]+\.sectionTitle\s*\{/m.exec(css)
    expect(base, 'the base rule must exist to be overridden').not.toBeNull()
    expect(phone, 'the phone override must exist at all').not.toBeNull()
    expect(phone?.index).toBeGreaterThan(base?.index ?? 0)
  })

  it('overrides it inside the phone query and nowhere else', () => {
    // If the override ever moves back out of a media query it stops being an override and starts
    // being the size everywhere, which is the opposite mistake and just as invisible.
    expect(mediaBlock(css, PHONE)).toMatch(/\.sectionTitle\s*\{/)
    expect(ruleBody(mediaBlock(css, PHONE), '.sectionTitle')).toMatch(/font-size:/)
  })
})

describe('the page bounds itself rather than trailing off', () => {
  it('caps its width and centres the remainder', () => {
    // At 1920px the two columns ended at x≈1048 with 872px of nothing to the right of them. The
    // measure stays — a settings row a thousand pixels wide cannot be paired up by eye — so the
    // leftover space is put on BOTH sides, where it reads as margin rather than as a gap.
    const page = ruleBody(css, '.page')
    expect(page).toMatch(/max-inline-size:/)
    expect(page).toMatch(/margin-inline:\s*auto/)
  })
})

describe('one form, one right edge', () => {
  it('sets no width cap on the plain-text signature', () => {
    // At 34rem it stopped 91px short of the inputs above it and the rich-text editor below it:
    // one column of fields, three right edges.
    expect(ruleBody(css, '.textarea')).not.toMatch(/max-inline-size/)
  })

  it('caps neither the value tables nor the record lists', () => {
    // 22rem and 34rem pulled the value column into the middle of the card and left up to 317px of
    // nothing to the right of a column of numbers — which is read down its right edge.
    expect(ruleBody(css, '.breakdown')).not.toMatch(/max-inline-size/)
    expect(ruleBody(css, '.fieldset')).not.toMatch(/max-inline-size/)
    expect(ruleBody(css, '.identityList')).not.toMatch(/max-inline-size/)
  })

  it('gives every field on a shared line the same share of it', () => {
    // A `<select>` sizes itself from its own longest option, so six lines of the rule form ended
    // at 320, 224, 208, 252, 256 and 192px.
    expect(ruleBody(filtersCss, '.rowField')).toMatch(/flex:\s*1 1 /)
  })
})

describe('label-beside-value is the shape of a settings LIST, not of a form', () => {
  it('is scoped to the card, so a dialog form is never half in that shape', () => {
    // Unscoped it produced ONE row and six stacked-looking ones in the same form: each of those
    // six sat in a 22rem fieldset that a 22rem control plus a label overflows, so they wrapped —
    // they were rows pretending to be a stack, which is why they lined up with nothing.
    const wide = mediaBlock(css, WIDE)
    const selectors = [...wide.matchAll(/(^|\n)\s*([^{}\n]*\.field[^{}\n]*)\{/g)].map((match) =>
      (match[2] ?? '').trim(),
    )
    expect(selectors.length, 'the rule must still be there to be scoped').toBeGreaterThan(2)
    for (const selector of selectors) {
      expect(selector, 'side-by-side belongs to the card').toMatch(/^\.controls\s/)
    }
  })

  it('has a named stacked row for a value that is a BLOCK', () => {
    // `align-items: center` puts the label in the vertical middle of the row, which on a 296px
    // block is the middle of an otherwise empty column. `.group` is the opt-out that says so by
    // name, and the rule must not reach it.
    expect(css).toMatch(/\.group\s*\{/)
    expect(mediaBlock(css, WIDE)).not.toMatch(/\.group/)
  })
})
