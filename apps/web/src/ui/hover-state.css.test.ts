import { describe, expect, it } from 'vitest'
import { collectSources, lineOf, type SourceFile } from './css-sources'

/**
 * Two static guards over hover styling. Both exist because a real defect shipped past every other
 * check in the repo: jsdom computes no styles, Biome has no cross-rule reasoning, and the only
 * viewport any suite asserts at is one where the affected element is a different component.
 *
 * **1. A hover affordance must be behind `@media (hover: hover)`.** On a touchscreen `:hover`
 * latches: the browser applies it to whatever the finger last landed on and leaves it there. Next to
 * a genuinely selected row that reads as two selections. `Button.module.css` already said this in a
 * comment ("so a tap on touch does not stick a hover style") — it was simply never applied to the
 * other 26 rules.
 *
 * **2. A state rule must out-rank the hover rule for the same element.** `[aria-current="page"]` and
 * `:hover` are BOTH (0,2,0). Where both set the same property, nothing but source order decides the
 * winner — and in `shell.module.css` hover was written second, so pointing at the current section
 * erased its accent colour. Five further pairs were correct only because the state rule happened to
 * be written below the hover rule; a reorder would have broken any of them silently. The fix this
 * test enforces is the robust one: the state rule names the hovered state itself, which makes it
 * (0,3,0) and independent of order.
 *
 * Runs in the Node "unit" project — it reads the shipped CSS from disk, which the jsdom project
 * cannot do (vitest stubs `.css` imports to empty there).
 */

/**
 * A rule may opt out with `waxwing-hover-exempt: <reason>` in the comment above it. The reason is
 * mandatory and length-checked, and the "no stale exemptions" assertion below deletes it again as
 * soon as the rule stops needing it — so an exemption cannot rot into a permanent allowlist.
 */
const EXEMPT_MARKER = /waxwing-hover-exempt:\s*(\S[^*\n]{15,})/
/** The attribute selectors this repo uses to mark a current/selected/pressed element. */
const STATE_ATTR = /\[aria-(?:current|selected|pressed)[^\]]*\]/

interface Rule {
  readonly file: string
  readonly line: number
  readonly selectors: readonly string[]
  readonly body: string
  /** The at-rule preludes this rule is nested inside, outermost first. */
  readonly context: readonly string[]
  /** Raw text between the previous rule and this one — where an exempt marker lives. */
  readonly leading: string
}

/** Blank out comments in place so brace scanning ignores them but offsets stay put. */
function blankComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
}

/**
 * Leaf style rules, with the at-rule stack that encloses each. A block containing another block is
 * a context, not a declaration list, so nesting is tracked rather than skipped — which is the whole
 * point here: `@media (hover: hover)` is exactly such a context.
 */
function parseRules(file: SourceFile): Rule[] {
  const scan = blankComments(file.text)
  const rules: Rule[] = []
  const context: string[] = []
  let depth = 0
  let sliceStart = 0
  const preludes: string[] = []

  for (let i = 0; i < scan.length; i++) {
    const ch = scan[i]
    if (ch === '{') {
      const prelude = scan.slice(sliceStart, i).trim()
      const close = matchingBrace(scan, i)
      const inner = scan.slice(i + 1, close)
      if (inner.includes('{')) {
        context.push(prelude)
        preludes.push(prelude)
        depth++
        sliceStart = i + 1
        continue
      }
      rules.push({
        file: file.path,
        line: lineOf(file.text, sliceStart),
        selectors: prelude
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        body: file.text.slice(i + 1, close),
        context: [...context],
        // The prelude span — everything since the previous rule closed, comments included. A fixed
        // lookback window would reach across that boundary and credit one rule's exempt marker to
        // the rule that follows it.
        leading: file.text.slice(sliceStart, i),
      })
      i = close
      sliceStart = i + 1
      continue
    }
    if (ch === '}') {
      if (depth > 0) {
        depth--
        context.pop()
        preludes.pop()
      }
      sliceStart = i + 1
    }
  }
  return rules
}

function matchingBrace(text: string, open: number): number {
  let level = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') level++
    else if (text[i] === '}') {
      level--
      if (level === 0) return i
    }
  }
  return text.length
}

