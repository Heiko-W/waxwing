import { describe, expect, it } from 'vitest'
import { readAppFile } from '../ui/css-sources'

/**
 * The composer's addressing rows share one label column, and they share it as one declaration.
 *
 * `composer.module.css` already states the rule in prose — *"THE SAME GRID the recipient rows use
 * (recipient-field.module.css), and that is the point … one column measurement, declared once and
 * shared, is also what stops the two halves drifting apart again"* — and then declared `2.5rem`
 * three times: once for From/Subject, once for the recipient rows, once more as a
 * `padding-inline-start` under the "did you mean" line.
 *
 * The number was also wrong, and the field this round added is what showed it. 2.5rem is 40px, which
 * `To`, `Cc`, `Bcc` and `From` fit. `Reply-To` measures about 60px and breaks at its hyphen, so the
 * row rendered "Reply-" over "To", 50px tall beside a 29px `To` — photographed at 390, 834 and 1280
 * on 2026-08-22, so it is not a narrow-viewport case. German has had the same defect longer and
 * worse: `Blindkopie` is a single 70px word with nowhere to break at all.
 *
 * Only the SHARING is checked here, because only the sharing is decidable from the text: how wide
 * 4.5rem has to be is a question about a font, and the answer was measured in a browser. What this
 * stops is the next literal — which is how all three of the last ones arrived.
 *
 * Runs in the Node "unit" project: it reads the shipped CSS from disk.
 */

const composer = readAppFile('src/compose/composer.module.css').text
const recipients = readAppFile('src/compose/recipient-field.module.css').text

/** `grid-template-columns` declarations that begin with a length rather than the property. */
const LITERAL_FIRST_TRACK = /grid-template-columns:\s*[\d.]+(rem|px|em)\s/g

describe('the composer label column', () => {
  it('is declared exactly once, and in the composer window', () => {
    const declarations = [...composer.matchAll(/--compose-label:\s*([\d.]+rem)\s*;/g)]
    expect(declarations.length, 'one definition, or it is not a shared measurement').toBe(1)
    // Inherited by `recipient-field.module.css`, which styles elements inside this one.
    expect(composer).toMatch(/\.window\s*\{[^}]*--compose-label/)
  })

  it('is read by every addressing row rather than restated', () => {
    for (const [name, css] of [
      ['composer.module.css', composer],
      ['recipient-field.module.css', recipients],
    ] as const) {
      const literals = [...css.matchAll(LITERAL_FIRST_TRACK)].map((match) => match[0])
      expect(literals, `${name} restates the label column as a literal`).toEqual([])
    }
    // And the rows really do read it — otherwise "no literals" is satisfied by a file with no grid.
    expect([...composer.matchAll(/var\(--compose-label/g)].length).toBeGreaterThanOrEqual(1)
    expect(
      [...recipients.matchAll(/var\(--compose-label/g)].length,
      'the recipient rows and the Cc/Bcc toggles under them',
    ).toBeGreaterThanOrEqual(2)
  })

  it('is what the "did you mean" line indents by, gap included', () => {
    // It used to indent by the bare column and so sat 8px to the left of the box it belongs under —
    // the identical off-by-a-gap the `.field` grid was introduced to end, still living three rules
    // below it.
    expect(recipients).toMatch(
      /\.didYouMean\s*\{[^}]*padding-inline-start:\s*calc\(\s*var\(--compose-label[^)]*\)\s*\+\s*var\(--waxwing-space-2\)\s*\)/,
    )
  })
})
