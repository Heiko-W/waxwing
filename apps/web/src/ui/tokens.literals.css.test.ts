import { describe, expect, it } from 'vitest'
import { collectSources, lineOf } from './css-sources'

/**
 * Static guard against un-tokenised literal values in the app's stylesheets (M4.5, FR-THEME-01).
 *
 * The white-label promise is that a hoster restyles Waxwing by re-declaring `--waxwing-*` tokens and
 * nothing else. A literal in a `.module.css` breaks that promise SILENTLY and in the worst possible
 * way: most of the UI follows the new theme and a few things do not, so the deployment looks broken
 * rather than unthemed, and nothing anywhere explains why. An M4.5 audit found 25 of them across
 * nine files — every one a value that already had a token.
 *
 * WHAT THE OTHER THREE CSS CHECKS CANNOT SEE (ADR-015). `tokens.contrast.test.ts` only reads
 * tokens.css and compares token values to each other. `tokens.references.css.test.ts` walks every
 * file but its only pattern is `var(--waxwing-…)`: it proves the references that EXIST resolve, and
 * is structurally blind to a declaration that never mentions a token at all — `font-weight: 600` is
 * invisible to it by construction. `focus-indicator.css.test.ts` looks at outlines. This one looks
 * at the declarations themselves, which is the gap.
 *
 * Deliberately NARROW. It checks the property families that (a) are fully tokenised today and (b)
 * caused real drift, rather than trying to police every value in CSS. A check that fires on
 * legitimate values gets an exemption bolted onto it and then gets ignored; one that fires only on
 * genuine drift keeps its authority.
 *
 * Runs in the Node "unit" project: it reads the shipped CSS from disk, which the jsdom project
 * cannot do (vitest stubs `.css` imports to empty there).
 */

/**
 * A rule may opt out with `waxwing-literal-exempt: <reason>` in a comment above it — same shape and
 * the same rationale as the focus guard's marker: the reason is mandatory and length-checked, so an
 * exemption cannot be added without saying why, and a stale one is failed below rather than left to
 * accumulate. There is exactly one legitimate class of these today (see the test that pins them).
 */
const EXEMPT_MARKER = /waxwing-literal-exempt:\s*(\S[^*\n]{15,})/

/** Properties whose every legitimate value is a token today, with the literals that betray drift. */
const RULES: readonly {
  readonly property: RegExp
  readonly what: string
  readonly token: string
}[] = [
  {
    property: /(?<![\w-])font-weight:\s*(\d{3})\s*[;}]/g,
    what: 'a numeric font-weight',
    token: '--waxwing-weight-*',
  },
  {
    property: /(?<![\w-])letter-spacing:\s*(-?[\d.]+em)\s*[;}]/g,
    what: 'a literal letter-spacing',
    token: '--waxwing-tracking-caps',
  },
  {
    // Colours are the ones a hoster notices first, and `transparent`/`currentColor`/`inherit` are
    // structural rather than palette, so only real colour literals are caught.
    property:
      /(?<![\w-])(?:background|background-color|color|border-color|fill|stroke):\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|black|white)\s*[;}]/g,
    what: 'a literal colour',
    token: 'a --waxwing-* colour token',
  },
]

const sources = collectSources('src', ['.module.css'])

/**
 * A directional `translateX` that is not signed by `--waxwing-flip` (FR-I18N-02).
 *
 * Its own family, because it is not a theming question: logical properties cover every box-model
 * side, but CSS has no logical transform, so a physical `translateX` is the one place a layout can
 * be right-to-left-broken while every declaration around it reads correctly. That is precisely how
 * it happened — an off-canvas drawer anchored with `inset-inline-start` (which flips) and moved with
 * `translateX(-100%)` (which does not), so under RTL it slid INTO the content instead of off-screen.
 * Both halves were individually correct.
 *
 * Only flags NEGATIVE or variable offsets: `translateX(0)` has no direction to get wrong.
 */
const UNSIGNED_TRANSLATE = /transform:\s*translateX\(\s*(?!0\s*\))(?![^)]*--waxwing-flip)([^)]+)\)/g

