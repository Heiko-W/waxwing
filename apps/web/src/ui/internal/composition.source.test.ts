import { describe, expect, it } from 'vitest'
import { collectSources } from '../css-sources'

/**
 * The IME rule is stated ONCE in the shipped source (N-07, ADR-040).
 *
 * "A keystroke that belongs to an input method belongs to nobody else" was written out three times:
 * here in `composition.ts`, in the chord matcher (`shortcuts/keys.ts`) and in the global keydown
 * listener (`ShortcutProvider.tsx`). All three were correct and all three were tested, which is
 * exactly what makes this the dangerous shape — a correction to one of them reaches neither of the
 * others, and nothing goes red.
 *
 * The rule is also precisely the kind of two-engine detail that rots: Chromium reports
 * `key: 'Process'` with the legacy `keyCode 229`, Firefox reports the committed key with
 * `isComposing: true`, Safari sends the `keyCode` too. A copy written against one engine passes
 * every test in a browser that uses the other.
 *
 * So this is a SOURCE test rather than a behavioural one. Three behavioural tests would pass
 * against three copies — that was the state being fixed. What has to hold is that there is one
 * definition, and this is the only kind of assertion that can say so.
 */
const SOURCES = collectSources('src', ['.ts', '.tsx']).filter(
  (file) => !file.path.includes('.test.'),
)

describe('the IME rule', () => {
  /**
   * `229` is the legacy `keyCode` every engine sends during a composition. It is a magic number
   * with exactly one meaning in this app, so counting it counts the copies of the rule.
   */
  it('names `keyCode === 229` in exactly one shipped file', () => {
    const files = SOURCES.filter((file) => /keyCode\s*===\s*229/.test(file.text)).map(
      (file) => file.path,
    )
    expect(files).toEqual(['src/ui/internal/composition.ts'])
  })

  it('has every other surface ask `isComposingKey` instead of reading the flag itself', () => {
    // `event.isComposing` outside `composition.ts` is the other half of the same duplication: it is
    // half the rule, and half the rule is wrong in Chromium.
    const files = SOURCES.filter(
      (file) =>
        file.path !== 'src/ui/internal/composition.ts' &&
        /(^|[^.\w])event\.isComposing/.test(file.text),
    ).map((file) => file.path)
    expect(files).toEqual([])
  })

  /** And the one definition is reachable from outside `ui/`, or the merge would not have been possible. */
  it('is on the design system public surface', () => {
    const barrel = SOURCES.find((file) => file.path === 'src/ui/index.ts')
    expect(barrel?.text).toContain('isComposingKey')
  })
})
