import { describe, expect, it } from 'vitest'
import { readAppFile } from './css-sources'

/**
 * Static guard for `color-scheme` (FR-UI-02, HIG `dark-mode`).
 *
 * Waxwing paints its own surfaces from tokens, but four things on screen are drawn by the BROWSER
 * and take no CSS from us: scrollbars, the open list of a native `<select>` (a full-screen system
 * popover on iPhone and iPad), date and time pickers, and the text-selection highlight. `color-
 * scheme` is the only channel that reaches them. Without it the app was dark and those four were
 * light — and it is not a small surface: `docs/design-system.md` chooses native `<select>` on
 * purpose ("mobile pickers for free"), which only pays off if the picker knows the theme.
 *
 * Why a test rather than a comment: the declaration is invisible in every screenshot taken on a
 * light system, it has no visual effect in the light theme at all, and nothing else in the suite
 * renders a scrollbar or a system popover. It would be deleted as noise and no one would see it.
 *
 * The pairing is the actual content of the check. A single `color-scheme: light dark` on `:root`
 * would look right and be wrong: `data-theme` overrides the OS in BOTH directions (app/theme.ts),
 * so a reader forcing light on a dark Mac must get light scrollbars, which `light dark` would not
 * give them. Each theme block therefore names its own value, and this asserts all four.
 */

/** The body of the rule opened by `selector`, up to its matching brace. */
function ruleBody(css: string, selector: string): string | null {
  const at = css.indexOf(selector)
  if (at === -1) return null
  let depth = 0
  for (let i = css.indexOf('{', at); i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}' && --depth === 0) return css.slice(at, i + 1)
  }
  return null
}

const tokens = readAppFile('src/ui/tokens.css').text

/** Every block that carries a theme, with the appearance it stands for. */
const THEME_BLOCKS = [
  { name: 'light (:root)', selector: '\n  :root {', scheme: 'light' },
  { name: 'dark (OS preference)', selector: ':root:not([data-theme="light"]) {', scheme: 'dark' },
  { name: 'dark (forced)', selector: ':root[data-theme="dark"] {', scheme: 'dark' },
  { name: 'light (forced)', selector: ':root[data-theme="light"] {', scheme: 'light' },
] as const

describe('color-scheme follows the theme into the browser-drawn parts', () => {
  it.each(THEME_BLOCKS)('$name declares color-scheme: $scheme', ({ selector, scheme }) => {
    const body = ruleBody(tokens, selector)
    expect(body, `no block for ${selector} in tokens.css`).not.toBeNull()
    expect(body ?? '').toMatch(new RegExp(`color-scheme:\\s*${scheme}\\s*;`))
  })

  it('finds all four blocks (the selectors themselves can go stale)', () => {
    // Same failure mode as every other static check here: a renamed selector turns each assertion
    // above into a lookup that finds nothing, and `toBeNull` would be the only thing complaining.
    const found = THEME_BLOCKS.filter((block) => ruleBody(tokens, block.selector) !== null)
    expect(found).toHaveLength(THEME_BLOCKS.length)
  })

  it('leaves the message frame pinned to light', () => {
    // The one deliberate exception, and it must NOT follow the app: a mail body is authored HTML
    // with its own colours, overwhelmingly written against a white page. reading.module.css states
    // the reasoning at length; this only makes sure the token work above never sweeps it up.
    const reading = readAppFile('src/mail/reading.module.css').text
    expect(reading).toMatch(/color-scheme:\s*light\s*;/)
  })
})
