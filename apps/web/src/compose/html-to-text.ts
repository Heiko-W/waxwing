/**
 * Pure HTML → plain-text conversion for the compose plain-text alternative (M2.1, FR-CMP-01).
 *
 * Every rich message carries a generated `text/plain` alternative; this is that generator. It is
 * intentionally dependency-free and side-effect-free (only `DOMParser`, which both the browser and
 * the jsdom test environment provide) so it unit-tests exhaustively. Rules: block elements become
 * their own lines, `<br>` a line break, list items get `- ` / `1. ` markers (indented per nesting
 * level), `<blockquote>` prefixes every wrapped line with `> ` (nesting → `> > `), table cells are
 * separated by a tab, and links render as `text (href)` unless the href adds nothing. Inline
 * whitespace is collapsed — except under `<pre>`, where it is the content — and blank runs are
 * capped at one empty line.
 *
 * The module serves TWO purposes and they do not want the same rules (N-03): deriving the text
 * alternative of a rich message, and seeding the plain-text typing surface from the stored body.
 * {@link ConvertOptions.keepTypedWhitespace} is that second behaviour; {@link plainTextToHtml} is
 * what makes it possible.
 */

// `escapeHtml` from the shared module rather than a fourth private copy of the same five
// replacements (W-37): `mail-html` owns the canonical one, `mail/search/snippet.ts` already imports
// it, and a second implementation of an escaping rule is a divergence waiting for one of them to be
// fixed alone.
import { escapeHtml } from '@waxwing/mail-html'

/** Single-line blocks (a `<div>` is one visual line, as contenteditable editors emit). */
const LINE_TAGS = new Set(['DIV', 'TR'])

/**
 * Paragraph blocks — separated from siblings by a blank line.
 *
 * `PRE` is a paragraph too, but it has its own `case` in {@link serializeNode} (it has to turn
 * whitespace preservation on for its children), so listing it here as well would only be a second
 * place to look.
 */
const PARA_TAGS = new Set([
  'P',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'SECTION',
  'ARTICLE',
  'HEADER',
  'FOOTER',
  'FIGURE',
  'FIGCAPTION',
  'HR',
])

/**
 * The character {@link plainTextToHtml} writes for a space the WRITER put there — an indent, or a
 * run of two or more. HTML collapses ordinary whitespace, so a literal space is indistinguishable
 * from the newline-and-indent a pretty-printed document is full of; `&nbsp;` is not, and it is what
 * every contenteditable editor writes for the same reason. It renders identically, survives
 * `cleanOutgoingHtml` (the DOM round trip re-emits it as `&nbsp;`), and turns back into a plain
 * space on the way out (see {@link ConvertOptions.keepTypedWhitespace}).
 */
const NBSP = '\u00a0'

/** Whitespace runs that are LAYOUT — everything except the marker above (and tabs are layout too). */
const COLLAPSIBLE_TYPED = /[^\S\u00a0]+/g
/** Whitespace runs, all of them — the rule for a body whose whitespace nobody typed. */
const COLLAPSIBLE_ALL = /\s+/g

interface WalkContext {
  /** Ordered/unordered list counters, innermost last (drives markers + indentation). */
  readonly listStack: Array<{ readonly ordered: boolean; index: number }>
  /**
   * Inside a `<pre>`: whitespace in a text node is CONTENT, not layout.
   *
   * Collapsing it there is the difference between a code block and one long line, and this
   * conversion feeds the `text/plain` alternative of every message the app sends — including
   * quoted replies and forwards. A forwarded snippet used to arrive as `line1 line2 line3` (R-58).
   */
  preformatted: boolean
  /** {@link ConvertOptions.keepTypedWhitespace}; constant for the whole walk. */
  readonly keepTyped: boolean
}

