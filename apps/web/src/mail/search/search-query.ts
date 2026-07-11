/**
 * Search query parser (M3.1, FR-SRCH-02). Turns a raw search string into an `Email/query` filter,
 * mapping Gmail-style operators 1:1 to JMAP `EmailFilterCondition`s. Pure — no React/i18n/DOM — so
 * the "operator strings and the chip panel produce identical filters" guarantee is exhaustively
 * unit-tested. The `tokens` array is BOTH the parse result and the chip model (the UI derives chips
 * from it, so text and chips can never drift).
 *
 * Grammar: whitespace-separated tokens; a `"…"` run is one token (quotes stripped). A `key:value`
 * token with a KNOWN key becomes an operator (its value may itself be quoted). Everything else — and
 * any operator that cannot be honored (unknown key, unresolved `in:` folder, unparseable date) —
 * degrades to free text (one ANDed `{text}` condition), so a search is never silently broken.
 */

import type { EmailFilter, EmailFilterCondition, Id } from '@waxwing/jmap'

/** The operator keys we recognize; anything else is free text. */
export const OPERATOR_NAMES = [
  'from',
  'to',
  'cc',
  'subject',
  'body',
  'has',
  'is',
  'in',
  'before',
  'after',
] as const
export type OperatorName = (typeof OPERATOR_NAMES)[number]

const OPERATOR_SET = new Set<string>(OPERATOR_NAMES)

export type SearchToken =
  | { readonly type: 'text'; readonly value: string }
  | { readonly type: 'op'; readonly op: OperatorName; readonly value: string; readonly raw: string }

export interface SearchContext {
  /** Localized/role folder name → mailboxId (the caller builds this from the live mailbox list). */
  resolveMailbox(name: string): Id | undefined
  /** Scope = "this folder": ANDed as `{inMailbox}` unless an explicit `in:` operator overrides it. */
  scopeMailboxId?: Id | undefined
  /** Injected for deterministic date math (`today`/`yesterday`, `YYYY-MM-DD` → UTC bounds). */
  now: number
}

export interface ParsedSearch {
  readonly tokens: SearchToken[]
  /** The AND-combined filter, or `null` for an empty/whitespace query (⇒ show the folder, not results). */
  readonly filter: EmailFilter | null
  /** The joined free-text portion (what the operators did not consume). */
  readonly text: string
}

// ── Tokenize ────────────────────────────────────────────────────────────────────────────────

/** Split `raw` into tokens honoring double-quoted phrases; classify known `key:value` operators. */
export function tokenizeSearch(raw: string): SearchToken[] {
  const tokens: SearchToken[] = []
  for (const raw0 of splitRespectingQuotes(raw)) {
    const match = /^([a-zA-Z]+):(.*)$/.exec(raw0)
    if (match) {
      const key = (match[1] ?? '').toLowerCase()
      if (OPERATOR_SET.has(key)) {
        tokens.push({
          type: 'op',
          op: key as OperatorName,
          value: unquote(match[2] ?? ''),
          raw: raw0,
        })
        continue
      }
    }
    tokens.push({ type: 'text', value: unquote(raw0) })
  }
  return tokens
}

/** Whitespace-split, but keep `"…"` (and `key:"…"`) runs together. Discards empty tokens. */
function splitRespectingQuotes(raw: string): string[] {
  const out: string[] = []
  let current = ''
  let inQuotes = false
  for (const char of raw) {
    if (char === '"') {
      inQuotes = !inQuotes
      current += char
    } else if (/\s/.test(char) && !inQuotes) {
      if (current !== '') out.push(current)
      current = ''
    } else {
      current += char
    }
  }
  if (current !== '') out.push(current)
  return out
}

/** Strip a surrounding pair of double quotes (a value the tokenizer kept intact). */
function unquote(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value
}

// ── Tokens → filter ─────────────────────────────────────────────────────────────────────────

