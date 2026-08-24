import { describe, expect, it } from 'vitest'
import { collectSources, lineOf, readAppFile, type SourceFile } from './css-sources'

/**
 * Static guard for the display safe areas (HIG `layout`, "Guides and safe areas"; `status-bars`).
 *
 * The document ships `viewport-fit=cover` and the manifest is `display: standalone`, so an
 * installed Waxwing draws edge to edge: under the Dynamic Island, over the home indicator, and past
 * the rounded corners in landscape. Before 2026-08-24 exactly ONE of the four insets was read, in
 * two rules — so the phone header, which carries the entire mail chrome on that viewport, padded
 * 8 px against the status bar.
 *
 * Two things are asserted here, and both are about a mistake that is invisible on a developer's
 * machine:
 *
 * 1. **`env()` is spelled only in tokens.css.** `env(safe-area-inset-left)` is a PHYSICAL edge and
 *    every layout rule in this app is logical. A hand-written `padding-inline-start: env(safe-area-
 *    inset-left)` is correct in German and pads the wrong edge in Arabic — the same shape of bug
 *    `tokens.literals.css.test.ts` was written for, and one that no screenshot in an LTR locale can
 *    show. Going through `--waxwing-safe-inline-start`, which `[dir="rtl"]` swaps once, makes the
 *    mistake unavailable.
 * 2. **Everything that floats over the phone's bottom bar clears it.** Three elements do
 *    (compose button, toast region, outbox strip) and they used to carry three different answers:
 *    one had the arithmetic, two had none and lay on the bar. With ADR-021 giving action-bearing
 *    toasts `duration: 0`, "lay on the bar" means the app's main navigation stayed covered.
 */

const CSS: SourceFile[] = collectSources('src', ['.css'])
const tokens = readAppFile('src/ui/tokens.css').text

/** Any spelling of the four insets. */
const ENV_INSET = /env\(\s*safe-area-inset-(top|bottom|left|right)/g

describe('safe areas are reached through tokens, not through env()', () => {
  it('spells env(safe-area-inset-*) in tokens.css only', () => {
    const strays: string[] = []
    for (const file of CSS) {
      if (file.path.endsWith('tokens.css')) continue
      for (const match of file.text.matchAll(ENV_INSET)) {
        strays.push(`${file.path}:${lineOf(file.text, match.index)} — ${match[0]})`)
      }
    }
    // The fix is never to add the file here: use --waxwing-safe-{block,inline}-{start,end}.
    expect(strays, 'a physical inset outside tokens.css cannot be flipped for RTL').toEqual([])
  })

  it.each([
    'safe-block-start',
    'safe-block-end',
    'safe-inline-start',
    'safe-inline-end',
  ])('defines --waxwing-%s', (name) => {
    expect(tokens).toMatch(new RegExp(`--waxwing-${name}:\\s*env\\(safe-area-inset-`))
  })

  it('swaps the inline pair under [dir="rtl"]', () => {
    // Without this the logical names are a lie: they would both resolve to their LTR edge.
    const rtl = /\[dir="rtl"\]\s*\{([^}]*)\}/.exec(tokens)?.[1] ?? ''
    expect(rtl, 'no [dir="rtl"] block in tokens.css').not.toBe('')
    expect(rtl).toMatch(/--waxwing-safe-inline-start:\s*env\(safe-area-inset-right/)
    expect(rtl).toMatch(/--waxwing-safe-inline-end:\s*env\(safe-area-inset-left/)
  })

  it('reads all four insets somewhere in the app', () => {
    // The tokens existing is not the point; something using them is. A refactor that quietly drops
    // the last reader of `--waxwing-safe-block-start` puts the header back under the Dynamic Island
    // and changes nothing a test would otherwise notice.
    const app = CSS.filter((file) => !file.path.endsWith('tokens.css'))
      .map((file) => file.text)
      .join('\n')
    for (const name of [
      'safe-block-start',
      'safe-block-end',
      'safe-inline-start',
      'safe-inline-end',
    ]) {
      expect(app, `nothing reads --waxwing-${name}`).toContain(`var(--waxwing-${name})`)
    }
  })
})

describe('nothing floats on the phone navigation bar', () => {
  /** The three elements pinned to the bottom of the viewport below 40em. */
  const FLOATERS = [
    { file: 'src/compose/new-message-button.module.css', what: 'the compose button' },
    { file: 'src/ui/Toast.module.css', what: 'the toast region' },
    { file: 'src/outbox/outbox.module.css', what: 'the outbox strip' },
  ] as const

  it.each(FLOATERS)('$what clears the bar and the home indicator', ({ file }) => {
    const css = readAppFile(file).text
    // Both halves, because either one alone leaves a real device wrong: without the bar height it
    // sits on the tabs, without the inset it sits on the home indicator of an installed app.
    expect(css).toContain('var(--waxwing-bottom-bar)')
    expect(css).toContain('var(--waxwing-safe-block-end)')
  })
})
