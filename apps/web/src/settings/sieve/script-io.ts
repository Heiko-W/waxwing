/**
 * Reading and writing the managed Sieve script (M5.2, FR-SIEVE-01).
 *
 * The problem this file exists to solve: a Sieve script may already contain rules the user wrote
 * by hand, or that Roundcube, Nextcloud or a server admin put there. A filter editor that owns
 * the whole script will destroy them. Every client that compiles a builder to Sieve has had this
 * bug at least once.
 *
 * The approach here is deliberately narrower than parsing:
 *
 * - **Our rules live between two markers**, with their structure carried as JSON in the opening
 *   marker comment. Reading them back is `JSON.parse`, never re-parsing the generated Sieve —
 *   the builder's vocabulary is smaller than Sieve's, so a round trip through the language would
 *   quietly change what a rule does.
 * - **Everything outside the markers is foreign, and is never interpreted.** It is carried across
 *   a save byte for byte, in its original order. We do not try to show it as rules; the UI shows
 *   it read-only, as source.
 * - **Any doubt makes the whole script opaque.** Broken JSON, an unknown version, a rule that
 *   fails validation, a second opening marker: the editor drops to a read-only source view rather
 *   than guessing. A filter that silently does something other than what it says is worse than
 *   one that refuses to render.
 *
 * The markers are `#` line comments, not `/* … *​/` blocks, so that no user-supplied text can
 * close them early — a rule named `*​/` would end a block comment and turn the rest of the
 * metadata into Sieve source.
 */

import type {
  SieveAction,
  SieveCondition,
  SieveMatch,
  SieveRule,
  SieveTextField,
} from './rule-model'
import { generateSieve, renderRequire } from './rule-model'

/**
 * Opens the managed region: `# @waxwing:rules:v<N> ` followed by the rule set as JSON.
 *
 * The version is in the marker AND in the payload, and the two must agree — a script whose marker
 * says one thing and whose JSON says another was edited by something that understood neither.
 *
 * `[^\r\n]*` rather than `.*`, because JavaScript's `.` stops at U+2028 and U+2029 as well —
 * they are line terminators to a regular expression but not to Sieve, whose comments end at CRLF
 * (RFC 5228 §2.3). A rule name containing one therefore truncated the captured JSON mid-string,
 * `JSON.parse` failed, and the whole script went opaque. `buildScript` no longer emits them raw,
 * but this is what still reads a script an earlier build already wrote.
 */
const MARKER_BEGIN = /^# @waxwing:rules:v(\d+) ([^\r\n]*)$/gm
/** Closes the managed region. */
const MARKER_END = '# @waxwing:rules:end'
/**
 * The schema version written today.
 *
 * v2 widened the vocabulary (envelope, spam score, delivery time, duplicates, reject). Per ADR-023
 * a build that widens the vocabulary bumps the version, so that an OLDER build meeting a v2 script
 * finds no marker it recognises and treats the script as opaque — read-only, uneditable, intact —
 * rather than saving it back with the conditions it could not represent quietly dropped.
 */
const SCHEMA_VERSION = 2
/** The versions this build can read. Writing is always {@link SCHEMA_VERSION}. */
const READABLE_VERSIONS: ReadonlySet<number> = new Set([1, 2])
/** The marker line for `version`. */
function markerFor(version: number): string {
  return `# @waxwing:rules:v${String(version)} `
}

/** Header for the foreign section, so a human reading the script knows why it moved. */
const FOREIGN_HEADER = '# Rules managed outside this client — preserved untouched.'

export interface ManagedScript {
  /** The rules we manage, or `null` when the script is opaque. */
  readonly rules: readonly SieveRule[] | null
  /** Foreign source preceding our region, verbatim (without its `require` line). */
  readonly preamble: string
  /** Foreign source following our region, verbatim. */
  readonly trailer: string
  /** Extension names the foreign source requires, so a rebuild does not drop them. */
  readonly foreignRequires: readonly string[]
  /** True when the script could not be understood and must be shown read-only. */
  readonly opaque: boolean
}

/** An empty script — what a user with no filters yet starts from. */
export const EMPTY_SCRIPT: ManagedScript = {
  rules: [],
  preamble: '',
  trailer: '',
  foreignRequires: [],
  opaque: false,
}

/** Marks the whole of `source` as untouchable foreign text. */
function opaqueScript(source: string): ManagedScript {
  return { rules: null, preamble: source, trailer: '', foreignRequires: [], opaque: true }
}

