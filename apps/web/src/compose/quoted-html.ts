/**
 * A second, quote-specific pass over mail HTML on its way INTO the composer (M2.3, FR-CMP-02/10).
 * {@link quoteBody}/{@link forwardBody} are its only callers.
 *
 * ## Why a reading-sanitized body is not safe here
 * `@waxwing/mail-html`'s `sanitize()` is written for ONE destination: the sandboxed `<iframe>` of
 * `MailBodyFrame`. That is why it filters inline `style` only on DESCENDANTS of an `<a>` — its own
 * comment gives the reason as "the frame paints a known white canvas", i.e. the worst a
 * `position:fixed` overlay can do there is cover the mail it came with. Reply and forward take that
 * same string and put it somewhere else entirely: through `RichTextEditor.setHTML` into Squire, into
 * the APP document, inside a composer window that `ComposerHost` portals to `<body>`. Nothing on the
 * way strips it — the composer's DOMPurify instance is deliberately permissive (it keeps `style`,
 * and without `USE_PROFILES`/`FORBID_TAGS` it keeps `<form>`/`<input>` too), and Squire's
 * `replaceStyles` rewrites presentational TAGS, never a `style` attribute.
 *
 * Measured in headless Chromium against the real composer stylesheet: a quoted
 * `<div style="position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:2147483647;background:#fff">`
 * survives sanitize → DOMPurify → Squire and paints 1280x720 in a 1280x720 viewport, with
 * `elementFromPoint` returning it — no ancestor establishes a containing block (no transform, filter
 * or contain), so `fixed` escapes the editor entirely. No script is involved. And the direction is
 * what makes it worth a pass of its own: the overlay sits inside a contenteditable whose draft is
 * addressed TO the sender of the mail, so a fake "session expired, sign in again" panel collects
 * what the victim types AS THE BODY and mails it back to the attacker.
 *
 * ## What this does
 *  - Reduces every element's inline `style` to {@link QUOTE_STYLE_ALLOWLIST} — text, paint, box
 *    chrome, sizing. Not "on descendants of an `<a>`": on everything. Geometry (`position`, the
 *    inset properties, `z-index`, `float`, `transform`, `display`, `visibility`, `opacity`,
 *    `overflow`, `clip-path`, `pointer-events`, `mix-blend-mode`, …) is simply not on the list, so
 *    the overlay above loses the only declarations that make it one.
 *  - Deletes {@link DROP_TAGS} outright. `<style>` and `<svg>`/`<math>` are the load-bearing entries:
 *    a stylesheet ANYWHERE in the quote — including an `<svg><style>` smuggled through the foreign
 *    -content parser — sets `position:fixed` on a plain `<div>` and defeats every line above it.
 *    The widget half (`<input>`, `<select>`, `<textarea>`, …) is what a credential prompt is built
 *    from once it can no longer be positioned.
 *  - Unwraps {@link UNWRAP_TAGS} (`<form>`, `<button>`, `<label>`, …), keeping their text: a real
 *    mail can wrap its whole body in a `<form>`, and deleting the subtree would delete the quote.
 *  - Drops `contenteditable`, so quoted content cannot plant an island of the reply that the reader
 *    cannot edit or delete.
 *
 * ## What this does NOT do, and must not be cited as doing
 *  - It is NOT the XSS boundary. `<script>`, `on*` and `javascript:` are dropped by the composer's
 *    DOMPurify, which runs after this on the same string; the entries here that overlap it are
 *    belt-and-braces, not the guarantee.
 *  - It is NOT a remote-content firewall. Whatever `sanitize()` decided about `url()` and `<img
 *    src>` stands: quoting a message whose remote content the reader chose to load carries those
 *    URLs into the draft and therefore into the sent mail. That is inherent to quoting, not a hole
 *    this pass declined to close.
 *  - It does not make quoted text legible. A 1px font or a white-on-white run survives; both are
 *    what the ORIGINAL mail looked like, and a reply is a quotation.
 *
 * Pure (`DOMParser` only), so it unit-tests without a composer.
 */

