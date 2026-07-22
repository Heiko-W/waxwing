/**
 * Static guard: every `styles.<name>` the message list and its rows render must be a class the
 * stylesheet actually declares.
 *
 * This CANNOT be a rendering test, which is the whole reason the file exists. Vitest resolves CSS
 * Modules with its default `stable` classNameStrategy, which synthesizes `_<key>_<hash>` for ANY
 * property access — including one no rule ever declared. So `MessageRow`'s `styles.comfortable`
 * (a class `message-list.module.css` never had) read as a perfectly plausible `_comfortable_642a7a`
 * under jsdom, while a real build put the literal string `undefined` into `class` on every
 * non-compact row. A component test asserting on class names is green either way; the defect is
 * visible only by reading the two files together, so that is what this does.
 *
 * Scoped to the `styles` import (the message-list module). `labelStyles` is a different module and
 * would need its own pairing; that is out of this file's scope, not an oversight.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// The file TEXT is the subject, so these are read from disk rather than imported: a CSS-Module
// import hands back the very proxy whose invented keys this file exists to catch. `?raw` works for
// the components but NOT for the stylesheet (Vitest stubs `.css` regardless of the query), so both
// go through one reader. `import.meta.dirname` — not `new URL('.', import.meta.url)`, which Vite
// rewrites into a served asset URL during transform and which therefore resolves to `/src/mail/`.
const DIR = import.meta.dirname
const read = (name: string): string => readFileSync(join(DIR, name), 'utf8')

/**
 * Class names DECLARED by the stylesheet. Only selector text is scanned (everything before a `{`),
 * so a declaration VALUE can never contribute a name and make the check vacuously permissive.
 */
function declaredClasses(css: string): Set<string> {
  const names = new Set<string>()
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, ' ')
  for (const block of withoutComments.split('}')) {
    const selector = block.split('{')[0] ?? ''
    for (const match of selector.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) names.add(match[1] as string)
  }
  return names
}

/**
 * `styles.<name>` references in a component source, with comments removed first — these files
 * DISCUSS their class names (including the `comfortable` one this check was written for), and a
 * scanner that read prose as code would flag a fix for describing itself. The line-comment strip is
 * anchored to line start or whitespace, so a `//` inside a URL literal is left alone; the residual
 * risk is only ever under-reporting, which the reference floors below are there to catch.
 */
function referencedClasses(source: string): Set<string> {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/[^\n]*/g, '$1')
  return new Set([...code.matchAll(/\bstyles\.([A-Za-z_]\w*)/g)].map((match) => match[1] as string))
}

describe('message-list.module.css ↔ its components', () => {
  const listSource = read('MessageList.tsx')
  const rowSource = read('MessageRow.tsx')
  const declared = declaredClasses(read('message-list.module.css'))

  // The parser is the one thing that could make every assertion below vacuous: a regex that matched
  // nothing would report "no missing classes" forever. Pin both ends to a floor.
  it('parses a plausible number of classes out of the stylesheet', () => {
    expect(declared.size).toBeGreaterThan(20)
    expect(declared).toContain('row')
    expect(declared).toContain('compact')
  })

  for (const [name, source] of [
    ['MessageRow.tsx', rowSource],
    ['MessageList.tsx', listSource],
  ] as const) {
    it(`${name} references only classes the stylesheet declares`, () => {
      const referenced = referencedClasses(source)
      expect(referenced.size).toBeGreaterThan(10)
      expect([...referenced].filter((className) => !declared.has(className))).toEqual([])
    })
  }

  /**
   * Comfortable is the BASE row, deliberately carrying no modifier class of its own: its 76 px
   * height comes from `ROW_HEIGHT` in `MessageList.tsx` (the virtualizer's `estimateSize`, written
   * onto `.rowWrap`'s inline height, which `.row { block-size: 100% }` then fills), and `.compact`
   * is the only variation the stylesheet expresses. Asserted so that "add the missing `.comfortable`
   * rule" is not the next reader's conclusion: the reference was vestigial, the rule was never lost.
   */
  it('expresses density as a compact-only modifier, with no comfortable rule', () => {
    expect(declared).not.toContain('comfortable')
    expect(listSource).toContain('comfortable: 76')
  })
})