/**
 * Splits the leading `require` commands off `source` (RFC 5228 §3.2 requires them first).
 *
 * Returns the extension names and the remaining source. Foreign requires have to be hoisted into
 * the single `require` line we emit; leaving them in place would put a `require` after a command,
 * which is a syntax error.
 */
export function splitRequires(source: string): { requires: string[]; rest: string } {
  const requires: string[] = []
  const spans: { start: number; end: number }[] = []
  let index = 0

  for (;;) {
    index = skipTrivia(source, index)
    if (!source.startsWith('require', index)) break
    // Guard against an identifier that merely begins with "require".
    const after = source.charAt(index + 'require'.length)
    if (after !== '' && !/[\s["']/.test(after)) break

    const end = findCommandEnd(source, index + 'require'.length)
    if (end === -1) break
    for (const name of readStrings(source.slice(index, end))) requires.push(name)
    spans.push({ start: index, end: end + 1 })
    index = end + 1
  }

  // Cut the require commands out rather than slicing off everything before the last one: a comment
  // sitting between (or above) them is the user's, and skipping past it must not consume it.
  let rest = ''
  let cursor = 0
  for (const span of spans) {
    rest += source.slice(cursor, span.start)
    cursor = span.end
  }
  rest += source.slice(cursor)

  return { requires, rest }
}

/** Advances past whitespace and comments, which may sit between commands. */
function skipTrivia(source: string, start: number): number {
  let index = start
  for (;;) {
    const before = index
    while (index < source.length && /\s/.test(source.charAt(index))) index += 1
    if (source.startsWith('#', index)) {
      const nl = source.indexOf('\n', index)
      index = nl === -1 ? source.length : nl + 1
    } else if (source.startsWith('/*', index)) {
      const close = source.indexOf('*/', index + 2)
      index = close === -1 ? source.length : close + 2
    }
    if (index === before) return index
  }
}

/** Index of the `;` ending a command, skipping over string literals. Returns -1 when unterminated. */
function findCommandEnd(source: string, start: number): number {
  let index = start
  while (index < source.length) {
    const char = source.charAt(index)
    if (char === '"') {
      index = skipString(source, index)
      continue
    }
    if (char === ';') return index
    index += 1
  }
  return -1
}

/** Index just past the quoted string starting at `start`. */
function skipString(source: string, start: number): number {
  let index = start + 1
  while (index < source.length) {
    const char = source.charAt(index)
    if (char === '\\') {
      index += 2
      continue
    }
    if (char === '"') return index + 1
    index += 1
  }
  return source.length
}

/** Every quoted string in `fragment`, unescaped. */
function readStrings(fragment: string): string[] {
  const found: string[] = []
  let index = 0
  while (index < fragment.length) {
    if (fragment.charAt(index) !== '"') {
      index += 1
      continue
    }
    const end = skipString(fragment, index)
    found.push(fragment.slice(index + 1, end - 1).replace(/\\(.)/g, '$1'))
    index = end
  }
  return found
}

/**
 * The closing marker as a LINE of its own, or -1.
 *
 * A plain `indexOf` matched the marker text anywhere, including inside a generated Sieve string
 * literal — a rule that files mail whose subject contains `@waxwing:rules:end` ended the managed
 * region in the middle of its own `if` block. Everything after it became foreign trailer text,
 * which the next save re-emitted verbatim BELOW the region: the rule ran twice, and every `stop`
 * after it moved.
 *
 * Anchored on a literal `\n` rather than a regex `^`, because `^` in multiline mode also matches
 * after U+2028/U+2029 — which a rule name may contain and `quoteSieveString` does not flatten,
 * since they are ordinary characters to Sieve.
 */
function findEndMarker(source: string, from: number): number {
  let index = source.indexOf(MARKER_END, from)
  while (index !== -1) {
    if (index === 0 || source.charAt(index - 1) === '\n') return index
    index = source.indexOf(MARKER_END, index + 1)
  }
  return -1
}

/**
 * Reads a stored script into rules plus untouched foreign text.
 *
 * Never throws: an unreadable script comes back {@link ManagedScript.opaque}.
 */
export function parseScript(source: string): ManagedScript {
  if (source.trim() === '') return EMPTY_SCRIPT

  const markers = [...source.matchAll(MARKER_BEGIN)]
  if (markers.length === 0) {
    // No managed region: the whole script belongs to someone else. Not an error — the common case
    // on first use against a mailbox that already had filters, and also what an OLDER build sees
    // when it meets a script written by a NEWER one.
    return opaqueScript(source)
  }
  // A second opening marker means the file was edited into a shape we cannot reason about.
  if (markers.length > 1) return opaqueScript(source)

  const marker = markers[0] as RegExpMatchArray
  const begin = marker.index ?? -1
  if (begin === -1) return opaqueScript(source)
  const version = Number(marker[1])
  if (!READABLE_VERSIONS.has(version)) return opaqueScript(source)
  const json = (marker[2] ?? '').trim()

  const lineEnd = begin + marker[0].length
  const endMarker = findEndMarker(source, lineEnd)
  if (endMarker === -1) return opaqueScript(source)
  const endLine = source.indexOf('\n', endMarker)
  const afterEnd = endLine === -1 ? source.length : endLine + 1

  const rules = readRules(json, version)
  if (rules === null) return opaqueScript(source)

  const beforeRegion = source.slice(0, begin)
  const { requires, rest } = splitRequires(beforeRegion)
  return {
    rules,
    preamble: stripForeignHeader(rest).trim(),
    trailer: stripForeignHeader(source.slice(afterEnd)).trim(),
    foreignRequires: requires,
    opaque: false,
  }
}

/** Removes the header we add above foreign source, so it does not accumulate across saves. */
function stripForeignHeader(source: string): string {
  return source
    .split('\n')
    .filter((line) => line.trim() !== FOREIGN_HEADER)
    .join('\n')
}

/** Parses and validates the metadata payload. `null` means "do not trust this script". */
function readRules(json: string, markerVersion: number): SieveRule[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const payload = parsed as { version?: unknown; rules?: unknown }
  // A script written by a NEWER version may use conditions this build cannot render. Refusing to
  // edit it is the only safe answer: saving would silently drop whatever we failed to understand.
  // The payload has to agree with the marker line, too: a script where the two disagree was
  // rewritten by something that understood neither.
  if (payload.version !== markerVersion) return null
  if (!Array.isArray(payload.rules)) return null

  const rules: SieveRule[] = []
  for (const candidate of payload.rules) {
    const rule = readRule(candidate)
    if (rule === null) return null
    rules.push(rule)
  }
  return rules
}

function readRule(value: unknown): SieveRule | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  if (typeof raw.id !== 'string' || typeof raw.name !== 'string') return null
  if (typeof raw.enabled !== 'boolean' || typeof raw.stop !== 'boolean') return null
  if (raw.match !== 'all' && raw.match !== 'any') return null
  if (!Array.isArray(raw.conditions) || !Array.isArray(raw.actions)) return null

  const conditions: SieveCondition[] = []
  for (const candidate of raw.conditions) {
    const condition = readCondition(candidate)
    if (condition === null) return null
    conditions.push(condition)
  }
  const actions: SieveAction[] = []
  for (const candidate of raw.actions) {
    const action = readAction(candidate)
    if (action === null) return null
    actions.push(action)
  }

  return {
    id: raw.id,
    name: raw.name,
    enabled: raw.enabled,
    match: raw.match,
    conditions,
    actions,
    stop: raw.stop,
  }
}

const TEXT_FIELDS: readonly SieveTextField[] = [
  'from',
  'to',
  'cc',
  'subject',
  'body',
  'envelopeFrom',
  'envelopeTo',
]
const MATCHES: readonly SieveMatch[] = ['contains', 'is', 'startsWith', 'endsWith', 'matches']

function readCondition(value: unknown): SieveCondition | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  switch (raw.kind) {
    case 'text': {
      if (!TEXT_FIELDS.includes(raw.field as SieveTextField)) return null
      if (!MATCHES.includes(raw.match as SieveMatch)) return null
      if (typeof raw.value !== 'string') return null
      return {
        kind: 'text',
        field: raw.field as SieveTextField,
        match: raw.match as SieveMatch,
        value: raw.value,
      }
    }
    case 'size': {
      if (raw.operator !== 'over' && raw.operator !== 'under') return null
      if (typeof raw.bytes !== 'number' || !Number.isFinite(raw.bytes)) return null
      return { kind: 'size', operator: raw.operator, bytes: raw.bytes }
    }
    case 'hasAttachment':
      return { kind: 'hasAttachment' }
    case 'spam': {
      if (raw.operator !== 'atLeast' && raw.operator !== 'atMost') return null
      if (typeof raw.score !== 'number' || !Number.isFinite(raw.score)) return null
      return { kind: 'spam', operator: raw.operator, score: raw.score }
    }
    case 'currentDate': {
      if (raw.part !== 'weekday' && raw.part !== 'hour') return null
      if (raw.operator !== 'is' && raw.operator !== 'atLeast' && raw.operator !== 'atMost')
        return null
      if (typeof raw.value !== 'number' || !Number.isFinite(raw.value)) return null
      return { kind: 'currentDate', part: raw.part, operator: raw.operator, value: raw.value }
    }
    case 'duplicate':
      return { kind: 'duplicate' }
    default:
      return null
  }
}

function readAction(value: unknown): SieveAction | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  switch (raw.kind) {
    case 'fileInto':
      if (typeof raw.mailboxId !== 'string' || typeof raw.mailboxName !== 'string') return null
      return { kind: 'fileInto', mailboxId: raw.mailboxId, mailboxName: raw.mailboxName }
    case 'addFlag':
      if (raw.flag !== '\\Flagged' && raw.flag !== '\\Seen') return null
      return { kind: 'addFlag', flag: raw.flag }
    case 'redirect':
      if (typeof raw.address !== 'string') return null
      return { kind: 'redirect', address: raw.address }
    case 'discard':
      return { kind: 'discard' }
    case 'reject':
      if (typeof raw.reason !== 'string') return null
      return { kind: 'reject', reason: raw.reason }
    default:
      return null
  }
}

