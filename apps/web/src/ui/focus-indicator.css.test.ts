import { describe, expect, it } from 'vitest'
import { collectSources, lineOf, type SourceFile } from './css-sources'

/**
 * Static guard against suppressed keyboard focus indicators (WCAG 2.4.7, Level A — B5).
 *
 * `global.css` supplies the app's focus net (`:focus-visible { outline: 2px solid … }`), and
 * every instance of this defect so far has been a MORE SPECIFIC selector overriding it:
 * `.input:focus` is (0,2,0) and beats `:focus-visible` at (0,1,0), so an `outline: none`
 * there wins and the control ends up with no indicator at all. That is not a browser
 * question — it is visible in the stylesheet, which is why this is a file scan and not an
 * E2E sweep. A computed-style sweep over every focusable element is a genuinely different
 * and more expensive check; it is deferred to its own work package.
 *
 * The rule: a rule that switches the outline off must either scope the suppression away
 * from keyboard focus (`:not(:focus-visible)`), or leave a visible indicator somewhere —
 * in its own body (a box-shadow ring) or in a sibling `:focus-visible` rule for the same
 * selector base. Anything else needs an explicit, reasoned opt-out (see EXEMPT_MARKER).
 *
 * Runs in the Node "unit" project: it reads the shipped CSS from disk, which the jsdom
 * project cannot do (vitest stubs `.css` imports to empty there).
 */

/**
 * A rule may opt out with `waxwing-focus-exempt: <reason>` in the comment directly above
 * it. The reason is mandatory and length-checked, so an exemption cannot be added without
 * stating why — and the "no stale exemptions" assertion below deletes it again the moment
 * the rule it guards stops needing it. A hardcoded path allowlist would do neither.
 */
const EXEMPT_MARKER = /waxwing-focus-exempt:\s*(\S[^*\n]{15,})/
const OUTLINE_OFF = /(?:^|[;{\s])outline(?:-style)?\s*:\s*(?:none|0)\s*(?:;|$)/m
const VISIBLE_INDICATOR = /(?:^|[;{\s])(?:outline|box-shadow)\s*:\s*(?!none|0\s*[;$])[^;]+/m

interface Rule {
  readonly file: string
  readonly line: number
  /** Comma-separated selector list, comments already stripped. */
  readonly selectors: readonly string[]
  readonly body: string
  /** Raw text between the previous rule and this one — where the exempt marker lives. */
  readonly leading: string
}

/** Blank out comments in place so brace scanning and declaration matching ignore them. */
function blankComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
}

/**
 * Leaf style rules only. `@media`/`@supports` blocks are skipped by construction: a block
 * that contains another block is not a declaration list, so it never carries an outline.
 */
function parseRules(file: SourceFile): Rule[] {
  const scan = blankComments(file.text)
  const rules: Rule[] = []
  const stack: { start: number; bodyStart: number; hasChild: boolean }[] = []
  let start = 0
  for (let i = 0; i < scan.length; i++) {
    const char = scan[i]
    if (char === '{') {
      const parent = stack.at(-1)
      if (parent) parent.hasChild = true
      stack.push({ start, bodyStart: i + 1, hasChild: false })
      start = i + 1
    } else if (char === '}') {
      const frame = stack.pop()
      start = i + 1
      if (!frame || frame.hasChild) continue
      const region = scan.slice(frame.start, frame.bodyStart - 1)
      const selectorText = region.trim()
      if (selectorText.startsWith('@')) continue // at-rule with a declaration body, e.g. @font-face
      rules.push({
        file: file.path,
        line: lineOf(scan, frame.bodyStart - 1 - selectorText.length),
        selectors: selectorText.split(',').map((s) => s.trim().replace(/\s+/g, ' ')),
        body: scan.slice(frame.bodyStart, i),
        leading: file.text.slice(frame.start, frame.bodyStart - 1),
      })
    }
  }
  return rules
}

/** `.menuItem:focus-visible` → `.menuItem`; strips the trailing pseudo-class chain only. */
function selectorBase(selector: string): string {
  return selector.replace(/(?::{1,2}[a-z-]+(?:\([^)]*\))?)+$/i, '')
}

const cssFiles = collectSources('src', ['.css'])
const rules = cssFiles.flatMap(parseRules)

/** A rule that gives `base` a visible indicator under `:focus-visible`, anywhere in `file`. */
function hasFocusVisibleIndicator(file: string, base: string): boolean {
  if (base === '') return false
  return rules.some(
    (rule) =>
      rule.file === file &&
      VISIBLE_INDICATOR.test(rule.body) &&
      rule.selectors.some((sel) => sel.startsWith(`${base}:focus-visible`)),
  )
}

interface Finding {
  readonly where: string
  readonly selector: string
  readonly why: string
}

const findings: Finding[] = []
const usedExemptions = new Set<string>()

for (const rule of rules) {
  if (!OUTLINE_OFF.test(rule.body)) continue
  const exemption = rule.leading.match(EXEMPT_MARKER)
  for (const selector of rule.selectors) {
    if (/:not\(\s*:focus-visible\s*\)/.test(selector)) continue // suppression already scoped away
    const where = `${rule.file}:${rule.line}`
    let why: string | undefined
    if (selector.includes(':focus-visible')) {
      // Switching the outline off on the very state that needs it. Only a ring drawn in the
      // same body (box-shadow) can replace it.
      if (!/(?:^|[;{\s])box-shadow\s*:\s*(?!none)[^;]+/m.test(rule.body)) {
        why = 'suppresses the outline on :focus-visible itself and draws no replacement ring'
      }
    } else if (!hasFocusVisibleIndicator(rule.file, selectorBase(selector))) {
      why = `no "${selectorBase(selector)}:focus-visible" rule supplies a visible indicator`
    }
    if (why === undefined) continue
    if (exemption) {
      usedExemptions.add(where)
      continue
    }
    findings.push({ where, selector, why })
  }
}

describe('focus indicators', () => {
  it('parses a plausible number of CSS rules', () => {
    // Without this, a broken walk or scanner turns every assertion below into a vacuous pass.
    expect(cssFiles.length).toBeGreaterThan(35)
    expect(rules.length).toBeGreaterThan(300)
    expect(rules.filter((rule) => OUTLINE_OFF.test(rule.body)).length).toBeGreaterThan(0)
  })

  it('never removes the outline without leaving a visible focus indicator', () => {
    expect(
      findings.map((f) => `${f.where}  ${f.selector} — ${f.why}`),
      'WCAG 2.4.7 (Level A): keyboard focus must stay visible. Fix the rule, or document an ' +
        'opt-out with a "waxwing-focus-exempt: <reason>" comment directly above it.',
    ).toEqual([])
  })

  it('carries no stale focus exemptions', () => {
    // An exemption that no longer suppresses anything is a licence nobody is using; it would
    // silently pre-approve the next defect written on that selector.
    const declared = cssFiles.flatMap((file) =>
      [...file.text.matchAll(/waxwing-focus-exempt:/g)].map(
        (m) => `${file.path}:${lineOf(file.text, m.index)}`,
      ),
    )
    expect(declared.length, `declared exemptions: ${declared.join(', ')}`).toBe(usedExemptions.size)
  })
})
