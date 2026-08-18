import { describe, expect, it } from 'vitest'
import { collectSources, readAppFile } from './css-sources'

/**
 * The colour table in `docs/design-system.md` must match `tokens.css`.
 *
 * It did not. Four rows had drifted — `accent` and `focus-ring` in both themes, `danger` dark and
 * `success` light — and the accent is the colour the entire palette is built around. That matters
 * more here than in an ordinary doc: `design-system.md` names itself the document decision **D5**
 * (design-system sign-off) was taken against, so a stale table quietly devalues the sign-off. And it
 * is exactly the kind of drift nothing catches, because prose cannot fail a build.
 *
 * Deliberately checks only the LIGHT and DARK hex values, not the role descriptions: the prose is
 * meant to be edited by hand, the numbers are not.
 */

const DOC = '../../docs/design-system.md'

/** `| `--waxwing-accent` | `#2761c4` | `#82acf5` | Brand fill — … |` → the two hex values. */
const ROW =
  /^\|\s*`(--waxwing-[a-z0-9-]+)`\s*\|\s*`(#[0-9a-fA-F]{3,8})`\s*\|\s*`(#[0-9a-fA-F]{3,8})`\s*\|/gm

/** The first `:root` block (light) and the `prefers-color-scheme: dark` block. */
function themeBlocks(css: string): { light: string; dark: string } {
  const light = /:root\s*\{[\s\S]*?\n {2}\}/.exec(css)?.[0] ?? ''
  const dark = /@media \(prefers-color-scheme: dark\)[\s\S]*?\n {2}\}/.exec(css)?.[0] ?? ''
  return { light, dark }
}

/** The literal hex a token resolves to in one block, following one level of `var(--x, #hex)`. */
function hexOf(block: string, token: string): string | undefined {
  const raw = new RegExp(`${token}:\\s*([^;]+);`).exec(block)?.[1]?.trim()
  return raw === undefined ? undefined : (/#[0-9a-fA-F]{3,8}/.exec(raw)?.[0]?.toLowerCase() ?? raw)
}

describe('the design system document', () => {
  const css = collectSources('src', ['.css']).find((f) => f.path.endsWith('ui/tokens.css'))
  const doc = readAppFile(DOC)

  it('finds both files (a scan that matches nothing must not pass)', () => {
    expect(css, 'apps/web/src/ui/tokens.css').toBeDefined()
    expect(doc.text.length).toBeGreaterThan(1000)
  })

  it('quotes the colour values that tokens.css actually defines', () => {
    const { light, dark } = themeBlocks(css?.text ?? '')
    const mismatches: string[] = []
    let rows = 0

    for (const [, token, docLight, docDark] of doc.text.matchAll(ROW)) {
      if (token === undefined || docLight === undefined || docDark === undefined) continue
      rows += 1
      const realLight = hexOf(light, token)
      const realDark = hexOf(dark, token)
      // A token the dark block does not re-declare inherits the light value.
      const expectedDark = realDark ?? realLight
      if (realLight !== undefined && docLight.toLowerCase() !== realLight) {
        mismatches.push(`${token} light: doc ${docLight}, tokens.css ${realLight}`)
      }
      if (expectedDark !== undefined && docDark.toLowerCase() !== expectedDark) {
        mismatches.push(`${token} dark: doc ${docDark}, tokens.css ${expectedDark}`)
      }
    }

    expect(rows, 'the table parser matched no rows — the doc format changed').toBeGreaterThan(8)
    expect(
      mismatches,
      'docs/design-system.md §2.1 disagrees with apps/web/src/ui/tokens.css. The CSS is the source ' +
        'of truth; update the table.',
    ).toEqual([])
  })
})