/**
 * Renders rules plus preserved foreign source into a complete script.
 *
 * Layout: one merged `require`, the foreign preamble, our marked region, the foreign trailer.
 *
 * **Foreign source keeps its position, not just its bytes.** Sieve is evaluated in order and a
 * foreign `stop;` or `fileinto` decides whether later rules run at all — so moving someone's rules
 * below ours would change what their mail does while claiming to have preserved them. Keeping the
 * position also makes a save idempotent: parse → build → parse lands on the same text.
 */
/**
 * Escapes U+2028 and U+2029 in the metadata JSON.
 *
 * `JSON.stringify` leaves them raw — they are ordinary characters to JSON, and to Sieve, whose
 * comments end at CRLF (RFC 5228 §2.3). They are NOT ordinary to a JavaScript regular expression,
 * where they terminate a line: `MARKER_BEGIN` stopped at the first one, the captured JSON was cut
 * off mid-string, and the script the user had just saved came back opaque — "someone else's
 * script", read-only, with "adopt" as the only way on, which appended a second marker and made the
 * state permanent.
 *
 * `\u2028` is valid JSON escape syntax, so `JSON.parse` returns the original character and the
 * rule name round-trips unchanged. (U+0085 NEL is not affected: JS regexes do not treat it as a
 * line terminator.)
 */
