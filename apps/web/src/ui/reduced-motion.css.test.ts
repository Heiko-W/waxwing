import { describe, expect, it } from 'vitest'
import { collectSources, lineOf, readAppFile, type SourceFile } from './css-sources'

/**
 * Static guard for `prefers-reduced-motion` (M4.7, FR-A11Y-01, WCAG 2.3.3).
 *
 * The app honours the preference with **one universal CSS reset** in `global.css` — no JS, no
 * per-component opt-in. That is the right design, and it has exactly one failure mode: motion that
 * the CSS cascade cannot reach.
 *
 * Two things escape it:
 *
 * 1. **The reset itself going missing or losing its `!important`.** Every component style is more
 *    specific than `*`, so without `!important` the reset silently stops working and every animation
 *    in the app comes back. Nothing else in the suite would notice.
 * 2. **JS-driven motion.** `element.animate()` and `scrollIntoView({behavior: 'smooth'})` are not
 *    styled by CSS at all — a reduced-motion user gets the animation regardless. Today the app has
 *    neither; this keeps it that way, or forces the author to reach for `matchMedia` deliberately.
 *
 * `scroll-behavior: smooth` in a stylesheet IS reachable by the cascade, but only because the reset
 * overrides it by name — so the reset's own coverage of it is asserted rather than assumed.
 *
 * Runs in the Node "unit" project: reads the shipped sources from disk, which the jsdom project
 * cannot do (vitest stubs `.css` imports to empty there).
 */

/** The reduced-motion block in `global.css`, from `@media` to its closing brace. */
function reducedMotionBlock(css: string): string | null {
  const start = css.search(/@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)\s*\{/)
  if (start === -1) return null
  let depth = 0
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}' && --depth === 0) return css.slice(start, i + 1)
  }
  return null
}

/**
 * JS motion APIs the CSS reset cannot touch. `scrollIntoView` is only listed in its SMOOTH form:
 * the default (`auto`) resolves through `scroll-behavior`, which the reset does pin.
 */
const JS_MOTION = [
  { pattern: /\.animate\s*\(/g, what: 'Element.animate()' },
  { pattern: /behavior\s*:\s*['"]smooth['"]/g, what: "behavior: 'smooth'" },
] as const

/**
 * A call may opt out with `waxwing-motion-exempt: <reason>` in the same file, where the reason is
 * mandatory and length-checked — the shape `focus-indicator.css.test.ts` uses, for the same reason:
 * an exemption cannot be added without stating why.
 */
const EXEMPT_MARKER = /waxwing-motion-exempt:\s*(\S[^*\n]{15,})/

const globalCss = readAppFile('src/ui/global.css')
const block = reducedMotionBlock(globalCss.text)
const scripts: SourceFile[] = collectSources('src', ['.ts', '.tsx']).filter(
  (file) => !/\.test\.tsx?$/.test(file.path),
)

describe('prefers-reduced-motion is honoured by construction', () => {
  it('ships the universal reset in global.css', () => {
    expect(block, 'no (prefers-reduced-motion: reduce) block in global.css').not.toBeNull()
    // The universal selector is the whole point: a per-component list would drift the moment
    // someone adds an animation without reading this file.
    expect(block).toMatch(/(^|[\s,{])\*(\s|,|::)/)
  })

  it.each([
    'animation-duration',
    'animation-iteration-count',
    'transition-duration',
    'scroll-behavior',
  ])('overrides %s with !important', (property) => {
    // Without `!important` the reset loses to every component rule — `.row { transition: … }` is
    // (0,1,0) and beats `*` at (0,0,0). The suppression would be there in the stylesheet and have
    // no effect whatsoever, which is the worst of both worlds.
    expect(block ?? '').toMatch(new RegExp(`${property}\\s*:[^;]*!important`))
  })

  it('leaves no JS-driven motion that the reset cannot reach', () => {
    const found: string[] = []
    for (const file of scripts) {
      if (EXEMPT_MARKER.test(file.text)) continue
      for (const { pattern, what } of JS_MOTION) {
        for (const match of file.text.matchAll(pattern)) {
          found.push(`${file.path}:${lineOf(file.text, match.index)} — ${what}`)
        }
      }
    }
    // If this fails, the fix is not to add the file here: guard the call with
    // `matchMedia('(prefers-reduced-motion: reduce)').matches` and record why in the exempt marker.
    expect(found, 'JS motion bypasses the CSS reduced-motion reset').toEqual([])
  })

  it('scans a plausible number of files (the walk itself can go vacuous)', () => {
    // B22: a check that silently stops looking passes forever. Guards a path or glob change.
    expect(scripts.length).toBeGreaterThan(100)
  })
})