export interface ConvertOptions {
  /**
   * Keep the whitespace the WRITER typed: `&nbsp;`-marked indents and multi-space runs survive, and
   * so do empty lines (N-03).
   *
   * Two callers need it. The plain-text surface seeds its textarea from the stored body, so
   * minimizing and restoring a window, switching modes or reloading the app runs the body through
   * here and back; without this, aligned lists and indented code came back flattened — silently,
   * and with no way to undo it. And a plain-text-only message IS that text: its `text/plain` part is
   * not a derived alternative but the thing the person wrote, so it is converted the same way.
   *
   * Ordinary whitespace still collapses, which is the whole point of the marker: a quoted reply is
   * foreign HTML whose newlines and indentation are the sender's markup, not anyone's typing, and it
   * must keep reading as prose rather than gaining hard breaks where the source happened to wrap.
   *
   * Known limit: a TAB is layout here as it is in HTML — pasting tab-indented text into the plain
   * surface and re-seeding leaves single spaces. Marking tabs would need a marker of their own, and
   * the tab cannot be typed into a textarea at all (the key moves focus).
   */
  readonly keepTypedWhitespace?: boolean
}

/**
 * Convert plain text back to editor HTML (used when switching plain-text mode → rich, and to store
 * what the plain surface holds — the body is html in both modes): each line becomes its own block,
 * blank lines a `<br>` block. Content is escaped, so it can never inject markup.
 *
 * Indentation and runs of two or more spaces are written as {@link NBSP} so that they survive the
 * round trip through HTML — both back into the textarea and into the rich editor, which renders
 * them. A SINGLE space between words stays an ordinary space on purpose: `&nbsp;` does not wrap, and
 * a paragraph of non-breaking spaces would refuse to reflow.
 *
 * Inverse of {@link htmlToPlainText} with `keepTypedWhitespace` (up to tabs and edge blank lines).
 */
export function plainTextToHtml(text: string): string {
  if (text === '') return ''
  return text
    .split('\n')
    .map((line) =>
      line === '' ? '<div><br></div>' : `<div>${markTypedSpaces(escapeHtml(line))}</div>`,
    )
    .join('')
}

/** Leading whitespace and every run of 2+ spaces → {@link NBSP} (see {@link plainTextToHtml}). */
function markTypedSpaces(line: string): string {
  return line
    .replace(/^ +/, (run) => NBSP.repeat(run.length))
    .replace(/ {2,}/g, (run) => NBSP.repeat(run.length))
}

/** Convert an HTML fragment to its plain-text alternative. Empty/blank input → empty string. */
export function htmlToPlainText(html: string, options: ConvertOptions = {}): string {
  if (html.trim() === '') return ''
  const keepTyped = options.keepTypedWhitespace === true
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const ctx: WalkContext = { listStack: [], preformatted: false, keepTyped }
  const out = normalize(serializeChildren(doc.body, ctx), ctx)
  // The marker has done its job; what leaves this module is the space the writer typed.
  return keepTyped ? out.replaceAll(NBSP, ' ') : out
}

function serializeChildren(node: Node, ctx: WalkContext): string {
  let out = ''
  for (const child of Array.from(node.childNodes)) out += serializeNode(child, ctx)
  return out
}

function serializeNode(node: Node, ctx: WalkContext): string {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ?? ''
    if (ctx.preformatted) return text
    return text.replace(ctx.keepTyped ? COLLAPSIBLE_TYPED : COLLAPSIBLE_ALL, ' ')
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return ''
  const el = node as Element
  switch (el.tagName) {
    case 'BR':
      return '\n'
    case 'SCRIPT':
    case 'STYLE':
    case 'HEAD':
      return ''
    case 'A':
      return serializeLink(el, ctx)
    case 'UL':
    case 'OL': {
      // The list is not its own paragraph — each item carries a single leading newline, so
      // consecutive items become adjacent lines (a nested list stays attached to its item).
      ctx.listStack.push({ ordered: el.tagName === 'OL', index: 0 })
      const inner = serializeChildren(el, ctx)
      ctx.listStack.pop()
      return inner
    }
    case 'LI':
      return `\n${liMarker(ctx)}${trimEdges(serializeChildren(el, ctx))}`
    case 'PRE': {
      // A paragraph block like the others, but its children are walked with whitespace preserved.
      // `normalize` still caps blank runs at one and trims trailing spaces per line, so a code
      // block keeps its line breaks and indentation but not two consecutive empty lines.
      const was = ctx.preformatted
      ctx.preformatted = true
      const inner = serializeChildren(el, ctx)
      ctx.preformatted = was
      return wrapPara(inner, ctx)
    }
    case 'TD':
    case 'TH':
      // Cells are inline, so without a separator `<td>Amount</td><td>100 €</td>` came out as
      // "Amount100 €" — a forwarded invoice or newsletter table read as one run-on word. A tab is
      // the one separator a plain-text reader already understands as "next column"; `wrapLine` on
      // the surrounding `<tr>` strips the leading one, so no row starts with it.
      return `\t${trimEdges(serializeChildren(el, ctx))}`
    case 'BLOCKQUOTE':
      return wrapPara(quotePrefix(serializeChildren(el, ctx), ctx), ctx)
    default: {
      const inner = serializeChildren(el, ctx)
      if (LINE_TAGS.has(el.tagName)) return wrapLine(inner, ctx)
      if (PARA_TAGS.has(el.tagName)) return wrapPara(inner, ctx)
      return inner
    }
  }
}