function escapeLineSeparators(json: string): string {
  return json.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}

export function buildScript(
  rules: readonly SieveRule[],
  foreign: ManagedScript,
  extensions?: readonly string[] | undefined,
): string {
  const generated = generateSieve(rules, extensions)
  const requires = [...new Set([...generated.requires, ...foreign.foreignRequires])].sort()

  const metadata = escapeLineSeparators(JSON.stringify({ version: SCHEMA_VERSION, rules }))
  const sections: string[] = []

  const requireLine = renderRequire(requires)
  if (requireLine !== '') sections.push(requireLine)

  if (foreign.preamble !== '') sections.push(`${FOREIGN_HEADER}\n${foreign.preamble}`)

  // `JSON.stringify` escapes CR and LF inside strings, so a rule name containing a newline cannot
  // terminate the comment early — the metadata always occupies exactly one line. It does NOT
  // escape U+2028/U+2029, which is correct JSON and was still a defect here: see
  // `escapeLineSeparators`.
  sections.push(`${markerFor(SCHEMA_VERSION)}${metadata}`)
  if (generated.body !== '') sections.push(generated.body)
  sections.push(MARKER_END)

  if (foreign.trailer !== '') sections.push(`${FOREIGN_HEADER}\n${foreign.trailer}`)

  return `${sections.join('\n\n')}\n`
}

/** Whether `source` carries a managed region at all — of any version this build can read. */
export function hasManagedRegion(source: string): boolean {
  for (const match of source.matchAll(MARKER_BEGIN)) {
    if (READABLE_VERSIONS.has(Number(match[1]))) return true
  }
  return false
}

/**
 * Turns a foreign script into an editable state that keeps it.
 *
 * {@link parseScript} reports a script it did not write as opaque, because the safe default for
 * something we do not understand is to leave it alone. Adopting is the user's explicit decision to
 * start adding rules to a mailbox that already had filters: their script becomes the preserved
 * foreign section, its `require` line is hoisted so ours can be merged with it, and the rule set
 * starts empty. Nothing of theirs is interpreted, and nothing is dropped.
 */
export function adoptForeign(source: string): ManagedScript {
  const { requires, rest } = splitRequires(source)
  return {
    rules: [],
    preamble: stripForeignHeader(rest).trim(),
    trailer: '',
    foreignRequires: requires,
    opaque: false,
  }
}