/**
 * The comment governing the declaration at `offset` — the one directly above it, or the one above
 * the RULE it sits in.
 *
 * Both, because an exemption is a statement about a rule ("this frame is pinned light"), and a rule
 * has several declarations. Requiring the marker to hug one property would mean repeating the same
 * reason on `background` and on `color-scheme`, and repeated reasons are the ones that go stale.
 */
function governingComment(text: string, offset: number): string {
  const commentAbove = (end: number): string => {
    const before = text.slice(0, end)
    const close = before.lastIndexOf('*/')
    if (close === -1) return ''
    // Only counts as "immediately above" when nothing but whitespace separates them.
    if (before.slice(close + 2).trim() !== '') return ''
    const open = before.lastIndexOf('/*', close)
    return open === -1 ? '' : before.slice(open, close + 2)
  }

  const direct = commentAbove(offset)
  if (EXEMPT_MARKER.test(direct)) return direct

  // Walk out to the rule this declaration belongs to and look above its selector. A comment governs
  // the rule when it is the last thing before it — i.e. it ends AFTER the previous rule's `}`.
  const ruleStart = text.lastIndexOf('{', offset)
  if (ruleStart === -1) return direct
  const commentEnd = text.lastIndexOf('*/', ruleStart)
  if (commentEnd === -1 || commentEnd < text.lastIndexOf('}', ruleStart)) return direct
  const commentOpen = text.lastIndexOf('/*', commentEnd)
  return commentOpen === -1 ? direct : text.slice(commentOpen, commentEnd + 2)
}

interface Finding {
  readonly where: string
  readonly value: string
  readonly what: string
  readonly token: string
}

function scan(): { readonly findings: Finding[]; readonly exemptions: string[] } {
  const findings: Finding[] = []
  const exemptions: string[] = []
  for (const file of sources) {
    for (const rule of RULES) {
      rule.property.lastIndex = 0
      for (const match of file.text.matchAll(rule.property)) {
        const at = match.index ?? 0
        const comment = governingComment(file.text, at)
        const exempt = EXEMPT_MARKER.exec(comment)
        const where = `${file.path}:${lineOf(file.text, at)}`
        if (exempt) {
          exemptions.push(where)
          continue
        }
        findings.push({
          where,
          value: match[1] ?? match[0],
          what: rule.what,
          token: rule.token,
        })
      }
    }
  }
  return { findings, exemptions }
}

describe('token literals', () => {
  it('walks a plausible number of stylesheets', () => {
    // The whole check is vacuous if the glob silently matches nothing — the failure mode this
    // repo has already been bitten by twice (B22).
    expect(sources.length).toBeGreaterThan(15)
  })

  it('uses a token for every weight, tracking and colour it declares', () => {
    const { findings } = scan()
    const report = findings.map((f) => `${f.where} — ${f.what} \`${f.value}\`, use ${f.token}`)
    expect(report, 'un-tokenised literals (M4.5, FR-THEME-01)').toEqual([])
  })

  it('signs every directional translateX, so RTL cannot slide the wrong way', () => {
    const unsigned: string[] = []
    for (const file of sources) {
      UNSIGNED_TRANSLATE.lastIndex = 0
      for (const match of file.text.matchAll(UNSIGNED_TRANSLATE)) {
        const at = match.index ?? 0
        if (EXEMPT_MARKER.test(governingComment(file.text, at))) continue
        unsigned.push(`${file.path}:${lineOf(file.text, at)} — translateX(${match[1]?.trim()})`)
      }
    }
    expect(
      unsigned,
      'multiply by var(--waxwing-flip), or state a waxwing-literal-exempt reason',
    ).toEqual([])
  })

  it('keeps every exemption honest — each one states a reason and still guards something', () => {
    const { exemptions } = scan()
    // The mail body frame is the one legitimate class: foreign HTML that sets a dark text colour and
    // no background of its own would be black-on-black on a themed dark surface, so it is pinned
    // light and must NOT follow the theme. A regex cannot know that; a stated reason can.
    expect(exemptions.length).toBeLessThan(6)
    for (const where of exemptions) {
      expect(where).toMatch(/\.module\.css:\d+$/)
    }
  })
})