function serializeLink(el: Element, ctx: WalkContext): string {
  const inner = serializeChildren(el, ctx).trim()
  const href = (el.getAttribute('href') ?? '').trim()
  if (href === '' || href === inner || href === `mailto:${inner}`) return inner
  return inner === '' ? href : `${inner} (${href})`
}

/** The list marker for the current `<li>`, indented two spaces per nesting level. */
function liMarker(ctx: WalkContext): string {
  const depth = ctx.listStack.length
  const top = ctx.listStack[depth - 1]
  if (top === undefined) return ''
  const indent = '  '.repeat(Math.max(0, depth - 1))
  if (top.ordered) {
    top.index += 1
    return `${indent}${top.index}. `
  }
  return `${indent}- `
}

/** Prefix every line of a blockquote's content with `> ` (a nested quote yields `> > `). */
function quotePrefix(inner: string, ctx: WalkContext): string {
  return normalize(inner, ctx)
    .split('\n')
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n')
}

/**
 * A single-line block: one leading newline (adjacent line-blocks become consecutive lines).
 *
 * A block whose whole content is ONE `<br>` is an empty line — that is how every contenteditable
 * editor, and {@link plainTextToHtml}, spell one — and it used to be dropped entirely: a message
 * typed with a blank line between paragraphs came back, and went out, with the blank line gone
 * (N-03). A `<br>` that CLOSES a block with text in it is the filler the editor appends and means
 * nothing, so it is stripped either way.
 */
function wrapLine(inner: string, ctx: WalkContext): string {
  const filler = inner.endsWith('\n')
  const trimmed = trimBlockEdges(filler ? inner.slice(0, -1) : inner, ctx)
  if (trimmed === '') return filler ? '\n' : ''
  return `\n${trimmed}`
}

/** A paragraph block: a blank-line separator (two leading newlines). */
function wrapPara(inner: string, ctx: WalkContext): string {
  const trimmed = trimBlockEdges(inner, ctx)
  return trimmed === '' ? '' : `\n\n${trimmed}`
}

/**
 * Strip the whitespace a block's edges owe to the MARKUP (the newline and indent before a closing
 * tag). With `keepTypedWhitespace` the marked spaces are exempt: a line that begins indented is
 * exactly what that mode exists to carry through.
 */
function trimBlockEdges(text: string, ctx: WalkContext): string {
  if (!ctx.keepTyped) return text.replace(/^\s+/, '').replace(/\s+$/, '')
  return text.replace(/^[^\S\u00a0]+/, '').replace(/[^\S\u00a0]+$/, '')
}

/** Trim leading inline spaces and any trailing whitespace, preserving internal (nested) newlines. */
function trimEdges(text: string): string {
  return text.replace(/^[ \t]+/, '').replace(/[ \t\n]+$/, '')
}

/**
 * Trim trailing whitespace per line, cap blank runs at one, and trim leading/trailing blank lines.
 *
 * The cap is a rule for DERIVED text — a newsletter's stack of empty table rows should not become
 * ten empty lines. With `keepTypedWhitespace` it is off: the blank lines are the writer's own, and
 * silently deleting two of their three is the loss this mode exists to stop.
 */
function normalize(text: string, ctx: WalkContext): string {
  const perLine = text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
  return (ctx.keepTyped ? perLine : perLine.replace(/\n{3,}/g, '\n\n'))
    .replace(/^\n+/, '')
    .replace(/\n+$/, '')
}
