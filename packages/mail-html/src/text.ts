/**
 * Plain-text mail renderer (M1.7, FR-RD-01). Turns a `text/plain` body into SAFE HTML for the
 * sandboxed frame: every character is HTML-escaped first, bare `http(s)` URLs are linkified (only
 * those two schemes — never `javascript:`/`data:`), and quoted sections (`>` prefixes) are folded
 * into native `<details>`/`<blockquote>` disclosures — folding that needs NO script, so it works
 * inside a script-free sandbox. The output contains no `<script>`, event handlers, or dangerous
 * URLs by construction (nothing from the input reaches HTML unescaped except matched safe URLs).
 */

import { escapeHtml } from './escape'

export interface PlainTextOptions {
  /** Localized summary for the collapsible quoted-text disclosure (the app supplies it via i18n). */
  readonly quotedLabel?: string
}

interface ParsedLine {
  readonly depth: number
  readonly content: string
}

/** Matches an `http(s)` URL; trailing sentence punctuation is trimmed off in {@link linkify}. */
const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/g

/**
 * Sentence punctuation that a URL at the end of a sentence picks up but does not own.
 *
 * A SET and a backwards loop, deliberately not the regex `/[.,;:!?)\]}'"]+$/` this replaced. That
 * shape has no left anchor, so the engine retries the repetition at every start position of the
 * token, and each retry that fails `$` rolls the whole run back: O(n^2) in the token length. A
 * text/plain body may put a 100 KB run of dots into one URL token, and that cost lands on the main
 * thread while the message renders — measured 8.2 s at 100 KB before, 0 ms after.
 */
const TRAILING_PUNCTUATION: ReadonlySet<string> = new Set([...`.,;:!?)]}'"`])

/** Strip the trailing sentence punctuation off a matched URL token. Linear in `url.length`. */
function trimTrailingPunctuation(url: string): string {
  let end = url.length
  while (end > 0 && TRAILING_PUNCTUATION.has(url[end - 1] as string)) end -= 1
  return url.slice(0, end)
}

/** Render a plain-text body to safe HTML. */
export function renderPlainText(text: string, options: PlainTextOptions = {}): string {
  const label = options.quotedLabel ?? 'Quoted text'
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map(parseLine)
  return renderLevel(lines, 0, label)
}

/**
 * Bound the quote nesting so a hostile body of thousands of leading `>` cannot overflow the
 * (per-level) recursion. Markers past the cap stay in the (escaped) line content.
 */
const MAX_QUOTE_DEPTH = 20

/** Count the leading `>` quote markers (optionally each followed by a space) and strip them. */
function parseLine(line: string): ParsedLine {
  let depth = 0
  let index = 0
  while (depth < MAX_QUOTE_DEPTH && line[index] === '>') {
    depth += 1
    index += 1
    if (line[index] === ' ') index += 1
  }
  return { depth, content: line.slice(index) }
}

/**
 * Render a run of lines whose quote depth is `>= baseDepth`. Lines at exactly `baseDepth` become a
 * paragraph; a deeper run is recursively wrapped in a collapsible `<blockquote>`.
 */
function renderLevel(lines: readonly ParsedLine[], baseDepth: number, label: string): string {
  let html = ''
  const paragraph: string[] = []
  const flush = (): void => {
    if (paragraph.length > 0) {
      html += `<p>${paragraph.join('<br>')}</p>`
      paragraph.length = 0
    }
  }

  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (line === undefined) break
    if (line.depth <= baseDepth) {
      paragraph.push(linkify(line.content))
      index += 1
      continue
    }
    flush()
    const start = index
    while (index < lines.length && (lines[index]?.depth ?? 0) > baseDepth) index += 1
    const inner = renderLevel(lines.slice(start, index), baseDepth + 1, label)
    html += `<details class="waxwing-quote"><summary>${escapeHtml(label)}</summary><blockquote>${inner}</blockquote></details>`
  }
  flush()
  return html
}

/**
 * Escape `content` and wrap bare `http(s)` URLs in anchors.
 *
 * No `target`, deliberately. `frame.ts` treats `target="_blank"` as a RECORD of a decision it made
 * itself — the click listener steps aside for such an anchor, because `prepareLinks` writes the
 * attribute only on links the app released. This renderer knows nothing about that decision, and
 * writing the attribute here made every plain-text link look released: `gateLink` was still asked,
 * its answer was still "keep and warn", and the browser navigated anyway, with the link-warning
 * dialog unreachable for text/plain bodies entirely (ADR-029's invariant, in reverse).
 *
 * `rel` stays: it costs nothing on an intercepted link and is correct on a released one.
 */
function linkify(content: string): string {
  let html = ''
  let lastIndex = 0
  for (const match of content.matchAll(URL_PATTERN)) {
    const rawUrl = match[0]
    const matchStart = match.index
    const url = trimTrailingPunctuation(rawUrl)
    html += escapeHtml(content.slice(lastIndex, matchStart))
    const safeUrl = escapeHtml(url)
    html += `<a href="${safeUrl}" rel="noopener noreferrer nofollow">${safeUrl}</a>`
    lastIndex = matchStart + url.length
  }
  html += escapeHtml(content.slice(lastIndex))
  return html
}
