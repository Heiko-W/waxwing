/**
 * vCard 4.0 serialisation (RFC 6350 §3.2) — content lines in, text out.
 *
 * **A line break is the one character that can forge a whole card, so it is removed HERE**, in
 * `renderLine`, and not in each caller — see {@link stripLineBreaking}.
 *
 * **Folding is counted in OCTETS, and that is the whole reason this is not three lines of code.**
 * §3.2 says 75 octets; a naive `slice(0, 75)` counts UTF-16 code units, so a card containing `ü`,
 * `→` or an emoji folds in the wrong place — and worse, can split a multi-byte character or a
 * surrogate pair down the middle, producing a file that is no longer valid UTF-8. The damage is
 * invisible in a diff and shows up as a replacement character in someone's name.
 *
 * So the fold walks CODE POINTS (via the string iterator, which keeps surrogate pairs whole) and
 * measures each one's UTF-8 length before deciding whether it still fits.
 */

import { escapeText } from './value'

/** The RFC's SHOULD. Kept as a constant because the fold tests assert against it, not against 75. */
export const FOLD_OCTETS = 75

/**
 * UTF-8 length of one code point.
 *
 * Computed rather than measured with `TextEncoder`, and that is the reason this package needs no
 * Web API at all: it runs unchanged in a browser, in Node and in a worker. (The test measures the
 * same strings WITH a `TextEncoder`, deliberately — an independent oracle, so a bug in this
 * arithmetic cannot hide behind a round trip that agrees with itself.)
 */
function octetLength(codePoint: string): number {
  const code = codePoint.codePointAt(0) ?? 0
  if (code < 0x80) return 1
  if (code < 0x800) return 2
  if (code < 0x10000) return 3
  return 4
}

/** UTF-8 length of a whole string, by code point — surrogate pairs counted once, as 4. */
function utf8Length(value: string): number {
  let total = 0
  for (const codePoint of value) total += octetLength(codePoint)
  return total
}

/**
 * Fold one logical line to {@link FOLD_OCTETS} octets, continuing with CRLF + one space.
 *
 * The continuation's leading space is part of the fold, not of the value: `unfold` removes exactly
 * one whitespace character after the break (see `lex.ts`), so the two are inverse. A writer that
 * indented by two spaces would round-trip a leading space into every folded value.
 */
export function foldLine(line: string): string {
  if (utf8Length(line) <= FOLD_OCTETS) return line

  const chunks: string[] = []
  let current = ''
  let width = 0
  for (const codePoint of line) {
    const size = octetLength(codePoint)
    // The continuation line's leading space costs an octet, so subsequent chunks have one less.
    const limit = chunks.length === 0 ? FOLD_OCTETS : FOLD_OCTETS - 1
    if (width + size > limit) {
      chunks.push(current)
      current = ''
      width = 0
    }
    current += codePoint
    width += size
  }
  if (current !== '') chunks.push(current)
  return chunks.join('\r\n ')
}

export interface WritableLine {
  readonly group?: string | null
  readonly name: string
  /** Values are written verbatim — apply RFC 6868 escaping via {@link escapeParam} first. */
  readonly params?: ReadonlyMap<string, readonly string[]> | undefined
  /**
   * Already escaped and already joined. Use the value helpers to build it — EXCEPT for URI values
   * (`URL`, `PHOTO`, preserved properties), which are written unescaped by design and are made safe
   * by {@link stripLineBreaking} in {@link renderLine} rather than by escaping.
   */
  readonly value: string
}