/** AND-combine `tokens` into an `EmailFilter` (or `null` if it carries no constraint). */
export function tokensToFilter(tokens: SearchToken[], ctx: SearchContext): EmailFilter | null {
  const conditions: EmailFilterCondition[] = []
  const textParts: string[] = []
  let hasExplicitMailbox = false

  for (const token of tokens) {
    if (token.type === 'text') {
      if (token.value !== '') textParts.push(token.value)
      continue
    }
    const condition = operatorCondition(token, ctx)
    if (condition === null) {
      // Un-honorable operator (unknown value, unresolved folder, bad date) → keep the raw text.
      textParts.push(token.raw)
      continue
    }
    if (condition.inMailbox !== undefined) hasExplicitMailbox = true
    conditions.push(condition)
  }

  const text = textParts.join(' ').trim()
  if (text !== '') conditions.push({ text })
  if (!hasExplicitMailbox && ctx.scopeMailboxId !== undefined) {
    conditions.push({ inMailbox: ctx.scopeMailboxId })
  }

  if (conditions.length === 0) return null
  if (conditions.length === 1) return conditions[0] as EmailFilter
  // `FilterOperator.conditions` is typed as the generic `FilterCondition` (an index signature); a
  // named `EmailFilterCondition` is a valid condition but nominally lacks that signature.
  return { operator: 'AND', conditions } as EmailFilter
}

/** Map one operator token to a condition, or `null` when it cannot be honored (⇒ degrade to text). */
export function operatorCondition(
  token: Extract<SearchToken, { type: 'op' }>,
  ctx: SearchContext,
): EmailFilterCondition | null {
  const value = token.value.trim()
  switch (token.op) {
    case 'from':
      return value === '' ? null : { from: value }
    case 'to':
      return value === '' ? null : { to: value }
    case 'cc':
      return value === '' ? null : { cc: value }
    case 'subject':
      return value === '' ? null : { subject: value }
    case 'body':
      return value === '' ? null : { body: value }
    case 'has':
      return /^attachments?$/i.test(value) ? { hasAttachment: true } : null
    case 'is': {
      const flag = value.toLowerCase()
      if (flag === 'unread') return { notKeyword: '$seen' }
      if (flag === 'read') return { hasKeyword: '$seen' }
      if (flag === 'flagged' || flag === 'starred') return { hasKeyword: '$flagged' }
      return null
    }
    case 'in': {
      const id = ctx.resolveMailbox(value)
      return id === undefined ? null : { inMailbox: id }
    }
    case 'before': {
      const iso = parseDate(value, ctx.now)
      return iso === null ? null : { before: iso }
    }
    case 'after': {
      const iso = parseDate(value, ctx.now)
      return iso === null ? null : { after: iso }
    }
    default:
      return null
  }
}

const DAY_MS = 86_400_000

/** Parse `YYYY-MM-DD` / `today` / `yesterday` → a UTC-midnight ISO string, or `null` if unparseable. */
function parseDate(value: string, now: number): string | null {
  const word = value.toLowerCase()
  if (word === 'today') return utcMidnight(now)
  if (word === 'yesterday') return utcMidnight(now - DAY_MS)
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const ms = Date.UTC(year, month - 1, day)
  if (Number.isNaN(ms)) return null
  const date = new Date(ms)
  // Reject calendar overflow — `Date.UTC` silently rolls `2026-02-30` → Mar 2, `…-00-00` → the prior
  // month, etc. Without this the chip would show the typed date while the filter used a rolled one,
  // breaking the documented "unparseable date → degrade to free text" contract. Require a round-trip.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null
  }
  return date.toISOString()
}

/** UTC midnight of the day containing `epochMs`, as an ISO string. */
function utcMidnight(epochMs: number): string {
  return new Date(Math.floor(epochMs / DAY_MS) * DAY_MS).toISOString()
}

// ── Public convenience + reverse ──────────────────────────────────────────────────────────────

export function parseSearchQuery(raw: string, ctx: SearchContext): ParsedSearch {
  const tokens = tokenizeSearch(raw)
  const filter = tokensToFilter(tokens, ctx)
  const text = tokens
    .filter((token): token is Extract<SearchToken, { type: 'text' }> => token.type === 'text')
    .map((token) => token.value)
    .join(' ')
    .trim()
  return { tokens, filter, text }
}

/** Tokens → a canonical raw string that round-trips with {@link tokenizeSearch} (used for the URL). */
export function serializeTokens(tokens: SearchToken[]): string {
  return tokens
    .map((token) => {
      if (token.type === 'text') return quoteIfNeeded(token.value)
      return `${token.op}:${quoteIfNeeded(token.value)}`
    })
    .join(' ')
    .trim()
}

function quoteIfNeeded(value: string): string {
  // A double-quote is a delimiter in this grammar, never content — dropping it keeps serialize →
  // tokenize stable (an embedded `"` would otherwise re-open a quote and split the value). A literal
  // quote is meaningless to full-text search, so this is lossless in practice.
  const clean = value.replace(/"/g, '')
  return /\s/.test(clean) ? `"${clean}"` : clean
}
