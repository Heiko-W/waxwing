import { describe, expect, it } from 'vitest'
import { collectSources, lineOf, type SourceFile } from './css-sources'

/**
 * Every `<Button>` in the app names its role (HIG `buttons`).
 *
 * "Assign the primary role to the button people are most likely to choose. When a primary button
 * responds to the Return key, it makes it easy for people to quickly confirm their choice." And:
 * "Use style — not size — to visually distinguish the preferred choice among multiple options …
 * use a more prominent button style for that option and a less prominent style for the remaining
 * ones."
 *
 * `Button` defaults to `secondary`, which is the safe default for a button in a toolbar and the
 * wrong one in a dialog footer — and the default is silent, so twelve confirming buttons across
 * the app had ended up looking exactly like the Cancel beside them. In the event editor "Cancel"
 * was `variant="secondary"` written out and "Save" was `variant` omitted: the same white fill with
 * the same border, chosen deliberately in one case and by accident in the other. Twenty-seven
 * other sites in the same codebase did write `variant="primary"` for the same job, so this was
 * never a design decision — it was the default winning arguments nobody had.
 *
 * A default cannot be reviewed. Requiring the attribute puts the choice back in front of the
 * author, once per button, and costs one word.
 *
 * Runs in the Node "unit" project (`*.shipped.test.ts`), reading the sources from disk.
 */

/** Every `<Button …>` opening tag, including the multi-line ones. */
const BUTTON_TAG = /<Button\b[^>]*?>/gs

const sources: SourceFile[] = collectSources('src', ['.tsx']).filter(
  (file) => !/\.test\.tsx$/.test(file.path) && !file.path.includes('/gallery/'),
)

describe('every Button states its variant', () => {
  it('leaves no Button on the silent default', () => {
    const bare: string[] = []
    for (const file of sources) {
      for (const match of file.text.matchAll(BUTTON_TAG)) {
        if (match[0].includes('variant=')) continue
        bare.push(`${file.path}:${lineOf(file.text, match.index)}`)
      }
    }
    // The fix is never to add an exception here. Decide: `primary` for the one thing the reader
    // most likely came to do, `secondary` or `ghost` for the rest, `destructive` for the one that
    // cannot be undone.
    expect(bare, 'a Button whose role was never chosen').toEqual([])
  })

  it('scans a plausible number of Buttons (the walk itself can go vacuous)', () => {
    const total = sources.reduce((n, file) => n + [...file.text.matchAll(BUTTON_TAG)].length, 0)
    expect(total, 'the Button sweep found almost nothing — check the glob').toBeGreaterThan(50)
  })
})