/**
 * Properties a quote may keep. Deliberately the same shape as `mail-html`'s anchor allowlist —
 * text, paint, box chrome — plus the sizing family below, and read the same way: an allowlist is
 * sound only because everything NOT on it is refused, so nothing may be added here without asking
 * whether it can move a box out of the editor's flow.
 *
 * Sizing (`width`/`height` and their min/max forms) is the one concession, and it is a fidelity one:
 * real mail lays out with `<td style="width:600px">` and sized images, and a reply that loses those
 * stops looking like the mail it quotes. It costs little — with no `position`, `float`, `transform`
 * or `display` available, an oversized box can only push the rest of the quote down INSIDE the
 * editor's own scroll box; it cannot cover anything. Viewport units are refused anyway (see
 * {@link VIEWPORT_UNIT}), so it cannot be sized to the window either.
 */
const QUOTE_STYLE_ALLOWLIST: ReadonlySet<string> = new Set([
  // Text.
  'color',
  'font',
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
  // Paint. A background cannot move or collapse a box. `background-clip` is NOT here:
  // `background-clip:text` with a transparent `color` is an invisible-text recipe.
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
  // Sizing — see the header note.
  'height',
  'max-height',
  'max-width',
  'min-height',
  'min-width',
  'width',
])

/**
 * A negative number anywhere in a value (`-9999px`, `- .5em`, `calc(100% - 8px)`), refused on EVERY
 * allowed property. Without it `margin-left:-9999px` (or `margin-top:-2000px`) displaces a quoted
 * run off-screen or over the UI above the composer using nothing but an allowlisted property — the
 * same off-screen trick the allowlist's omission of `position` was meant to end. `font-family:
 * "Helvetica-Neue"` is unaffected: that hyphen is not followed by a digit.
 */
const NEGATIVE_VALUE = /-\s*(\d|\.\d)/

/**
 * Any viewport-relative length (`100vw`, `50dvh`, `10svmin`, …). These are the units that let quoted
 * content size itself to the WINDOW rather than to its container, which is half of what makes an
 * overlay an overlay; percentages are left alone because they resolve against the containing block,
 * which is the editor. Deliberately without a trailing `\b`, so a unit this list spells only in part
 * still matches — fail closed, at the cost of rejecting values no CSS parser accepts anyway.
 */
const VIEWPORT_UNIT = /\d\s*[sld]?v(?:w|h|i|b|min|max)/i

/**
 * Removed with their subtree. Two groups, and the first is the one that matters:
 *
 *  - `style`, `svg`, `math` — a STYLESHEET anywhere in the quote applies to the whole app document
 *    and re-grants every property this file spent an allowlist removing. `svg`/`math` are here
 *    because foreign-content parsing lets a `<style>` ride inside them, and because they are the
 *    standard namespace-confusion surface. Cost: a quoted inline logo is lost. That is a fidelity
 *    price paid knowingly, and it is not shared by `<img>`, which mail actually uses.
 *  - The widget family — an `<input>`/`<select>`/`<textarea>` inside a reply addressed to the
 *    attacker is a keystroke collector wearing the app's own chrome. Mail has no use for one.
 *
 * `script`/`iframe`/`object`/`embed`/`link`/`base`/`meta` are already refused twice over (mail-html
 * forbids them, DOMPurify drops them); they are listed so this pass is sound on its own input rather
 * than on an assumption about its caller.
 */
const DROP_TAGS = [
  'base',
  'datalist',
  'dialog',
  'embed',
  'frame',
  'frameset',
  'iframe',
  'input',
  'link',
  'math',
  'meta',
  'noscript',
  'object',
  'option',
  'optgroup',
  'output',
  'script',
  'select',
  'style',
  'svg',
  'template',
  'textarea',
]

/** Replaced by their children: the semantics go, the quoted text stays (see the module header). */
const UNWRAP_TAGS = ['button', 'fieldset', 'form', 'label', 'legend']