/**
 * Everything a reader could mistake for the end of this line, dropped.
 *
 * **Without this, one CRLF in a URI forges an entire second card.** TEXT values go through
 * `escapeText` (CRLF → `\n`) and parameters through `escapeParam` (CRLF → `^n`), but a URI value is
 * deliberately written raw — escaping a `data:` URI's base64 or a query string's `,` would corrupt
 * it — so `URL`, `PHOTO`/`LOGO` and the verbatim `vCardProps` values had no defence at all. A
 * `links.l1.uri` of `…\r\nEND:VCARD\r\nBEGIN:VCARD\r\nFN:Chief Exec\r\nEMAIL:attacker@evil.tld…`
 * (reachable from a JSContact JSON import or a shared address book) exported a .vcf that Outlook and
 * Apple Contacts read as TWO contacts, the second being the attacker's, autocompleted forever after.
 *
 * Dropped rather than percent-encoded: `renderLine` cannot know whether a slot is URI or TEXT, and
 * `%0A` inside a NOTE would be visible corruption — whereas RFC 6350's ABNF (§3.3, `VALUE-CHAR =
 * WSP / %x21-7E / NON-ASCII`) forbids these characters in BOTH slots, so removing them only ever
 * removes something already invalid. HTAB stays: it is WSP, and legal in a value.
 *
 * Beyond C0/DEL this also drops NEL, LS and PS, because they are not line breaks to a vCard parser
 * but ARE to `str.splitlines()` — the risk is the consumer's line splitter, not ours.
 *
 * What it does NOT do: sanitise property names or parameter KEYS beyond this (a `;` or `:` smuggled
 * into a preserved property's name still garbles ITS line) — but with no line break available, the
 * damage cannot escape the one line, and one card in stays one card out.
 */
function stripLineBreaking(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters is the point
  return value.replace(/[\u0000-\u0008\u000A-\u001F\u007F\u0085\u2028\u2029]/g, '')
}

/**
 * RFC 6868 §3.1 — the inverse of the lexer's `unescapeParam`.
 *
 * A parameter value is quoted when it contains a character that would otherwise end it. Note the
 * order: the caret is escaped FIRST, or escaping a newline to `^n` would then have its own caret
 * escaped into `^^n`.
 */
export function escapeParam(value: string): string {
  const escaped = value
    .replace(/\^/g, '^^')
    .replace(/\r\n|\r|\n/g, '^n')
    .replace(/"/g, "^'")
  return /[;:,]/.test(escaped) ? `"${escaped}"` : escaped
}

/**
 * Render one content line, unfolded.
 *
 * The whole line — group, name, parameter keys and value alike — passes through
 * {@link stripLineBreaking} on the way out. Doing it here rather than in each caller is the point:
 * `to-vcard.ts` has three slots that write a value raw today, and the next URI-bearing property
 * added there would silently become a fourth.
 */
export function renderLine(line: WritableLine): string {
  let head =
    line.group === null || line.group === undefined ? line.name : `${line.group}.${line.name}`
  for (const [key, values] of line.params ?? new Map<string, readonly string[]>()) {
    if (values.length === 0) continue
    head += `;${key}=${values.map(escapeParam).join(',')}`
  }
  return stripLineBreaking(`${head}:${line.value}`)
}

/**
 * Render a whole vCard: `BEGIN:VCARD` / `VERSION:4.0` / properties / `END:VCARD`, CRLF-delimited.
 *
 * **`VERSION` must come first, immediately after `BEGIN`** (§6.7.9), and it is the one ordering
 * constraint in the format. A parser is entitled to reject everything before it sees the version,
 * so a writer that sorts properties alphabetically produces files some readers refuse outright.
 */
export function renderCard(lines: readonly WritableLine[]): string {
  const out = ['BEGIN:VCARD', 'VERSION:4.0']
  for (const line of lines) out.push(foldLine(renderLine(line)))
  out.push('END:VCARD')
  return `${out.join('\r\n')}\r\n`
}

/** Join structured components, escaping each. `['Meier', 'Anna']` → `Meier;Anna`. */
export function joinStructured(components: readonly string[]): string {
  return components.map(escapeText).join(';')
}

/** Join a multi-value component, escaping each. */
export function joinList(values: readonly string[]): string {
  return values.map(escapeText).join(',')
}
