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
 *
 * Boolean shape (M-3). Two additions, both invisible to anyone who does not type them:
 *  - a leading `-` NEGATES the token it is glued to (`-from:ads@x`, `-invoice`) → `{operator:'NOT'}`;
 *  - a bare, UPPERCASE `OR` (or `|`) between two tokens ORs them → `{operator:'OR'}`.
 * `OR` binds tighter than the implicit AND, as in Gmail: `a OR b c` is `(a OR b) AND c`. Uppercase
 * only, deliberately — "or" is an ordinary English word and must stay free text. There are no
 * parentheses: one level of grouping is what a search box can express without becoming a language.
 *
 * Mailbox scope (B-2). `scopeMailboxId` ANDs one `{inMailbox}`; `excludeMailboxIds` ANDs one
 * `{inMailboxOtherThan}` (the "all mailboxes" search, which must not rake through Trash and Junk).
 * A POSITIVE explicit `in:` overrides both — the user named a folder, that is the answer.
 */

import type { EmailFilter, EmailFilterCondition, Id } from '@waxwing/jmap'

/** The operator keys we recognize; anything else is free text. */
export const OPERATOR_NAMES = [
  'from',
  'to',
  'cc',
  'bcc',
  'subject',
  'body',
  'has',
  'is',
  'thread',
  'in',
  'before',
  'after',
  'larger',
  'smaller',
] as const
export type OperatorName = (typeof OPERATOR_NAMES)[number]

const OPERATOR_SET = new Set<string>(OPERATOR_NAMES)

/** The two spellings of the OR connector. Uppercase `OR` only — lowercase "or" is a word. */
const OR_WORDS = new Set(['OR', '|'])

export type SearchToken =
  | { readonly type: 'text'; readonly value: string; readonly negated?: boolean }
  | {
      readonly type: 'op'
      readonly op: OperatorName
      readonly value: string
      readonly raw: string
      readonly negated?: boolean
    }
  /** The `OR` connector. Carries no condition of its own; it groups its two neighbours. */
  | { readonly type: 'or' }