/**
 * Split a `style` value into declarations on top-level `;`, honouring strings, `url(…)` nesting and
 * backslash escapes.
 *
 * It differs from `mail-html`'s otherwise identical splitter in ONE place, and on purpose: a newline
 * TERMINATES an unterminated string here. CSS ends a `bad-string-token` at a newline, so a browser
 * reads `font-family:'x⏎;position:fixed` as two declarations and APPLIES the second; a splitter that
 * keeps the string open fuses them into one, sees the allowlisted `font-family`, and keeps
 * `position:fixed` verbatim inside it. `mail-html` documents that fusion as an open hole it is
 * willing to carry because its output lands in a sandboxed frame. This output lands in the app DOM,
 * where the same input is exactly the overlay this module exists to stop, so it is closed here.
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
      // Newline → bad-string-token: the string is over, and what follows is CSS again.
      if (ch === '\n' || ch === '\r' || ch === '\f') quote = null
      else if (ch === quote) quote = null
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

/** CSS escapes: `\26` / `\000026` (optionally one trailing space) and `\<char>`. */
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
 * Keep only the declarations on {@link QUOTE_STYLE_ALLOWLIST} whose value clears
 * {@link NEGATIVE_VALUE} and {@link VIEWPORT_UNIT}.
 *
 * The property name is everything before the FIRST colon, trimmed and lowercased — and, unlike
 * mail-html's anchor filter, NOT CSS-unescaped. That direction is the fail-closed one here: an
 * escaped spelling (`posi\74 ion`) matches nothing on the allowlist and is dropped, where unescaping
 * could only ever map a spelling ONTO an allowed name. It costs the fidelity of `col\6Fr:red`, which
 * no mail sends.
 *
 * The value IS tested in both spellings, raw and unescaped, because there the two tests only ever
 * REJECT: `-\39 9px` hides its digit from the raw regex, `\2d 9999px` hides its minus.
 *
 * The output is a `;`-joined subsequence of the input's own pieces — never rewritten, never
 * reordered — so two survivors cannot fuse into a property that was not already spelt out.
 */
function filterQuotedStyle(css: string): string {
  const kept: string[] = []
  for (const declaration of splitDeclarations(css)) {
    const colon = declaration.indexOf(':')
    if (colon < 0) continue
    const property = declaration.slice(0, colon).trim().toLowerCase()
    if (!QUOTE_STYLE_ALLOWLIST.has(property)) continue
    const value = declaration.slice(colon + 1)
    const unescaped = cssUnescape(value)
    if (NEGATIVE_VALUE.test(value) || NEGATIVE_VALUE.test(unescaped)) continue
    if (VIEWPORT_UNIT.test(value) || VIEWPORT_UNIT.test(unescaped)) continue
    kept.push(declaration)
  }
  return kept.join(';')
}

/** Replace an element with its children, so the text of a quote outlives its container. */
function unwrap(element: Element): void {
  element.replaceWith(...Array.from(element.childNodes))
}

/**
 * Reduce mail HTML to what a quote may carry into the app DOM. See the module header for the attack
 * this closes and for the three things it deliberately does not do.
 */
export function sanitizeQuotedHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const body = doc.body

  for (const element of Array.from(body.querySelectorAll(DROP_TAGS.join(',')))) element.remove()
  // After the drops, so a widget inside a `<form>` is gone whichever way round the tree is nested.
  for (const element of Array.from(body.querySelectorAll(UNWRAP_TAGS.join(',')))) unwrap(element)

  for (const element of Array.from(body.querySelectorAll('*'))) {
    element.removeAttribute('contenteditable')
    const style = element.getAttribute('style')
    if (style === null) continue
    const filtered = filterQuotedStyle(style)
    // An emptied `style` is removed rather than left as `style=""` — the same shape mail-html emits.
    if (filtered.replace(/[\s;]/g, '') === '') element.removeAttribute('style')
    else element.setAttribute('style', filtered)
  }

  return body.innerHTML
}
