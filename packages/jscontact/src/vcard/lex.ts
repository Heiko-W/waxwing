/**
 * vCard 4.0 lexing (RFC 6350 §3) — text in, content lines out. No JSContact anywhere near it.
 *
 * This layer exists on its own because every mistake it can make is silent. A vCard that unfolds
 * wrongly still parses; a value that unescapes wrongly still looks like a name. The failure reaches
 * the user as "my contact is called `Meier\, Anna`" three screens later, with nothing in between to
 * suggest where it came from.
 *
 * Two decisions worth stating up front, because both are deliberate deviations from a literal
 * reading of the ABNF:
 *
 *  - **Line endings are accepted as CRLF, LF or CR.** RFC 6350 §3.2 mandates CRLF, and we EMIT
 *    CRLF (see `write.ts`). But an exporter that writes bare LF is not hypothetical — it is what a
 *    file that has been through a Unix tool, a git checkout with `core.autocrlf`, or a textarea
 *    paste looks like. Refusing those would fail an import the user has no way to fix, over a
 *    distinction they cannot see.
 *  - **An unrecognisable line is skipped, not thrown on.** A vCard is a bulk format: a 400-contact
 *    export with one broken line should import 399 contacts, not zero. The lines that were dropped
 *    are REPORTED (`ParseResult.skipped`), because silently importing 399 of 400 is its own defect.
 */

/** One parsed content line: `[group.]NAME;PARAM=value:value`. */
export interface ContentLine {
  /** The optional group prefix, lower-cased for comparison. `item1.TEL` → `item1`. */
  readonly group: string | null
  /** Upper-cased property name — vCard names are case-insensitive (§3.3). */
  readonly name: string
  /**
   * Parameters, keys upper-cased. A parameter may repeat and may carry a comma-separated list, and
   * both mean the same thing (`TYPE=work,voice` ≡ `TYPE=work;TYPE=voice`), so every value is
   * collected into one array per key.
   */
  readonly params: ReadonlyMap<string, readonly string[]>
  /** The raw value, still escaped and still undivided. Use the helpers below to interpret it. */
  readonly value: string
}

export interface SkippedLine {
  /** 1-based, counted in UNFOLDED logical lines — what a human sees in an editor is close enough. */
  readonly line: number
  readonly text: string
  readonly reason: 'noColon' | 'emptyName'
}

export interface ParseResult {
  readonly lines: readonly ContentLine[]
  /** Never silently empty: a caller that imports 399 of 400 contacts has to be able to say so. */
  readonly skipped: readonly SkippedLine[]
}

/**
 * Unfold (§3.2) and split into logical lines.
 *
 * Folding inserts a line break plus ONE whitespace character; unfolding removes exactly that pair.
 * Removing "the line break and any following whitespace" would be wrong in a way that survives every
 * casual test: a folded line whose continuation legitimately begins with a space — an address
 * component like `;;Main Street 1;` folded mid-value — would lose that space silently.
 */
function unfold(text: string): string[] {
  // Strip a UTF-8 BOM: exports from Outlook and from Excel-mediated pipelines carry one, and it
  // would otherwise become part of the first property name (`﻿BEGIN`), failing the whole card.
  const source = text.startsWith('﻿') ? text.slice(1) : text
  const out: string[] = []
  let current = ''
  let i = 0

  while (i < source.length) {
    const char = source[i] as string
    if (char === '\r' || char === '\n') {
      // Consume the break: CRLF as one, otherwise the single character.
      const breakLength = char === '\r' && source[i + 1] === '\n' ? 2 : 1
      const next = source[i + breakLength]
      if (next === ' ' || next === '\t') {
        // A fold: drop the break AND exactly one whitespace character, then keep going.
        i += breakLength + 1
        continue
      }
      out.push(current)
      current = ''
      i += breakLength
      continue
    }
    current += char
    i++
  }
  if (current !== '') out.push(current)
  return out
}

/**
 * Split a content line at the first colon that is not inside a quoted parameter value.
 *
 * The quoting matters: `TEL;TYPE="work:main":+49 …` is legal (§3.3 allows DQUOTE-delimited
 * parameter values precisely so they may contain colons and semicolons), and splitting on the first
 * raw colon would produce the name `TEL;TYPE="work` and lose the rest.
 */
