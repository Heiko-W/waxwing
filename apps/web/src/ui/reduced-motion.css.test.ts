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

/**
 * The one deliberate hole in the reset, and the reason it has to be a test.
 *
 * The reset is universal on purpose, and that is right for decoration — but a PROGRESS indicator
 * is the case where "no motion" and "no progress" look identical, so a reader with the preference
 * set was shown a still circle for the whole wait and told, by the app's own vocabulary, that it
 * had hung. HIG `progress-indicators`: "Keep progress indicators moving so people know something is
 * continuing to happen." WCAG 2.3.3 asks for reduction, not removal.
 *
 * The exemption is a `!important` override at (0,1,0), which beats the reset's `*` whatever order
 * the bundler emits — so it cannot be undone by a stylesheet reshuffle, only by deleting it. This
 * is what notices the deletion. It is deliberately narrow: `.shimmer` in Skeleton.module.css is NOT
 * exempt, because a placeholder that stops shimmering still shows its shape.
 */
describe('progress indicators keep moving under reduced motion', () => {
  it.each([
    { file: 'src/ui/Spinner.module.css', selector: '.ring' },
    { file: 'src/app/shell/shell.module.css', selector: '.statusSpin' },
  ])('$selector in $file slows down instead of stopping', ({ file, selector }) => {
    // Every reduced-motion block in the file, not just the first: shell.module.css has two, and a
    // test that reads only one of them would go quietly vacuous the day they are reordered.
    const css = readAppFile(file).text
    const blocks: string[] = []
    for (let rest = css; ; ) {
      const block = reducedMotionBlock(rest)
      if (block === null) break
      blocks.push(block)
      rest = rest.slice(rest.indexOf(block) + block.length)
    }
    expect(blocks.length, `no reduced-motion block in ${file}`).toBeGreaterThan(0)
    const reduce = blocks.join('\n')
    // `animation: none` is the shape this replaced — it satisfies the reset and defeats the point.
    expect(reduce, `${selector} must stay in motion, slowly`).toMatch(
      new RegExp(
        `\\${selector}\\s*\\{[^}]*animation-iteration-count\\s*:\\s*infinite\\s*!important`,
        's',
      ),
    )
    expect(reduce).toMatch(
      /animation-duration:\s*var\(--waxwing-duration-spin-reduced\)\s*!important/,
    )
  })

  it('keeps the slow period well clear of the normal one', () => {
    // A "reduced" period that is not visibly slower is a placebo. The normal spin is 900ms.
    const tokens = readAppFile('src/ui/tokens.css').text
    const normal = /--waxwing-duration-spin:\s*(\d+)ms/.exec(tokens)?.[1]
    const reduced = /--waxwing-duration-spin-reduced:\s*(\d+)ms/.exec(tokens)?.[1]
    expect(normal, 'no --waxwing-duration-spin in tokens.css').toBeDefined()
    expect(reduced, 'no --waxwing-duration-spin-reduced in tokens.css').toBeDefined()
    expect(Number(reduced)).toBeGreaterThanOrEqual(2 * Number(normal))
  })
})
