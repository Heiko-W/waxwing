import { describe, expect, it } from 'vitest'
import { collectSources, lineOf } from './css-sources'

/**
 * Display type carries its own leading and tracking (FR-UI-01).
 *
 * `tokens.css` states the rule where it defines the tokens — *"for display sizes. Type set at
 * 1.375rem and up keeps the tracking it was drawn with for body copy and reads loose; every system
 * UI face tightens as it grows"* — and before this check it was honoured at 2 of 12 sites. The
 * misses were not visible one at a time: a 28px heading in a 42px line box (the inherited 1.5) and
 * a 22px one with body tracking both look merely a bit loose, and only side by side with a heading
 * that got it right does either read as wrong. That is exactly the class of drift a static check
 * is for, and exactly the class a reviewer will not catch twice.
 *
 * Only `xl` and `2xl`. Below that the inherited leading is correct and tracking would be wrong, so
 * this deliberately does not police the whole scale — a check that fires on legitimate values gets
 * an exemption bolted onto it and then gets ignored.
 *
 * Runs in the Node "unit" project: it reads the shipped CSS from disk.
 */

/**
 * A rule may opt out with `waxwing-display-exempt: <reason>`, the same shape the focus and literal
 * guards use: the reason is mandatory and length-checked, so an exemption cannot be added without
 * saying why. One legitimate class exists — a glyph sized at a display step that is not type set
 * in lines (an avatar's initials), where leading and tracking are the wrong questions.
 */
const EXEMPT_MARKER = /waxwing-display-exempt:\s*(\S[^*\n]{15,})/

/** A rule body — everything between `{` and the next `}`. Nesting-free by construction here. */
const RULE = /(^|\n)([^{}\n][^{}]*)\{([^{}]*)\}/g

/** The display steps, and what a rule that uses one owes. */
const DISPLAY_SIZES = /font-size:\s*var\(--waxwing-text-(xl|2xl)\)/

/**
 * The bit before the brace, which `RULE` captures as one span from the previous `}`.
 *
 * That span holds the governing comment as well as the selector, so the marker is read straight
 * out of it rather than searched for separately — the two cannot come apart that way.
 */
function selectorOf(prelude: string): string {
  return (prelude.trim().split('\n').at(-1) ?? '').trim()
}

/**
 * Rules that set a display size without both companions.
 *
 * `gallery/` is dev-only scaffolding but included anyway: it is where a contributor looks up "how
 * does this project set a heading", so a wrong example there costs more than in shipping code.
 */
function offenders(): string[] {
  const found: string[] = []
  for (const file of collectSources('src', ['.module.css'])) {
    RULE.lastIndex = 0
    let match: RegExpExecArray | null = RULE.exec(file.text)
    while (match !== null) {
      const [, , selector = '', body = ''] = match
      if (DISPLAY_SIZES.test(body) && !EXEMPT_MARKER.test(selector)) {
        const missing: string[] = []
        if (!/line-height:/.test(body)) missing.push('line-height')
        if (!/letter-spacing:/.test(body)) missing.push('letter-spacing')
        if (missing.length > 0) {
          const line = lineOf(file.text, match.index)
          found.push(
            `${file.path}:${line} — ${selectorOf(selector)} is missing ${missing.join(' and ')}`,
          )
        }
      }
      match = RULE.exec(file.text)
    }
  }
  return found
}

describe('display type', () => {
  it('scans a plausible number of stylesheets (a walk can go vacuous)', () => {
    expect(collectSources('src', ['.module.css']).length).toBeGreaterThan(20)
  })

  it('finds display-size rules to check', () => {
    // Without this the assertion below passes just as well on a regex that matches nothing.
    let seen = 0
    for (const file of collectSources('src', ['.module.css'])) {
      RULE.lastIndex = 0
      let match: RegExpExecArray | null = RULE.exec(file.text)
      while (match !== null) {
        if (DISPLAY_SIZES.test(match[3] ?? '')) seen += 1
        match = RULE.exec(file.text)
      }
    }
    expect(seen).toBeGreaterThanOrEqual(8)
  })

  it('carries no stale exemptions', () => {
    // An exemption that no longer guards anything is a claim nobody rechecked.
    const marked: string[] = []
    for (const file of collectSources('src', ['.module.css'])) {
      RULE.lastIndex = 0
      let match: RegExpExecArray | null = RULE.exec(file.text)
      while (match !== null) {
        if (EXEMPT_MARKER.test(match[2] ?? '')) {
          const body = match[3] ?? ''
          const complete = /line-height:/.test(body) && /letter-spacing:/.test(body)
          if (!DISPLAY_SIZES.test(body) || complete) {
            marked.push(`${file.path}:${lineOf(file.text, match.index)}`)
          }
        }
        match = RULE.exec(file.text)
      }
    }
    expect(marked, 'these rules are exempt from a check they would now pass').toEqual([])
  })

  it('gives every xl / 2xl rule its own leading and tracking', () => {
    expect(
      offenders(),
      'tokens.css says display type tightens as it grows; these set the size and not the rest',
    ).toEqual([])
  })
})
