/**
 * HTML-mail sanitizer (M1.7, NFR-SEC-01, FR-RD-02/03, tech-stack §4.5 step 1). The first wall of the
 * defense-in-depth: a hardened DOMPurify pass that removes every scripting vector, then a
 * remote-content firewall implemented as a `uponSanitizeAttribute` hook that
 *  - blocks remote `http(s)`/protocol-relative resources by default (images, media, CSS `url()`),
 *    recording each in a manifest so the app can offer "load remote content" (FR-RD-02);
 *  - resolves `cid:` inline parts through a caller-supplied {@link SanitizeOptions.resolveCid}
 *    (the app turns the content-id into a `blob:` URL via `client.download` — the sanitizer never
 *    fetches or imports `@waxwing/jmap`, per the SP.4 auth-header constraint); and
 *  - permits only `data:image/*` (raster) data URIs, dropping every other `data:`.
 *
 * SVG/MathML are excluded entirely (`USE_PROFILES: { html: true }`), and `<style>`/`<base>`/`<meta>`
 * /`<form>`/framing/`<link>` elements are forbidden, so the only remaining URL surface is the set of
 * attributes + inline `style` `url()` that this hook governs. The result is a STRING for the frame.
 *
 * ## One non-URL rule lives here too: styling inside an `<a>`
 * On DESCENDANTS of an anchor, and nowhere else, an inline `style` is filtered against a PROPERTY
 * ALLOWLIST ({@link ANCHOR_STYLE_ALLOWLIST}), two of those properties carry a VALUE constraint on top
 * ({@link isUnreadableSize}, {@link NEGATIVE_VALUE}), and the `hidden` attribute is dropped. That is a
 * phishing-friction measure rather than an XSS one — read that allowlist's header for what it is
 * worth and, more importantly, for what it is NOT: it does not make text inside a link visible, and
 * nothing anywhere may say that it does. `link-host.ts` decides every verdict without consulting any
 * of it, which is why none of it has to be complete.
 */

import DOMPurify from 'dompurify'

export interface BlockedResource {
  readonly url: string
  readonly kind: 'image' | 'style' | 'media' | 'other'
}

export interface SanitizeOptions {
  /** Keep remote `http(s)` resources (the app's per-message/per-sender "load remote content"). */
  readonly allowRemote?: boolean
  /** Resolve a `cid:` content-id to a `blob:`/`data:` URL (the app owns the JMAP blob download). */
  readonly resolveCid?: (contentId: string) => string | null
}

export interface SanitizeResult {
  readonly html: string
  /** Remote resources stripped from the mail (empty when `allowRemote`). */
  readonly blockedRemote: BlockedResource[]
  /** True when the ORIGINAL mail referenced any remote resource, whether blocked or kept. */
  readonly hasRemoteContent: boolean
}

const FORBID_TAGS = [
  'base',
  'meta',
  'object',
  'embed',
  'iframe',
  'frame',
  'frameset',
  'form',
  'link',
  'style',
  'noscript',
  'template',
]

const FORBID_ATTR = ['ping', 'srcdoc']

/** Attributes (besides `srcset`/`style`, handled specially) whose value is a single URL. */
const URL_ATTRS = new Set(['src', 'poster', 'background', 'longdesc', 'xlink:href'])

type UrlKind = 'cid' | 'remote' | 'dataImage' | 'dataOther' | 'other'

function classifyUrl(raw: string): { kind: UrlKind; cid?: string } {
  const url = raw.trim()
  const lower = url.toLowerCase()
  if (lower.startsWith('cid:')) return { kind: 'cid', cid: url.slice(4) }
  if (lower.startsWith('http:') || lower.startsWith('https:') || url.startsWith('//')) {
    return { kind: 'remote' }
  }
  if (/^data:image\/(png|jpe?g|gif|webp|avif|bmp)[;,]/i.test(lower)) return { kind: 'dataImage' }
  if (lower.startsWith('data:')) return { kind: 'dataOther' }
  return { kind: 'other' }
}

function kindForAttr(attrName: string, tagName: string): BlockedResource['kind'] {
  if (attrName === 'style') return 'style'
  if (tagName === 'video' || tagName === 'audio' || tagName === 'source') return 'media'
  if (attrName === 'src' || attrName === 'srcset' || tagName === 'img') return 'image'
  return 'other'
}

/** Per-call remote-content manifest. Exported for direct security tests (not part of the public API). */
export interface Collector {
  readonly blocked: BlockedResource[]
  hasRemote: boolean
}

