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
}

/**
 * Convert plain text back to editor HTML (used when switching plain-text mode → rich): each line
 * becomes its own block, blank lines a `<br>` block. Content is escaped, so it can never inject
 * markup. Inverse-ish of {@link htmlToPlainText} for round-tripping the mode toggle.
 */
export function plainTextToHtml(text: string): string {
  if (text === '') return ''
  return text
    .split('\n')
    .map((line) => (line === '' ? '<div><br></div>' : `<div>${escapeHtml(line)}</div>`))
    .join('')
}

/** Convert an HTML fragment to its plain-text alternative. Empty/blank input → empty string. */
export function htmlToPlainText(html: string): string {
  if (html.trim() === '') return ''
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const raw = serializeChildren(doc.body, { listStack: [], preformatted: false })
  return normalize(raw)
}

function serializeChildren(node: Node, ctx: WalkContext): string {
  let out = ''
  for (const child of Array.from(node.childNodes)) out += serializeNode(child, ctx)
  return out
}

function serializeNode(node: Node, ctx: WalkContext): string {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ?? ''
    return ctx.preformatted ? text : text.replace(/\s+/g, ' ')
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
      return wrapPara(inner)
    }
    case 'TD':
    case 'TH':
      // Cells are inline, so without a separator `<td>Amount</td><td>100 €</td>` came out as
      // "Amount100 €" — a forwarded invoice or newsletter table read as one run-on word. A tab is
      // the one separator a plain-text reader already understands as "next column"; `wrapLine` on
      // the surrounding `<tr>` strips the leading one, so no row starts with it.
      return `\t${trimEdges(serializeChildren(el, ctx))}`
    case 'BLOCKQUOTE':
      return wrapPara(quotePrefix(serializeChildren(el, ctx)))
    default: {
      const inner = serializeChildren(el, ctx)
      if (LINE_TAGS.has(el.tagName)) return wrapLine(inner)
      if (PARA_TAGS.has(el.tagName)) return wrapPara(inner)
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
function quotePrefix(inner: string): string {
  return normalize(inner)
    .split('\n')
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n')
}

/** A single-line block: one leading newline (adjacent line-blocks become consecutive lines). */
function wrapLine(inner: string): string {
  const trimmed = inner.replace(/^\s+/, '').replace(/\s+$/, '')
  return trimmed === '' ? '' : `\n${trimmed}`
}

/** A paragraph block: a blank-line separator (two leading newlines). */
function wrapPara(inner: string): string {
  const trimmed = inner.replace(/^\s+/, '').replace(/\s+$/, '')
  return trimmed === '' ? '' : `\n\n${trimmed}`
}

/** Trim leading inline spaces and any trailing whitespace, preserving internal (nested) newlines. */
function trimEdges(text: string): string {
  return text.replace(/^[ \t]+/, '').replace(/[ \t\n]+$/, '')
}

/** Trim trailing whitespace per line, cap blank runs at one, and trim leading/trailing blank lines. */
function normalize(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '')
}
