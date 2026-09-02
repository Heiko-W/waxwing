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

/**
 * A vCard date-time (§4.3.3) or timestamp (§4.3.5), in the BASIC form the RFC mandates and in the
 * extended form vCard 3.0 exporters emit.
 *
 * Minutes and seconds are optional because `time` is; a fractional second is accepted because RFC
 * 3339 allows one on the JSContact side and this grammar reads both directions. The zone is `Z` or
 * `±hh[:mm]`, and its ABSENCE is meaningful rather than a parse failure — see
 * {@link fromVCardTimestamp}.
 */
const DATE_TIME =
  /^(\d{4})-?(\d{2})-?(\d{2})T(\d{2})(?::?(\d{2}))?(?::?(\d{2}))?(?:\.\d+)?(Z|z|[+-]\d{2}(?::?\d{2})?)?$/

/** Minutes east of UTC for `Z` / `±hh` / `±hhmm` / `±hh:mm`, or `undefined` for anything else. */
function zoneOffsetMinutes(zone: string): number | undefined {
  if (zone === 'Z' || zone === 'z') return 0
  const match = /^([+-])(\d{2}):?(\d{2})?$/.exec(zone)
  if (!match) return undefined
  const hours = Number(match[2])
  const minutes = Number(match[3] ?? '0')
  if (hours > 23 || minutes > 59) return undefined
  return (match[1] === '-' ? -1 : 1) * (hours * 60 + minutes)
}

/**
 * A vCard timestamp → the RFC 3339 `UTCDateTime` JSContact wants (RFC 9553 §1.4.5, §2.1.10).
 *
 * The two formats are NOT interchangeable and the package used to copy the value straight from one
 * world into the other in both directions: vCard 4.0 wants the ISO 8601 BASIC form without hyphens
 * or colons (§4.3.5, and §6.7.4's own example `REV:19951031T222710Z`), JSContact wants RFC 3339
 * with a `Z`. So Outlook's `REV:20260701T091200Z` became `updated: "20260701T091200Z"` and went to
 * the server as an invalid `UTCDateTime`, while a server card's `updated` came back out as
 * `REV:2026-07-01T09:12:00Z`, which is vCard 3.0 grammar and not 4.0.
 *
 * Three answers, because "no zone" and "not a timestamp" are different facts. `null` is a
 * well-formed date-time that names NO zone: a local wall-clock reading, which is not an instant and
 * which JSContact cannot hold, so guessing UTC for it would move the moment by up to a day.
 * `undefined` is "not a date-time at all". Both leave the caller free to keep the raw line instead
 * of inventing a value — which is what `from-vcard.ts` does, via `vCardProps`.
 *
 * `Date.UTC` does the offset arithmetic, so a zone that crosses midnight, a month end or a year end
 * lands on the right day: `20090101T0030+0500` is 2008-12-31 in UTC, and hand-rolled subtraction
 * gets exactly that class of day wrong.
 */
export function fromVCardTimestamp(raw: string): string | null | undefined {
  const match = DATE_TIME.exec(raw.trim())
  if (match === null) return undefined
  const zone = match[7]
  if (zone === undefined) return null
  const offset = zoneOffsetMinutes(zone)
  if (offset === undefined) return undefined
  const ms = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5] ?? '0'),
    Number(match[6] ?? '0'),
  )
  if (!Number.isFinite(ms)) return undefined
  // `toISOString` emits milliseconds; neither a vCard timestamp nor anything this package writes
  // has them, and truncating is what keeps a round trip a fixed point.
  return `${new Date(ms - offset * 60_000).toISOString().slice(0, 19)}Z`
}

/**
 * The inverse: an RFC 3339 `UTCDateTime` → a vCard 4.0 `timestamp` (§4.3.5), or `undefined` when
 * the input is not one.
 *
 * `undefined` rather than the input unchanged, deliberately. The caller's choice is then between
 * omitting the property and writing something no vCard 4.0 parser is required to accept; omitting
 * is the honest one, and for an unreadable `REV` the untouched line rides out in `vCardProps`
 * anyway.
 */
export function toVCardTimestamp(iso: string): string | undefined {
  const utc = fromVCardTimestamp(iso)
  if (typeof utc !== 'string') return undefined
  return `${utc.slice(0, 4)}${utc.slice(5, 7)}${utc.slice(8, 10)}T${utc.slice(11, 13)}${utc.slice(14, 16)}${utc.slice(17, 19)}Z`
}