/**
 * Resolve one URL to its safe replacement, or `null` to drop it. Records remote hits in `collector`.
 * `allow` keeps remote URLs (the "load remote content" pass).
 */
function resolveUrl(
  raw: string,
  attrName: string,
  tagName: string,
  options: SanitizeOptions,
  collector: Collector,
): string | null {
  const { kind, cid } = classifyUrl(raw)
  switch (kind) {
    case 'cid': {
      const resolved = cid !== undefined ? (options.resolveCid?.(cid) ?? null) : null
      if (resolved === null) return null
      // Re-validate the resolver's OUTPUT: accept only a blob: URL or a raster data:image — never
      // trust a (buggy/compromised) resolver that hands back data:text/html, javascript:, http:, …
      if (resolved.trim().toLowerCase().startsWith('blob:')) return resolved
      return classifyUrl(resolved).kind === 'dataImage' ? resolved : null
    }
    case 'remote': {
      collector.hasRemote = true
      if (options.allowRemote) return raw
      collector.blocked.push({ url: raw.trim(), kind: kindForAttr(attrName, tagName) })
      return null
    }
    case 'dataImage':
      return raw
    case 'dataOther':
      return null
    default:
      return raw
  }
}

/** Longest inline `style` we will process; anything larger is dropped (defensive, also anti-ReDoS). */
const MAX_STYLE_LENGTH = 8192

/**
 * CSS functions/keywords with no legitimate place in mail styling that can fetch or execute — a
 * style containing any is dropped wholesale (fail-closed): `image-set`/`cross-fade` reference images
 * by bare string (not `url()`), and `expression`/`-moz-binding`/`behavior`/`@import`/`javascript:`
 * are code/fetch vectors. Tested against the CSS-UNESCAPED value so escapes cannot hide them.
 */
