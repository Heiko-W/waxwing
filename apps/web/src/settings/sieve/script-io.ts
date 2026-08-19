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

/** Opens the managed region; the rest of the line is the rule set as JSON. */
const MARKER_BEGIN = '# @waxwing:rules:v1 '
/** Closes the managed region. */
const MARKER_END = '# @waxwing:rules:end'
/** The schema version we know how to read. */
const SCHEMA_VERSION = 1

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
 * Reads a stored script into rules plus untouched foreign text.
 *
 * Never throws: an unreadable script comes back {@link ManagedScript.opaque}.
 */
export function parseScript(source: string): ManagedScript {
  if (source.trim() === '') return EMPTY_SCRIPT

  const begin = source.indexOf(MARKER_BEGIN)
  if (begin === -1) {
    // No managed region: the whole script belongs to someone else. Not an error — the common case
    // on first use against a mailbox that already had filters.
    return opaqueScript(source)
  }
  // A second opening marker means the file was edited into a shape we cannot reason about.
  if (source.indexOf(MARKER_BEGIN, begin + 1) !== -1) return opaqueScript(source)

  const lineEnd = source.indexOf('\n', begin)
  if (lineEnd === -1) return opaqueScript(source)
  const json = source.slice(begin + MARKER_BEGIN.length, lineEnd).trim()

  const endMarker = source.indexOf(MARKER_END, lineEnd)
  if (endMarker === -1) return opaqueScript(source)
  const endLine = source.indexOf('\n', endMarker)
  const afterEnd = endLine === -1 ? source.length : endLine + 1

  const rules = readRules(json)
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
function readRules(json: string): SieveRule[] | null {
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
  if (payload.version !== SCHEMA_VERSION) return null
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

const TEXT_FIELDS: readonly SieveTextField[] = ['from', 'to', 'cc', 'subject', 'body']
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
export function buildScript(rules: readonly SieveRule[], foreign: ManagedScript): string {
  const generated = generateSieve(rules)
  const requires = [...new Set([...generated.requires, ...foreign.foreignRequires])].sort()

  const metadata = JSON.stringify({ version: SCHEMA_VERSION, rules })
  const sections: string[] = []

  const requireLine = renderRequire(requires)
  if (requireLine !== '') sections.push(requireLine)

  if (foreign.preamble !== '') sections.push(`${FOREIGN_HEADER}\n${foreign.preamble}`)

  // `JSON.stringify` escapes CR and LF inside strings, so a rule name containing a newline cannot
  // terminate the comment early — the metadata always occupies exactly one line.
  sections.push(`${MARKER_BEGIN}${metadata}`)
  if (generated.body !== '') sections.push(generated.body)
  sections.push(MARKER_END)

  if (foreign.trailer !== '') sections.push(`${FOREIGN_HEADER}\n${foreign.trailer}`)

  return `${sections.join('\n\n')}\n`
}

/** Whether `source` carries a managed region at all. */
export function hasManagedRegion(source: string): boolean {
  return source.includes(MARKER_BEGIN)
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