export interface SearchContext {
  /** Localized/role folder name → mailboxId (the caller builds this from the live mailbox list). */
  resolveMailbox(name: string): Id | undefined
  /** Scope = "this folder": ANDed as `{inMailbox}` unless an explicit `in:` operator overrides it. */
  scopeMailboxId?: Id | undefined
  /**
   * Scope = "all mailboxes": ANDed as `{inMailboxOtherThan}` (B-2). Trash and Junk hold messages the
   * user has already ruled out; a search that offers the deleted draft beside the sent one is worse
   * than one that misses it. Same override rule as `scopeMailboxId`.
   */
  excludeMailboxIds?: readonly Id[] | undefined
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
    if (OR_WORDS.has(raw0)) {
      tokens.push({ type: 'or' })
      continue
    }
    // A leading `-` negates, but only when something follows it: a lone `-` is just text.
    const negated = raw0.length > 1 && raw0.startsWith('-')
    const body = negated ? raw0.slice(1) : raw0
    const match = /^([a-zA-Z]+):(.*)$/.exec(body)
    if (match) {
      const key = (match[1] ?? '').toLowerCase()
      if (OPERATOR_SET.has(key)) {
        tokens.push({
          type: 'op',
          op: key as OperatorName,
          value: unquote(match[2] ?? ''),
          // The raw INCLUDING any `-`, so a degraded operator falls back to what was typed.
          raw: raw0,
          ...(negated ? { negated: true } : {}),
        })
        continue
      }
    }
    tokens.push({ type: 'text', value: unquote(body), ...(negated ? { negated: true } : {}) })
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

/**
 * Drop the token at `index`, plus any `OR` connector it would leave dangling.
 *
 * Removing a chip is the only way tokens are deleted, and an `OR` whose operand is gone would
 * re-parse as free text — the word "OR" appearing in the box out of nowhere. Trims a connector on
 * either side of the hole, and any that ends up leading or trailing.
 */
export function removeTokenAt(tokens: readonly SearchToken[], index: number): SearchToken[] {
  const kept = tokens.filter((_, i) => i !== index)
  const out: SearchToken[] = []
  for (const token of kept) {
    if (token.type === 'or' && (out.length === 0 || out[out.length - 1]?.type === 'or')) continue
    out.push(token)
  }
  while (out.length > 0 && out[out.length - 1]?.type === 'or') out.pop()
  return out
}

// ── Tokens → filter ─────────────────────────────────────────────────────────────────────────

/** AND-combine `tokens` into an `EmailFilter` (or `null` if it carries no constraint). */
export function tokensToFilter(tokens: SearchToken[], ctx: SearchContext): EmailFilter | null {
  /** AND-ed groups; each inner array is OR-ed together. */
  const groups: EmailFilter[][] = []
  const textParts: string[] = []
  let hasExplicitMailbox = false

  const isOr = (i: number): boolean => tokens[i]?.type === 'or'

  tokens.forEach((token, index) => {
    if (token.type === 'or') return // handled by its neighbours
    // A text token only becomes an operand of its own when the boolean shape demands it; otherwise
    // consecutive words keep collapsing into ONE `{text}`, which is what makes a phrase search work.
    const joinsOr = isOr(index - 1) && groups.length > 0
    let condition: EmailFilter | null = null

    if (token.type === 'text') {
      const standalone = token.negated === true || joinsOr || isOr(index + 1)
      if (token.value === '') return
      if (!standalone) {
        textParts.push(token.value)
        return
      }
      condition = { text: token.value }
    } else {
      const mapped = operatorCondition(token, ctx)
      if (mapped === null) {
        // Un-honorable operator (unknown value, unresolved folder, bad date) → keep the raw text.
        textParts.push(token.raw)
        return
      }
      // Only a POSITIVE `in:` says "the results come from here"; `-in:trash` narrows, it does not scope.
      if (mapped.inMailbox !== undefined && token.negated !== true) hasExplicitMailbox = true
      condition = mapped
    }

    if (token.negated === true)
      condition = { operator: 'NOT', conditions: [condition] } as EmailFilter
    if (joinsOr) groups[groups.length - 1]?.push(condition)
    else groups.push([condition])
  })

  const conditions: EmailFilter[] = groups.map((group) =>
    group.length === 1
      ? (group[0] as EmailFilter)
      : ({ operator: 'OR', conditions: group } as EmailFilter),
  )

  const text = textParts.join(' ').trim()
  if (text !== '') conditions.push({ text })
  if (!hasExplicitMailbox) {
    if (ctx.scopeMailboxId !== undefined) conditions.push({ inMailbox: ctx.scopeMailboxId })
    else if (ctx.excludeMailboxIds !== undefined && ctx.excludeMailboxIds.length > 0)
      conditions.push({ inMailboxOtherThan: [...ctx.excludeMailboxIds] })
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
    case 'bcc':
      return value === '' ? null : { bcc: value }
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
    // Conversation-level state (M-4). The three thread conditions are the only way to ask about a
    // whole conversation; `is:unread` answers about ONE message, which in a threaded inbox is a
    // different question. `thread:unread` = nothing in it has been read yet.
    case 'thread': {
      const flag = value.toLowerCase()
      if (flag === 'unread') return { noneInThreadHaveKeyword: '$seen' }
      if (flag === 'read') return { allInThreadHaveKeyword: '$seen' }
      if (flag === 'flagged' || flag === 'starred') return { someInThreadHaveKeyword: '$flagged' }
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
    // `minSize` is ">=", `maxSize` is "<" (RFC 8621 §4.4.1) — so the pair is exact and never overlaps.
    case 'larger': {
      const bytes = parseSize(value)
      return bytes === null ? null : { minSize: bytes }
    }
    case 'smaller': {
      const bytes = parseSize(value)
      return bytes === null ? null : { maxSize: bytes }
    }
    default:
      return null
  }
}

const SIZE_UNITS: Record<string, number> = {
  '': 1,
  b: 1,
  k: 1024,
  kb: 1024,
  m: 1024 * 1024,
  mb: 1024 * 1024,
  g: 1024 * 1024 * 1024,
  gb: 1024 * 1024 * 1024,
}

/**
 * Parse `10M` / `500kb` / `1234` / `2,5M` → whole bytes, or `null` if unparseable.
 *
 * Binary multiples (1 M = 1 048 576), matching what the app's own `formatBytes` displays — a search
 * for `larger:10M` has to find the message the list calls "10.4 MB". A comma is accepted as the
 * decimal separator because half this app's users type on a German keyboard.
 */
function parseSize(value: string): number | null {
  const match = /^(\d+(?:[.,]\d+)?)\s*(b|kb?|mb?|gb?)?$/i.exec(value)
  if (!match) return null
  const amount = Number((match[1] ?? '').replace(',', '.'))
  const unit = SIZE_UNITS[(match[2] ?? '').toLowerCase()]
  if (!Number.isFinite(amount) || unit === undefined) return null
  return Math.round(amount * unit)
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
      if (token.type === 'or') return 'OR'
      const sign = token.negated === true ? '-' : ''
      if (token.type === 'text') return `${sign}${quoteIfNeeded(token.value)}`
      return `${sign}${token.op}:${quoteIfNeeded(token.value)}`
    })
    .join(' ')
    .trim()
}

function quoteIfNeeded(value: string): string {
  // A double-quote is a delimiter in this grammar, never content — dropping it keeps serialize →
  // tokenize stable (an embedded `"` would otherwise re-open a quote and split the value). A literal
  // quote is meaningless to full-text search, so this is lossless in practice.
  const clean = value.replace(/"/g, '')
  // Quote anything the tokenizer would read as syntax rather than as a word: whitespace, the OR
  // connector, and a leading `-` (which would come back as a negation the user never typed).
  return /\s/.test(clean) || OR_WORDS.has(clean) || clean.startsWith('-') ? `"${clean}"` : clean
}