/** Declared property names, so two rules can be asked whether they collide at all. */
function properties(body: string): Set<string> {
  const out = new Set<string>()
  for (const match of body.matchAll(/(?:^|[;{])\s*([a-z-]+)\s*:/g)) {
    const name = match[1]
    if (name !== undefined) out.add(name)
  }
  return out
}

/** `.item:hover` and `.item[aria-selected="true"]` both reduce to `.item`. */
function baseOf(selector: string): string {
  return selector
    .replace(/:hover\b/g, '')
    .replace(STATE_ATTR, '')
    .trim()
}

/** Only selectors whose state sits on the LAST compound — `.a:hover .b` addresses `.b`, not `.a`. */
function stateIsOnLastCompound(selector: string, marker: RegExp): boolean {
  const last =
    selector
      .split(/\s+|>|\+|~/)
      .filter(Boolean)
      .pop() ?? ''
  return marker.test(last)
}

/**
 * Does this rule offer a hover AFFORDANCE, or merely defend against one?
 *
 * `.x[aria-current="page"], .x[aria-current="page"]:hover { … }` is the robust form the second
 * guard below demands: it mentions `:hover` only to out-rank the affordance, and must therefore NOT
 * be pushed behind `@media (hover: hover)` — on touch it still has to win. The tell is that the same
 * base appears in the rule's own selector list without `:hover`.
 */
function isHoverAffordance(rule: Rule): boolean {
  const plain = new Set(rule.selectors.filter((s) => !s.includes(':hover')))
  // Compare with ONLY `:hover` removed — `baseOf` would also strip the state attribute, which is
  // precisely the part that has to match for this to count as the defensive pairing.
  const withoutHover = (s: string) => s.replace(/:hover\b/g, '').trim()
  return rule.selectors.some((s) => s.includes(':hover') && !plain.has(withoutHover(s)))
}

const FILES = collectSources('src', ['.css'])
const RULES = FILES.flatMap(parseRules)

const HOVER_RULES = RULES.filter(isHoverAffordance)

describe('hover affordances are pointer-only', () => {
  it('finds hover rules to check (the scan itself must not silently match nothing)', () => {
    expect(HOVER_RULES.length).toBeGreaterThan(15)
  })

  it('every :hover rule sits inside @media (hover: hover) or states why not', () => {
    const offenders = HOVER_RULES.filter((rule) => {
      if (rule.context.some((c) => /@media[^{]*\(\s*hover\s*:\s*hover\s*\)/.test(c))) return false
      return !EXEMPT_MARKER.test(rule.leading)
    }).map((r) => `${r.file}:${r.line} — ${r.selectors.join(', ')}`)

    expect(
      offenders,
      'A :hover style latches on touch: the browser leaves it on whatever the finger last landed ' +
        'on, which reads as a second selection. Wrap it in @media (hover: hover), or add a ' +
        '`waxwing-hover-exempt: <reason>` comment above it.',
    ).toEqual([])
  })

  it('has no stale exemptions', () => {
    const stale = RULES.filter((rule) => {
      if (!EXEMPT_MARKER.test(rule.leading)) return false
      const needsIt =
        isHoverAffordance(rule) &&
        !rule.context.some((c) => /@media[^{]*\(\s*hover\s*:\s*hover\s*\)/.test(c))
      return !needsIt
    }).map((r) => `${r.file}:${r.line} — ${r.selectors.join(', ')}`)

    expect(stale, 'These rules carry a hover exemption they no longer need.').toEqual([])
  })
})

describe('current/selected state out-ranks hover', () => {
  it('a state rule that collides with a hover rule names the hovered state itself', () => {
    const offenders: string[] = []

    for (const file of FILES) {
      const rules = parseRules(file)
      const hoverByBase = new Map<string, Set<string>>()
      for (const rule of rules) {
        for (const selector of rule.selectors) {
          if (!stateIsOnLastCompound(selector, /:hover\b/)) continue
          if (STATE_ATTR.test(selector)) continue // already a state rule, not a plain hover
          const base = baseOf(selector)
          const props = hoverByBase.get(base) ?? new Set<string>()
          for (const p of properties(rule.body)) props.add(p)
          hoverByBase.set(base, props)
        }
      }

      for (const rule of rules) {
        for (const selector of rule.selectors) {
          if (!stateIsOnLastCompound(selector, STATE_ATTR)) continue
          if (selector.includes(':hover')) continue // this IS the robust form
          const hoverProps = hoverByBase.get(baseOf(selector))
          if (hoverProps === undefined) continue
          const collides = [...properties(rule.body)].some((p) => hoverProps.has(p))
          if (!collides) continue
          // Robust only if SOME selector in this rule's list pins the hovered state.
          if (rule.selectors.some((s) => s.includes(':hover'))) continue
          offenders.push(`${file.path}:${rule.line} — ${selector}`)
        }
      }
    }

    expect(
      offenders,
      'This state rule and a :hover rule for the same element set the same property at equal ' +
        'specificity (0,2,0), so only source order decides which wins — the defect that erased the ' +
        'current section in the nav rail. Add the hovered state to the rule’s own selector ' +
        'list (e.g. `.x[aria-current="page"], .x[aria-current="page"]:hover`).',
    ).toEqual([])
  })
})