const STYLE_DANGER =
  /expression\(|behaviou?r\s*:|-moz-binding|@import|image-set|cross-fade|javascript:|vbscript:/i

/** Any remaining remote scheme after `url()` rewriting → a malformed `url()` the parser missed. */
const REMOTE_SCHEME = /https?:|\/\//i

/** Decode CSS escapes (`\XXXXXX ` hex and `\<char>`) so obfuscated schemes can't hide from checks. */
function cssUnescape(value: string): string {
  return value.replace(
    /\\([0-9a-fA-F]{1,6})\s?|\\([^\n])/g,
    (_match, hex?: string, ch?: string) => {
      if (hex !== undefined) {
        const code = Number.parseInt(hex, 16)
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
      }
      return ch ?? ''
    },
  )
}

/**
 * Sanitize an inline `style` value. Regex CSS parsing is inherently bypassable, so this is
 * FAIL-CLOSED: it rewrites known `url()`s, but drops the ENTIRE attribute if the value is oversized,
 * contains a dangerous function/keyword, or still carries a remote scheme after rewriting.
 */
export function sanitizeStyle(
  css: string,
  tagName: string,
  options: SanitizeOptions,
  collector: Collector,
): { value: string; drop: boolean } {
  if (css.length > MAX_STYLE_LENGTH) return { value: '', drop: true }
  if (STYLE_DANGER.test(cssUnescape(css))) {
    collector.hasRemote = true
    collector.blocked.push({ url: css.trim().slice(0, 128), kind: 'style' })
    return { value: '', drop: true }
  }
  // Linear `url(...)` match (no overlapping quantifiers → ReDoS-safe): capture up to the first `)`.
  const rewritten = css.replace(/url\(([^)]*)\)/gi, (_match, inner: string) => {
    const target = cssUnescape(inner.trim().replace(/^['"]|['"]$/g, ''))
    const replacement = resolveUrl(target, 'style', tagName, options, collector)
    // Blocked → empty url() (renders nothing); kept → re-quote with quotes/backslashes/parens
    // stripped from the safe replacement so it cannot break out of the CSS string.
    return replacement === null ? "url('')" : `url('${replacement.replace(/['"\\()]/g, '')}')`
  })
  // Fail closed: strip every WELL-FORMED `url(...)` (already handled above — safe replacement, empty,
  // or an intentionally-kept allowRemote URL), then if a remote scheme still remains it lived in a
  // MALFORMED/unbalanced `url(` the parser could not match — drop the whole style rather than leak it.
  const residual = cssUnescape(rewritten).replace(/url\([^)]*\)/gi, '')
  if (REMOTE_SCHEME.test(residual)) {
    collector.hasRemote = true
    return { value: '', drop: true }
  }
  return { value: rewritten, drop: false }
}

/** Keep only the srcset candidates that survive {@link resolveUrl}; empty result → drop the attr. */
function sanitizeSrcset(
  value: string,
  tagName: string,
  options: SanitizeOptions,
  collector: Collector,
): string | null {
  const kept: string[] = []
  for (const candidate of value.split(',')) {
    const trimmed = candidate.trim()
    if (trimmed === '') continue
    const [url, ...descriptor] = trimmed.split(/\s+/)
    if (url === undefined) continue
    const replacement = resolveUrl(url, 'srcset', tagName, options, collector)
    if (replacement !== null) kept.push([replacement, ...descriptor].join(' '))
  }
  return kept.length > 0 ? kept.join(', ') : null
}

/**
 * Properties an inline `style` may keep on a DESCENDANT of an `<a>`. Everything absent is dropped,
 * whatever its value and however it is spelt.
 *
 * ## Why an allowlist, and what it is and is not worth
 * Wave 2 shipped a DENYLIST of four hiding declarations, matched against the whole declaration with
 * the value anchored at the end. Six spellings of `display:none` alone walked straight past it —
 * `display:none!important` (the spelling real HTML mail overwhelmingly uses), the same with a space,
 * with mixed case, with padding around the colon and the bang, and with a CSS comment on either side
 * of the keyword — and the same again for `visibility` and for a zero `font-size`. All reproduced
 * against the real `sanitize` before this was written. The second family, geometric hiding, was never
 * enumerated at all: `position:absolute;left:-9999px`, `clip-path:inset(100%)`, `transform:scale(0)`,
 * `max-height:0;overflow:hidden`, `opacity:0`, `filter:opacity(0)` and the rest all survived intact.
 * A denylist over CSS values loses that race by construction: the value grammar is large, the
 * attacker picks the spelling, and any property invented after this file was written is allowed by
 * default.
 *
 * So the test moved to the PROPERTY NAME, where the grammar is a fixed vocabulary and the default is
 * "no". `!important` is part of the value and cannot reach the decision; a comment inside the value
 * cannot either; and a property nobody here has heard of is dropped rather than kept.
 *
 * Wave 4 then found the same construction failing one level down, in the two VALUE constraints that
 * sit on top of the list: `isVisuallyZero` read the first literal number in the value and compared it
 * to a floor, so `font-size:calc(100px * 0)` and its family walked past exactly as `display:none
 * !important` had walked past the denylist. {@link isUnreadableSize} answers it the same way the list
 * does — by refusing what it cannot prove rather than by hunting for what it knows.
 *
 * **What this does NOT do — read this before adding a sentence about closure anywhere.** It does not
 * make text inside an anchor visible, and it cannot. `color` and the `background` family are on the
 * list ON PURPOSE (below), the frame paints a known white canvas, and `color:#fff` therefore remains
 * an always-available hide. An attacker who controls the markup and the CSS can still put a run of
 * text out of a reader's sight inside a link. A large POSITIVE `padding-left` does it too, and is on
 * the list. This rule is FRICTION: it removes the spellings that hide WITHOUT a colour trick — every
 * one of the twenty the review cited, and everything else off the list — and it converts an
 * unenumerable set of vectors into a list a reviewer can read. The set of techniques it defeats is
 * not closed and must never be written down as though it were. ADR-016 states the same thing in
 * prose, and `link-host.ts` explains why no verdict depends on any of it.
 *
 * ## How the list was chosen
 * From what real mail needs INSIDE a link: text styling, and the box chrome of a call-to-action
 * button. The positioning, clipping, transform, overflow, sizing and opacity families are excluded
 * wholesale — nothing legitimate inside an anchor needs them, and they are where the geometric
 * vectors live.
 *
 * `color` and `background*` are deliberately IN. Dropping them would be the worse bug: the classic
 * marketing button is white text painted on a coloured background, and a rule that took the
 * background away while keeping the text colour would render white-on-white — text made invisible by
 * the very rule meant to force text into view. Both halves stay, together, so the button is untouched.
 *
 * `display` is deliberately OUT even though `display:inline-block` is how a padded button is built.
 * Admitting it would mean allowlisting its VALUES (`none` out, `table-column` out, …), i.e. a second
 * value grammar to get right, for a cosmetic gain: without it the padding on an inline element no
 * longer expands the line box, so such a button renders tight rather than illegible.
 */
const ANCHOR_STYLE_ALLOWLIST: ReadonlySet<string> = new Set([
  // Text.
  'color',
  'font-family',
  'font-size',
  'font-stretch',
  'font-style',
  'font-variant',
  'font-weight',
  'hyphens',
  'letter-spacing',
  'line-height',
  'overflow-wrap',
  'text-align',
  'text-decoration',
  'text-decoration-color',
  'text-decoration-line',
  'text-decoration-style',
  'text-decoration-thickness',
  'text-transform',
  'vertical-align',
  'white-space',
  'word-break',
  'word-spacing',
  'word-wrap',
  // Paint. A background cannot move or collapse a box; `url()` in one has already been through the
  // remote-content firewall above. `background-clip` is NOT here: `background-clip:text` plus a
  // transparent `color` is an invisible-text recipe.
  'background',
  'background-color',
  'background-image',
  'background-position',
  'background-repeat',
  'background-size',
  // Box chrome.
  'border',
  'border-bottom',
  'border-bottom-color',
  'border-bottom-left-radius',
  'border-bottom-right-radius',
  'border-bottom-style',
  'border-bottom-width',
  'border-collapse',
  'border-color',
  'border-left',
  'border-left-color',
  'border-left-style',
  'border-left-width',
  'border-radius',
  'border-right',
  'border-right-color',
  'border-right-style',
  'border-right-width',
  'border-spacing',
  'border-style',
  'border-top',
  'border-top-color',
  'border-top-left-radius',
  'border-top-right-radius',
  'border-top-style',
  'border-top-width',
  'border-width',
  'margin',
  'margin-bottom',
  'margin-left',
  'margin-right',
  'margin-top',
  'padding',
  'padding-bottom',
  'padding-left',
  'padding-right',
  'padding-top',
])

/**
 * The two allowed properties that can still collapse a box to nothing at a value the allowlist would
 * otherwise wave through, and so carry a value constraint as well: see {@link isUnreadableSize}.
 */
const ANCHOR_STYLE_SIZED: ReadonlySet<string> = new Set(['font-size', 'line-height'])

/**
 * A negative number anywhere in a value (`-9999px`, `- .5em`, `calc(100% - 8px)`). Rejected on EVERY
 * allowed property rather than on a curated subset of them: `margin-left:-9999px` is the same
 * off-screen displacement as the `text-indent:-9999px` the allowlist already excludes, negative
 * lengths on the rest are either meaningless or purely cosmetic (tight tracking, an icon nudged a
 * pixel), and a blanket rule cannot be forgotten the next time a property is added to the list.
 *
 * `font-family:"Helvetica-Neue"` is unaffected — the hyphen there is not followed by a digit.
 *
 * This is a real constraint and a small one. It does NOT close displacement: a large POSITIVE
 * `padding-left` or `border-left-width` pushes a following run out of the frame's visible column just
 * as well, and any per-declaration ceiling composes away under nesting, so none is attempted. See the
 * allowlist's header on why that is friction rather than a hole in a guarantee.
 */
const NEGATIVE_VALUE = /-\s*(\d|\.\d)/

/** Units that scale with the inherited font size, where the number is a factor rather than a length. */
const RELATIVE_UNITS: ReadonlySet<string> = new Set([
  'em',
  'rem',
  'ex',
  'ch',
  'cap',
  'ic',
  'lh',
  'rlh',
])

/** The first number, with its unit, in a CSS value. */
const CSS_NUMBER = /(\d+(?:\.\d*)?|\.\d+)\s*([a-z%]*)/i

/**
 * Below these a `font-size`/`line-height` is not "small", it is gone: 4px of text is a smudge and
 * 0.0001px is nothing at all. The floor is deliberately ABOVE zero — wave 2 tested the value for
 * being exactly zero, so `font-size:0.0001px` walked straight past it.
 */
const MIN_VISIBLE_PX = 4
const MIN_VISIBLE_FACTOR = 0.5
const MIN_VISIBLE_PERCENT = 50

/**
 * Whether a `font-size`/`line-height` value is one this file can PROVE renders readable text. Only
 * two shapes qualify, and everything else is rejected — the direction is deliberate and is the wave-4
 * fix (A4a) to the constraint below.
 *
 * ## Why "prove", and not "look for a small number"
 * The wave-3 rule read the FIRST literal number in the value and compared it to a floor. That is the
 * same defect the property filter was built to remove, one level down: the value grammar is large and
 * the attacker picks the spelling, so a value that BEGINS with a large number and COMPUTES to zero
 * walked straight past the floor. All of these were kept verbatim inside an anchor:
 *
 *     font-size:calc(100px * 0)     font-size:calc(1em*0)          font-size:min(100px,0px)
 *     font-size:calc(16px * 0.0001) font-size:calc(100px/100000)   font-size:var(--u,calc(9px*0))
 *     font-size:calc(100px*0)!important                            — and the same family on line-height
 *
 * Evaluating CSS arithmetic here would be the losing move: `calc()` nests, mixes units, and composes
 * with `var()`, `min()`, `max()`, `clamp()`, `env()` and whatever CSS adds next. So this FAILS CLOSED
 * instead. A value containing `(` — any function at all, known or not — is rejected outright, without
 * being read. The cost is stated rather than hidden: a legitimate `font-size:calc(1rem + 2px)` inside
 * an anchor loses its declaration and the text inherits the anchor's size. It is visible; it is
 * merely not the author's size. That is the correct direction for this rule.
 *
 * A value with no `(` and NO number in it is a keyword (`normal`, `medium`, `inherit`, `larger`,
 * `xx-small`) and is kept: every one of them resolves to a size a reader can read, and `var(--x)` —
 * the one keyword-shaped escape hatch that could resolve to zero — carries a paren and is now
 * rejected above. A trailing `!important` is irrelevant, because it holds no digit.
 *
 * ## Two ways the number read here is NOT the number the browser computes. Both are OPEN.
 * The "reject any `(`" move above closes functions; it does not make this a tokenizer, and the value
 * grammar has two more places to put a digit.
 *
 * **1. A CSS COMMENT is not a paren.** `/*…*\/` is stripped by the tokenizer before any value is
 * computed, so a digit inside a LEADING comment is invisible to the browser and is the first literal
 * number to {@link CSS_NUMBER}. It reads the comment's digit instead of the real value:
 *
 *     font-size:/*9*\/1px   → read as magnitude 9, unit '' (the `*` after `9` ends the unit match),
 *                            9 ≥ 0.5, so KEPT — while the browser renders 1px. Verified end-to-end
 *                            through `sanitize`; plain `font-size:1px` is correctly dropped.
 *
 * It runs in the false-POSITIVE direction just as easily (`font-size:/*0*\/9px` reads magnitude 0 and
 * drops a legitimate 9px), which is harmless but is the same defect. Closing it means stripping
 * comments before the read, or rejecting any value containing `/*` the way `(` is rejected. Neither
 * is done here and this is a tracked row.
 *
 * **2. SCIENTIFIC NOTATION is a valid CSS number and this does not parse it.** `CSS_NUMBER` stops the
 * mantissa at the first non-digit, so `font-size:5e-10px` reads as magnitude **5** with unit **`e`**
 * — 5 against the px floor of 4, comfortably "readable" — while the browser computes 5×10⁻¹⁰ px,
 * i.e. nothing. This rule does not catch it. It is rejected today only INCIDENTALLY, by
 * {@link NEGATIVE_VALUE} seeing the `-1` of the exponent, and that is the only reason no fixture
 * shows it through: shrinking a value needs a negative exponent, and every negative exponent trips
 * that other rule. It is a coincidence of two rules, not a property of this one, and it would come
 * apart the moment `NEGATIVE_VALUE` were narrowed. A tracked row.
 *
 * What this does NOT do: it says nothing about whether the text is visible. A readable size still
 * renders nothing if `color` matches the background — see {@link ANCHOR_STYLE_ALLOWLIST}'s header.
 */
function isUnreadableSize(value: string): boolean {
  // Fail closed on every function, on the raw text AND on its unescaped form. A CSS escape does not
  // in fact produce a function token (`calc\28 …` is an ident, not `calc(`), so testing the unescaped
  // form can only reject MORE than a browser would compute — which is the direction we want.
  if (value.includes('(') || cssUnescape(value).includes('(')) return true
  const match = CSS_NUMBER.exec(cssUnescape(value))
  if (match === null) return false
  const magnitude = Number.parseFloat(match[1] ?? '')
  // A number too long to represent parses to Infinity, not to a finite size. Reachable: 400 digits of
  // `9` is a valid CSS number and a plausible obfuscation. Rejecting it is fail-closed and pinned.
  if (!Number.isFinite(magnitude)) return true
  const unit = (match[2] ?? '').toLowerCase()
  if (unit === '%') return magnitude < MIN_VISIBLE_PERCENT
  if (unit === '' || RELATIVE_UNITS.has(unit)) return magnitude < MIN_VISIBLE_FACTOR
  // Every remaining unit is measured against a PX floor, including the absolute ones (`cm`, `mm`,
  // `in`, `pc`, `pt`, `q`) whose numbers are much smaller than the px they represent. `font-size:1cm`
  // is 37.8px and perfectly legible, and it is dropped. Fail-closed and harmless; ADR-016 lists it
  // under what real mail loses.
  return magnitude < MIN_VISIBLE_PX
}

/**
 * Split an inline `style` into its declarations at the `;`s that SEPARATE declarations, skipping the
 * ones that live inside a quoted string or inside a `url()`/function's parentheses.
 *
 * Wave 3 split on every `;`, and that shipped a regression this rule caused in ordinary mail (A4d).
 * `sanitizeStyle` runs first and re-quotes every kept `url()`, so a legitimate inline background
 * arrives here with a `data:` URI in it, and the `;` of `data:image/png;base64,…` is a `;` like any
 * other:
 *
 *     background:url(data:image/png;base64,iVBORw0KGgo=) no-repeat;color:#000
 *     → kept: `background:url('data:image/png`   — truncated, with an UNTERMINATED CSS string, which
 *       then swallows `color:#000` and everything after it
 *
 * The same shape for a quoted value (`font-family:'a;b'`). Both are legitimate mail rendering wrongly
 * because of our filter, which is the worst kind of bug this rule can have.
 *
 * This is still not a CSS parser, and the divergence that matters is one where the BROWSER sees a
 * declaration boundary that this splitter does NOT — that is how a property we believe we rejected
 * rides along inside a KEPT declaration's text and is applied by the browser anyway.
 *
 * ## That divergence EXISTS. A newline also ends a CSS string, and this closes one only on a quote.
 * Two earlier revisions of this comment said the opposite in as many words ("none of them diverges
 * that way", "never 'a rejected one is applied'"). Both sentences were wrong and have been deleted.
 *
 * CSS Syntax Level 3 §4.3.5 (consume a string token) ends a string at an unescaped newline as well
 * as at the matching quote: it is a parse error, the tokenizer emits a `<bad-string-token>` and stops
 * there. §3.3 preprocessing has already folded CR, CRLF and FF to LF, so all four spellings count.
 * An HTML attribute value carries raw newlines perfectly legally, so a `style` can hold one. Then:
 *
 *     font-family:'x⏎;display:none
 *     → HERE: one declaration. `font-family` is on the allowlist and nothing inspects its VALUE, so
 *       the whole run is kept verbatim — with `display:none` sitting inside it.
 *     → BROWSER: `font-family:<bad-string>`, invalid and dropped; then a TOP-LEVEL `;`; then a second
 *       declaration `display:none`, which is APPLIED.
 *
 * Confirmed against a spec tokenizer (`@csstools/css-tokenizer`), which emits
 * `bad-string-token | whitespace-token | semicolon-token | ident("display") | colon | ident("none")`
 * for exactly that input, and end-to-end through `sanitize` — the style survives untouched.
 *
 * This is OPEN and is a tracked row, not a closed class. Teaching the loop that a newline ends a
 * string is a small change; it is not made here because this pass is documentation only. Until it is
 * made, the honest statement of the failure direction is: usually "a legitimate declaration is
 * dropped", and on this one input shape "a rejected one is applied".
 *
 * The three malformed shapes below were checked against a real CSS parser and none of THEM diverges
 * that way. That is the whole of what that check established — the newline case was never in it:
 *
 *  - unclosed `(` — `background:url(a;color:#fff` parses as ONE declaration whose value is the whole
 *    remainder, so the browser fuses exactly where this fuses and applies nothing;
 *  - unterminated string with NO newline in it — `font-family:'a;display:none` is a single
 *    `string-token` to the browser too, so it likewise fuses here, one declaration, `display` unset;
 *  - stray `)` — `color:red);display:none` is where the browser DOES see a boundary, and the depth
 *    counter is clamped at zero so this sees it too; the `display:none` piece is then dropped by the
 *    allowlist like any other.
 *
 * All three are pinned in `sanitize.test.ts`.
 */
function splitDeclarations(css: string): string[] {
  const out: string[] = []
  let start = 0
  let quote: string | null = null
  let depth = 0
  for (let i = 0; i < css.length; i += 1) {
    const ch = css[i]
    // A backslash escapes the next character everywhere in CSS, inside strings and out.
    if (ch === '\\') {
      i += 1
      continue
    }
    if (quote !== null) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '(') depth += 1
    else if (ch === ')') depth = Math.max(0, depth - 1)
    else if (ch === ';' && depth === 0) {
      out.push(css.slice(start, i))
      start = i + 1
    }
  }
  out.push(css.slice(start))
  return out
}

/**
 * Inside an `<a>` — and ONLY inside one — keep only the declarations on {@link ANCHOR_STYLE_ALLOWLIST}.
 * "Inside" means a strict DESCENDANT: the `<a>` element's OWN `style` never reaches this function at
 * all. {@link isInsideAnchor} carries why, and why that scope limit is sound for hiding and is a live
 * hole for reordering.
 *
 * Hidden text inside an anchor has no legitimate purpose: the anchor's text is a promise about where
 * the click goes, and a run of it the reader cannot see is only ever there to break that promise
 * (`link-host.ts`'s header works the attacks through). Preheaders — the reason `sanitize` otherwise
 * keeps `display:none` and `hidden`, and real mail leans on them constantly — live at BODY level,
 * never inside a link, so this rule does not touch them. ADR-016 records the reversal.
 *
 * The property name is taken as everything before the FIRST colon, which is where CSS puts it, and is
 * then trimmed, lowercased and CSS-unescaped. Anything without a colon is not a declaration and is
 * dropped.
 *
 * **What that normalisation is and is not.** It is a FIDELITY measure, not a bypass guard, and the
 * comment here used to imply the opposite. The allowlist holds no name with a backslash, an uppercase
 * letter or a leading space in it, so every one of those three steps can only map a spelling ONTO an
 * allowed name — i.e. each one KEEPS declarations that would otherwise be dropped, and deleting any
 * of them fails closed. `trim` is the one that carries real mail: `a:1; color:#c00` has a leading
 * space on every declaration after the first. All three are pinned individually and in composite in
 * `sanitize.test.ts`, because a term that only ever admits more has to be pinned by what it ADMITS.
 *
 * Note what CANNOT happen: `display\3a none` has no literal colon at all, so it is not a declaration
 * and never reaches the allowlist. Unescaping the property name cannot manufacture a colon.
 *
 * The output is a `;`-joined SUBSEQUENCE of {@link splitDeclarations}'s pieces — pieces are only ever
 * dropped, never rewritten or reordered, and the separator they are rejoined with is the declaration
 * separator itself, so two surviving pieces cannot fuse into a property name that was not already
 * spelt out in the input.
 */
function filterAnchorStyle(css: string): string {
  const kept: string[] = []
  for (const declaration of splitDeclarations(css)) {
    const colon = declaration.indexOf(':')
    if (colon < 0) continue
    const property = cssUnescape(declaration.slice(0, colon)).trim().toLowerCase()
    if (!ANCHOR_STYLE_ALLOWLIST.has(property)) continue
    const value = declaration.slice(colon + 1)
    if (NEGATIVE_VALUE.test(cssUnescape(value))) continue
    if (ANCHOR_STYLE_SIZED.has(property) && isUnreadableSize(value)) continue
    kept.push(declaration)
  }
  return kept.join(';')
}

/**
 * Whether `node` is a DESCENDANT of an anchor. It is deliberately FALSE for the `<a>` element
 * itself, which is the only gate {@link filterAnchorStyle} sits behind — so **the anchor's own
 * inline `style` is never filtered at all**, whatever it contains.
 *
 * The justification used to be one clause: "an `<a>` hiding ITSELF deceives nobody". That is true
 * for HIDING and false for REORDERING, and the distinction was missed:
 *
 * - HIDING. `<a style="display:none">` removes the link from the page. Nobody can click what is not
 *   rendered, so there is no promise to break. The clause holds, and this is why the scope limit
 *   exists. It also keeps a mail-wide `<a style="display:none">` preheader working.
 * - REORDERING. `<a href="https://evil.tld/s" style="direction:rtl;unicode-bidi:bidi-override">`
 *   renders the anchor's own text reversed. The link is fully visible and fully clickable; the
 *   reader sees `bank.test/login` where the markup says `nigol/tset.knab`, `link-host.ts` reads the
 *   written order, finds nothing host-shaped, claims nothing, and the interstitial never appears.
 *   The `<a>` has deceived by styling itself, which the clause says cannot happen.
 *
 * Neither `direction` nor `unicode-bidi` is on {@link ANCHOR_STYLE_ALLOWLIST}, so the SAME two
 * declarations on a `<span>` one level down are stripped. Verified both ways end-to-end through
 * `sanitize`. This is precisely the class the character-level rule in `link-host.ts` (U+202D/U+202E,
 * the bidi OVERRIDES) was added to defend against, reached through CSS instead of through a code
 * point — a third spelling alongside that one and `<bdo dir="rtl">`, and the only one of the three
 * that a rule already in this file would catch if the scope were widened by one element.
 *
 * NOT closed, NOT attempted here, and a tracked row. Widening the scope to the `<a>` itself is a
 * one-line change but it is not free, and the suite already objects to it as a mutation (ADR-016
 * records "the anchor scope … widened to include the `<a>` itself (2)"). The fixture it breaks is
 * "keeps hiding on the anchor itself", i.e. the deliberate HIDING half above — so a fix has to
 * distinguish the two classes rather than widen wholesale: filter the `<a>`'s own style against a
 * narrower set aimed at reordering, or leave hiding alone on it and reject only the properties that
 * change reading order. That is a decision, not a detail, and it belongs in a wave that can run
 * fixtures rather than in a documentation pass.
 */
function isInsideAnchor(node: Element): boolean {
  const parent = node.parentElement
  return parent !== null && typeof parent.closest === 'function' && parent.closest('a') !== null
}

export function sanitize(html: string, options: SanitizeOptions = {}): SanitizeResult {
  const collector: Collector = { blocked: [], hasRemote: false }

  const hook = (
    node: Element,
    event: { attrName: string; attrValue: string; keepAttr: boolean },
  ) => {
    const attr = event.attrName
    const tag = node.tagName.toLowerCase()

    // Leave anchor/area link targets to the frame's link policy (DOMPurify already blocks
    // javascript:/vbscript: etc. via its default ALLOWED_URI_REGEXP).
    if (attr === 'href' && (tag === 'a' || tag === 'area')) return

    // Hidden text inside a link is only ever there to lie about where the link goes (see
    // filterAnchorStyle). Outside a link the `hidden` attribute is left alone — preheaders.
    if (attr === 'hidden' && isInsideAnchor(node)) {
      event.keepAttr = false
      return
    }

    if (attr === 'style') {
      const styled = sanitizeStyle(event.attrValue, tag, options, collector)
      if (styled.drop) {
        event.keepAttr = false
        return
      }
      const value = isInsideAnchor(node) ? filterAnchorStyle(styled.value) : styled.value
      // Everything the declaration said was structural hiding: emit no `style` at all rather than an
      // empty one. `replace` and not `trim`, because `;;` is what a stripped middle declaration
      // leaves behind.
      if (value.replace(/[\s;]/g, '') === '') event.keepAttr = false
      else event.attrValue = value
      return
    }

    if (attr === 'srcset') {
      const rewritten = sanitizeSrcset(event.attrValue, tag, options, collector)
      if (rewritten === null) {
        event.keepAttr = false
      } else {
        node.setAttribute('srcset', rewritten)
        event.attrValue = rewritten
      }
      return
    }

    if (URL_ATTRS.has(attr) || attr === 'href') {
      const replacement = resolveUrl(event.attrValue, attr, tag, options, collector)
      if (replacement === null) {
        event.keepAttr = false
        return
      }
      if (replacement !== event.attrValue) {
        // A resolved cid → blob:/data: URL. Set it ourselves and force-keep so DOMPurify's URI
        // allowlist (which excludes blob:) does not strip our known-safe replacement.
        node.setAttribute(attr, replacement)
        ;(event as { forceKeepAttr?: boolean }).forceKeepAttr = true
      }
    }
  }

  DOMPurify.addHook('uponSanitizeAttribute', hook)
  try {
    const clean = DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true },
      FORBID_TAGS,
      FORBID_ATTR,
      ALLOW_ARIA_ATTR: true,
      ALLOW_DATA_ATTR: false,
      SANITIZE_DOM: true,
      SANITIZE_NAMED_PROPS: true,
      WHOLE_DOCUMENT: false,
      RETURN_DOM: false,
      RETURN_DOM_FRAGMENT: false,
    })
    return {
      html: typeof clean === 'string' ? clean : String(clean),
      blockedRemote: collector.blocked,
      hasRemoteContent: collector.hasRemote,
    }
  } finally {
    DOMPurify.removeHook('uponSanitizeAttribute')
  }
}
