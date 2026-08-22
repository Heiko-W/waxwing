import { describe, expect, it } from 'vitest'
import { readAppFile, type SourceFile } from './css-sources'

/**
 * A control reaches `--waxwing-control-min` in BOTH axes, and says so in CSS.
 *
 * `target-size.spec.ts` has always asserted this — "`--waxwing-control-min` is 34px on pointer
 * devices and 44px on touch (tokens.css), and every BUTTON is supposed to reach it" — but it can
 * only assert it about the controls that happen to be on the four screens it visits, and it needs a
 * live browser and the Stalwart fixture to do that. `Button` pinned its height from the token and
 * left its WIDTH to whatever the label measured, which nothing on those four screens revealed.
 *
 * It was wrong wherever a label was short. Measured on a real `hasTouch` context, 2026-08-22:
 * the Files breadcrumb's "Files" rendered 43 × 44 and the filter row's "Edit" 39 × 44, against a
 * 44px minimum. Neither screen is in `target-size.spec.ts`, and jsdom computes no layout, so
 * nothing in the repository could see either one.
 *
 * So the claim is checked where it is decidable without a browser: the primitives that ARE the hit
 * area state both minimums, from the token rather than from a number. That is a weaker statement
 * than "every rendered control is 44px" and a much stronger one than "the four screens we visit
 * are" — and it is the one that holds for controls on screens no suite has yet been written for.
 *
 * Runs in the Node "unit" project: it reads the shipped CSS from disk.
 */

function read(path: string): SourceFile {
  return readAppFile(path)
}

/** The body of a rule, by selector. These files are nesting-free apart from `@media`. */
function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`(^|[\\n,])\\s*${escaped}\\s*(,[^{]*)?\\{([^{}]*)\\}`).exec(css)
  if (match === null) throw new Error(`no rule for \`${selector}\``)
  return match[3] ?? ''
}

describe('control minimum size', () => {
  it('.button states both minimums from the token', () => {
    // Every control in the app is this rule or composes it, so this one declaration is the whole
    // hit area. The token, not a number: 34 and 44 are one media query apart, and a literal picks
    // one of them for every device.
    const body = ruleBody(read('src/ui/Button.module.css').text, '.button')
    expect(body, 'block axis').toMatch(/min-block-size:\s*var\(--waxwing-control-min\)/)
    expect(body, 'inline axis — a short label is how a button ends up 39px wide').toMatch(
      /min-inline-size:\s*var\(--waxwing-control-min\)/,
    )
  })

  it('.iconButton keeps its own square minimum', () => {
    // It composes `.button` for the block axis and overrides the inline padding, so its width is
    // its own business — and it has always said so. Asserted here so the two stay one rule.
    const body = ruleBody(read('src/ui/IconButton.module.css').text, '.iconButton')
    expect(body).toMatch(/min-inline-size:\s*var\(--waxwing-control-min\)/)
    expect(body, 'square, so the block minimum it inherits decides both').toMatch(
      /aspect-ratio:\s*1/,
    )
  })

  it("sizes the file picker's own button from the token too", () => {
    /*
     * The one control in the app the user agent draws. Four screens hand out a bare
     * `<input type="file">` — .ics into the calendar, .eml into a folder, a vCard into the address
     * book, a photo onto a contact — and Chrome's default is 21px tall, measured in the ICS dialog
     * at 390, 834 and 1280 alike. That is under SC 2.5.8's 24px floor at every width, on a control
     * whose whole job is to be pressed.
     *
     * `global.css` rather than four stylesheets: it is a fact about the element, so the fifth
     * picker inherits it without being told.
     */
    const css = read('src/ui/global.css').text
    const rule = /input\[type="file"\]::file-selector-button\s*\{([^}]*)\}/.exec(css)
    expect(rule, 'no rule styles the file picker button').not.toBeNull()
    expect(rule?.[1] ?? '').toMatch(/min-block-size:\s*var\(--waxwing-control-min\)/)
    expect(rule?.[1] ?? '').toMatch(/min-inline-size:\s*var\(--waxwing-control-min\)/)
  })

  it('keeps the token itself larger on touch than on a pointer', () => {
    // Without this the two assertions above are satisfied by a token that has been shrunk to
    // nothing, which is the same hole `target-size.spec.ts` documents for its own floor.
    const tokens = read('src/ui/tokens.css').text
    const values = [...tokens.matchAll(/--waxwing-control-min:\s*([\d.]+)rem/g)].map((m) =>
      Number(m[1]),
    )
    expect(values.length, 'a pointer value and a coarse one').toBe(2)
    const [fine = 0, coarse = 0] = values
    expect(fine, 'SC 2.5.8 AA asks 24px; 24/16 = 1.5rem').toBeGreaterThanOrEqual(1.5)
    expect(coarse, 'touch is the larger of the two').toBeGreaterThan(fine)
  })
})
