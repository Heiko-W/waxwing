/**
 * vCard TEXT value escaping and structured-value splitting (RFC 6350 §3.4) — pure.
 *
 * **The whole file is one rule applied consistently, and the rule is easy to get almost right.**
 * `\,` `\;` `\\` and `\n`/`\N` are escapes; a backslash before anything else is a literal backslash.
 * Splitting a structured value therefore cannot be `value.split(';')` — a semicolon preceded by a
 * backslash belongs to the component, and `\\;` is a literal backslash FOLLOWED by a separator. Any
 * implementation that unescapes before splitting gets the second case wrong, and the symptom is a
 * Windows path in an address field silently swallowing the next component.
 *
 * So: split first, on unescaped separators only; unescape each piece afterwards. The order is the
 * correctness argument, and `split.test.ts` pins it with `\\;` explicitly.
 */

/** Split a structured value on unescaped `;` (N, ADR, ORG, …). Never unescapes. */
export function splitStructured(value: string): string[] {
  return splitUnescaped(value, ';')
}

/** Split a multi-value component on unescaped `,` (a component of N, CATEGORIES, NICKNAME, …). */
export function splitList(value: string): string[] {
  return splitUnescaped(value, ',')
}

function splitUnescaped(value: string, separator: string): string[] {
  const parts: string[] = []
  let current = ''
  for (let i = 0; i < value.length; i++) {
    const char = value[i] as string
    if (char === '\\') {
      // Copy the backslash AND whatever follows, unexamined. That is what makes `\\;` split
      // correctly: the pair `\\` is consumed here, so the `;` after it is seen as a separator.
      current += char
      const next = value[i + 1]
      if (next !== undefined) {
        current += next
        i++
      }
      continue
    }
    if (char === separator) {
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
 * Unescape a TEXT value (§3.4).
 *
 * `\n` and `\N` both mean a newline. A backslash before anything else is a LITERAL backslash — the
 * spec defines escapes for exactly four things, and inventing more (treating `\t` as a tab, say)
 * would corrupt values that legitimately contain a backslash.
 */
export function unescapeText(value: string): string {
  if (!value.includes('\\')) return value
  let out = ''
  for (let i = 0; i < value.length; i++) {
    const char = value[i] as string
    if (char !== '\\') {
      out += char
      continue
    }
    const next = value[i + 1]
    if (next === undefined) {
      // A trailing lone backslash. Malformed, and dropping it silently would be a worse answer than
      // keeping what the exporter wrote.
      out += '\\'
      continue
    }
    if (next === 'n' || next === 'N') out += '\n'
    else if (next === '\\' || next === ',' || next === ';') out += next
    else out += `\\${next}`
    i++
  }
  return out
}

/**
 * Escape a TEXT value for writing.
 *
 * **`;` is escaped unconditionally**, not only in compound properties. §3.4 requires it inside a
 * compound property's field, and permits it elsewhere; escaping always is the only version that
 * cannot be wrong, because a writer that decides per-property has to know the property's type — and
 * gets it wrong exactly for the extension properties whose types it does not know.
 *
 * A CRLF in the value collapses to one `\n`, so a round trip through a text area that normalised
 * line endings does not double every newline in a note.
 */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;')
}

/** Unescape every component of a structured value. */
export function structuredComponents(value: string): string[] {
  return splitStructured(value).map(unescapeText)
}

/** Unescape every entry of a comma-separated list. */
export function listValues(value: string): string[] {
  return splitList(value).map(unescapeText)
}