function splitAtValueColon(line: string): { head: string; value: string } | null {
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (char === '"') {
      quoted = !quoted
      continue
    }
    if (char === ':' && !quoted) {
      return { head: line.slice(0, i), value: line.slice(i + 1) }
    }
  }
  return null
}

/** Split on `;` outside quotes — the parameter separator. */
function splitParams(head: string): string[] {
  const parts: string[] = []
  let current = ''
  let quoted = false
  for (const char of head) {
    if (char === '"') {
      quoted = !quoted
      current += char
      continue
    }
    if (char === ';' && !quoted) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  parts.push(current)
  return parts
}

/**
 * Split a parameter's value list on `,` outside quotes, then unquote.
 *
 * RFC 6868 escaping (`^n`, `^^`, `^'`) is applied here: it is how a parameter value carries a
 * newline, a caret or a double quote, and an importer that skips it shows the user a literal `^n`
 * in a label.
 */
function paramValues(raw: string): string[] {
  const values: string[] = []
  let current = ''
  let quoted = false
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i] as string
    if (char === '"') {
      quoted = !quoted
      continue
    }
    if (char === ',' && !quoted) {
      values.push(unescapeParam(current))
      current = ''
      continue
    }
    current += char
  }
  values.push(unescapeParam(current))
  return values
}

/** RFC 6868 §3.1: `^n` → newline, `^^` → caret, `^'` → double quote. Anything else stays literal. */
function unescapeParam(value: string): string {
  if (!value.includes('^')) return value
  let out = ''
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== '^') {
      out += value[i]
      continue
    }
    const next = value[i + 1]
    if (next === 'n') {
      out += '\n'
      i++
    } else if (next === '^') {
      out += '^'
      i++
    } else if (next === "'") {
      out += '"'
      i++
    } else {
      out += '^'
    }
  }
  return out
}

/**
 * `item1.TEL` → `{ group: 'item1', name: 'TEL' }`.
 *
 * The group prefix is how Apple carries the custom labels its Contacts app shows — an `item1.TEL`
 * beside an `item1.X-ABLabel:_$!<Home>!$_`. Dropping it turns every custom label into an unlabelled
 * field, which is data loss the user can see. Only the FIRST dot separates: a property name cannot
 * contain one, so anything after it belongs to the name.
 */
function splitGroupAndName(namePart: string): { group: string | null; name: string } {
  const trimmed = namePart.trim()
  const dot = trimmed.indexOf('.')
  if (dot === -1) return { group: null, name: trimmed.toUpperCase() }
  return {
    group: trimmed.slice(0, dot).toLowerCase(),
    name: trimmed.slice(dot + 1).toUpperCase(),
  }
}

/** Parse a vCard (or a stream of several) into content lines. Never throws. */
export function parseContentLines(text: string): ParseResult {
  const lines: ContentLine[] = []
  const skipped: SkippedLine[] = []

  unfold(text).forEach((raw, index) => {
    if (raw.trim() === '') return
    const split = splitAtValueColon(raw)
    if (split === null) {
      skipped.push({ line: index + 1, text: raw, reason: 'noColon' })
      return
    }

    const [namePart, ...paramParts] = splitParams(split.head)
    const { group, name } = splitGroupAndName(namePart ?? '')

    if (name === '') {
      skipped.push({ line: index + 1, text: raw, reason: 'emptyName' })
      return
    }

    const params = new Map<string, string[]>()
    for (const part of paramParts) {
      const eq = part.indexOf('=')
      // A valueless parameter is legacy vCard 3.0 shorthand (`TEL;WORK:…`, `EMAIL;PREF:…`), and it
      // is all over real exports. Treated as a TYPE value, which is what it meant.
      const key = (eq === -1 ? 'TYPE' : part.slice(0, eq)).trim().toUpperCase()
      const values = eq === -1 ? [part.trim()] : paramValues(part.slice(eq + 1))
      const bucket = params.get(key)
      if (bucket === undefined) params.set(key, values)
      else bucket.push(...values)
    }

    lines.push({ group, name, params, value: split.value })
  })

  return { lines, skipped }
}
