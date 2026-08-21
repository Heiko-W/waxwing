/**
 * The filter-rule model behind Settings → Filters (M5.2, FR-SIEVE-01).
 *
 * A rule is a small, closed shape — conditions and actions we know how to render — that
 * {@link generateSieve} compiles to Sieve. It is deliberately NOT a general Sieve AST: the
 * builder can express a subset of the language, and everything outside that subset stays
 * untouched text (see `script-io.ts`).
 *
 * Three decisions worth stating, because they are the ones a later change is likely to undo:
 *
 * - **Mailboxes are addressed by id first, name second.** `fileinto :mailboxid "<id>" "<name>"`
 *   survives a rename — which a name-only `fileinto` does not — while leaving a readable
 *   fallback for a server that lost the id. RFC 9042 §4.
 * - **The rule set is stored as JSON in a comment, and never recovered by re-parsing the
 *   generated Sieve.** Round-tripping through a language whose semantics are richer than the
 *   builder's is how a rule editor silently changes what a rule does.
 * - **The vocabulary offered is a function of what the server advertised, not a fixed set.**
 *   Stalwart lists ~50 extensions in `sieveExtensions`; a `require` for one it does not have may
 *   compile cleanly and then fail at delivery time (ADR-023). So {@link sieveFeatures} reads the
 *   advertised list, the form offers only what is in it, and {@link generateSieve} emits the
 *   better construct only when it was advertised. An account that advertised NO list gets the
 *   1.0 vocabulary — "unknown" is not "supported".
 */

/** How a text condition compares. */
export type SieveMatch = 'contains' | 'is' | 'startsWith' | 'endsWith' | 'matches'

/**
 * Which part of the message a text condition reads.
 *
 * `envelopeFrom`/`envelopeTo` are the SMTP envelope (RFC 5228 §5.4), not the header: the address
 * the sending server actually handed over, which a forger cannot choose as freely as a `From:`
 * line, and the address mail was actually delivered *to*, which is how an alias is told apart from
 * the `To:` it was expanded into.
 */
export type SieveTextField =
  | 'from'
  | 'to'
  | 'cc'
  | 'subject'
  | 'body'
  | 'envelopeFrom'
  | 'envelopeTo'

/** Which part of "now" a {@link SieveCondition} of kind `currentDate` reads (RFC 5260 §4). */
export type SieveDatePart = 'weekday' | 'hour'

/** A single test within a rule. */
export type SieveCondition =
  | {
      readonly kind: 'text'
      readonly field: SieveTextField
      readonly match: SieveMatch
      readonly value: string
    }
  | { readonly kind: 'size'; readonly operator: 'over' | 'under'; readonly bytes: number }
  | { readonly kind: 'hasAttachment' }
  /** The server's spam score, 0–10 (RFC 5235). */
  | { readonly kind: 'spam'; readonly operator: 'atLeast' | 'atMost'; readonly score: number }
  /** Delivery time: a weekday (0 = Sunday) or an hour of the day, in the server's zone. */
  | {
      readonly kind: 'currentDate'
      readonly part: SieveDatePart
      readonly operator: 'is' | 'atLeast' | 'atMost'
      readonly value: number
    }
  /** A message whose Message-ID has been seen before (RFC 7352). */
  | { readonly kind: 'duplicate' }

/** What a rule does when it matches. */
export type SieveAction =
  | { readonly kind: 'fileInto'; readonly mailboxId: string; readonly mailboxName: string }
  | { readonly kind: 'addFlag'; readonly flag: '\\Flagged' | '\\Seen' }
  | { readonly kind: 'redirect'; readonly address: string }
  | { readonly kind: 'discard' }
  /** Refuse delivery and tell the sender why (RFC 5429). */
  | { readonly kind: 'reject'; readonly reason: string }

export interface SieveRule {
  readonly id: string
  readonly name: string
  /** A disabled rule is kept in the script but compiled to nothing. */
  readonly enabled: boolean
  /** `all` = every condition must match (`allof`), `any` = at least one (`anyof`). */
  readonly match: 'all' | 'any'
  readonly conditions: readonly SieveCondition[]
  readonly actions: readonly SieveAction[]
  /** Stop processing further rules once this one has matched. */
  readonly stop: boolean
}

/** Sieve extensions this generator can emit, mapped to the constructs that need them. */
const REQUIRES = {
  fileInto: 'fileinto',
  mailboxId: 'mailboxid',
  addFlag: 'imap4flags',
  body: 'body',
  matches: 'variables',
  envelope: 'envelope',
  spamtest: 'spamtest',
  relational: 'relational',
  numeric: 'comparator-i;ascii-numeric',
  date: 'date',
  duplicate: 'duplicate',
  reject: 'reject',
  mime: 'mime',
} as const

/**
 * Which of the widened vocabulary this server will actually run.
 *
 * `undefined` — the account advertised no `sieveExtensions` at all — yields all `false`. That is
 * deliberately not the same as "assume the common case": a `require` a server does not implement
 * can compile and then drop mail at delivery time, and a rule the user cannot see failing is worse
 * than one the form never offered.
 */
export interface SieveFeatures {
  /** `envelope` — match the SMTP sender/recipient instead of the header. */
  readonly envelope: boolean
  /** `spamtest` + the numeric comparison it needs. */
  readonly spam: boolean
  /** `date` — a weekday test, which needs no comparator. */
  readonly currentDate: boolean
  /** `date` + `relational` + the numeric comparator — an hour range. */
  readonly hourRange: boolean
  /** `duplicate` — suppress a message seen before. */
  readonly duplicate: boolean
  /** `reject` — refuse with a reason instead of discarding silently. */
  readonly reject: boolean
  /** `mime` — test the MIME parts, rather than guessing from `Content-Type`. */
  readonly mimeAttachment: boolean
}

function has(extensions: readonly string[] | undefined, name: string): boolean {
  return extensions?.includes(name) ?? false
}

/** Reads {@link SieveFeatures} out of the account's advertised `sieveExtensions`. */
export function sieveFeatures(extensions: readonly string[] | undefined): SieveFeatures {
  const numeric = has(extensions, REQUIRES.relational) && has(extensions, REQUIRES.numeric)
  return {
    envelope: has(extensions, REQUIRES.envelope),
    spam: has(extensions, REQUIRES.spamtest) && numeric,
    currentDate: has(extensions, REQUIRES.date),
    hourRange: has(extensions, REQUIRES.date) && numeric,
    duplicate: has(extensions, REQUIRES.duplicate),
    reject: has(extensions, REQUIRES.reject),
    mimeAttachment: has(extensions, REQUIRES.mime),
  }
}

/**
 * Quotes a Sieve string literal (RFC 5228 §2.4.2).
 *
 * Only `\` and `"` are special inside a quoted string. A CR or LF is legal there but would make
 * the emitted script unreadable and, more to the point, is never what a user meant to type into a
 * subject filter — so both are dropped rather than escaped.
 */
export function quoteSieveString(value: string): string {
  const flattened = value.replace(/[\r\n]+/g, ' ')
  return `"${flattened.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** The `:comparator`-free match operator for a text test. */
function matchOperator(match: SieveMatch): string {
  switch (match) {
    case 'is':
      return ':is'
    case 'matches':
    case 'startsWith':
    case 'endsWith':
      return ':matches'
    default:
      return ':contains'
  }
}

/** The value a `:matches` test needs, with wildcards added for the prefix/suffix forms. */
function matchValue(condition: { match: SieveMatch; value: string }): string {
  switch (condition.match) {
    case 'startsWith':
      return `${escapeMatchWildcards(condition.value)}*`
    case 'endsWith':
      return `*${escapeMatchWildcards(condition.value)}`
    default:
      return condition.value
  }
}

/**
 * Escapes the `?` and `*` wildcards for a literal `:matches` operand.
 *
 * `startsWith`/`endsWith` are built by wrapping the user's text in `*`, which means any `*` the
 * user typed themselves would silently become a wildcard — "starts with 5*5" would match far more
 * than the user asked for.
 */
function escapeMatchWildcards(value: string): string {
  return value.replace(/[\\?*]/g, (c) => `\\${c}`)
}

/** The relational operator (RFC 5231 §4) behind an at-least / at-most comparison. */
function relationalOperator(operator: 'atLeast' | 'atMost'): string {
  return operator === 'atLeast' ? 'ge' : 'le'
}

/** A numeric comparison, which always drags `relational` and the numeric comparator in with it. */
function numericTest(
  head: string,
  operator: 'atLeast' | 'atMost',
  operand: string,
  required: Set<string>,
): string {
  required.add(REQUIRES.relational)
  required.add(REQUIRES.numeric)
  return `${head} :value ${quoteSieveString(relationalOperator(operator))} :comparator ${quoteSieveString(
    REQUIRES.numeric.replace('comparator-', ''),
  )} ${operand}`
}

/** The header a text field reads, for the fields that are headers. */
function headerName(field: SieveTextField): string {
  switch (field) {
    case 'from':
      return 'From'
    case 'to':
      return 'To'
    case 'cc':
      return 'Cc'
    default:
      return 'Subject'
  }
}

/** Compiles one condition to a Sieve test, collecting the extensions it needs. */
function conditionToTest(
  condition: SieveCondition,
  required: Set<string>,
  features: SieveFeatures,
): string {
  switch (condition.kind) {
    case 'text': {
      if (condition.field === 'body') {
        required.add(REQUIRES.body)
        if (
          condition.match === 'matches' ||
          condition.match === 'startsWith' ||
          condition.match === 'endsWith'
        ) {
          required.add(REQUIRES.matches)
        }
        return `body :text ${matchOperator(condition.match)} ${quoteSieveString(matchValue(condition))}`
      }
      if (condition.field === 'envelopeFrom' || condition.field === 'envelopeTo') {
        required.add(REQUIRES.envelope)
        // RFC 5228 §5.4: the envelope part is named in lower case, and only `from`/`to` are
        // required of an implementation.
        const part = condition.field === 'envelopeFrom' ? 'from' : 'to'
        return `envelope ${matchOperator(condition.match)} ${quoteSieveString(part)} ${quoteSieveString(matchValue(condition))}`
      }
      return `header ${matchOperator(condition.match)} ${quoteSieveString(headerName(condition.field))} ${quoteSieveString(matchValue(condition))}`
    }
    case 'size':
      return `size :${condition.operator} ${String(Math.max(0, Math.floor(condition.bytes)))}`
    case 'hasAttachment':
      if (features.mimeAttachment) {
        required.add(REQUIRES.mime)
        // RFC 5703 §4: `:mime :anychild` turns the header test into one that reads EVERY MIME
        // part. A part that says it is an attachment is one; an inline image — which the
        // `multipart/mixed` guess below matches by accident — is not.
        return `header :mime :anychild :contains "Content-Disposition" "attachment"`
      }
      // Without `mime` there is no attachment test in Sieve at all; a multipart Content-Type is
      // the closest approximation a server can evaluate without looking at the body.
      return `header :contains "Content-Type" "multipart/mixed"`
    case 'spam': {
      required.add(REQUIRES.spamtest)
      // RFC 5235 §2.1: the score is "0".."10", where "0" means the message was not tested at all.
      const score = String(Math.min(10, Math.max(0, Math.round(condition.score))))
      return numericTest('spamtest', condition.operator, quoteSieveString(score), required)
    }
    case 'currentDate': {
      required.add(REQUIRES.date)
      const part = quoteSieveString(condition.part)
      const value =
        condition.part === 'hour'
          ? String(Math.min(23, Math.max(0, Math.round(condition.value)))).padStart(2, '0')
          : String(Math.min(6, Math.max(0, Math.round(condition.value))))
      if (condition.operator === 'is') return `currentdate :is ${part} ${quoteSieveString(value)}`
      return numericTest(
        'currentdate',
        condition.operator,
        `${part} ${quoteSieveString(value)}`,
        required,
      )
    }
    case 'duplicate':
      required.add(REQUIRES.duplicate)
      // Bare `duplicate` keys on the Message-ID with the server's default expiry — the shape that
      // means "I have seen this message before", without inventing a tracking key of our own.
      return `duplicate`
  }
}

/** Compiles one action, collecting the extensions it needs. */
function actionToCommand(action: SieveAction, required: Set<string>): string {
  switch (action.kind) {
    case 'fileInto':
      required.add(REQUIRES.fileInto)
      required.add(REQUIRES.mailboxId)
      // Id first so a renamed mailbox still receives the mail; the name is the fallback.
      return `fileinto :mailboxid ${quoteSieveString(action.mailboxId)} ${quoteSieveString(action.mailboxName)};`
    case 'addFlag':
      required.add(REQUIRES.addFlag)
      return `addflag ${quoteSieveString(action.flag)};`
    case 'redirect':
      return `redirect ${quoteSieveString(action.address)};`
    case 'discard':
      return `discard;`
    case 'reject':
      required.add(REQUIRES.reject)
      return `reject ${quoteSieveString(action.reason)};`
  }
}

/** The Sieve for one rule, or `''` when it is disabled or has no actions. */
function ruleToSieve(rule: SieveRule, required: Set<string>, features: SieveFeatures): string {
  if (!rule.enabled || rule.actions.length === 0) return ''

  const commands = rule.actions.map((action) => actionToCommand(action, required))
  if (rule.stop) commands.push('stop;')
  const body = commands.map((line) => `    ${line}`).join('\n')

  if (rule.conditions.length === 0) {
    // No conditions means "every message" — `if true` keeps the shape uniform and stays readable.
    return `# ${sanitizeComment(rule.name)}\nif true {\n${body}\n}`
  }

  const tests = rule.conditions.map((condition) => conditionToTest(condition, required, features))
  const test =
    tests.length === 1
      ? (tests[0] as string)
      : `${rule.match === 'all' ? 'allof' : 'anyof'}(${tests.join(', ')})`
  return `# ${sanitizeComment(rule.name)}\nif ${test} {\n${body}\n}`
}

/**
 * Strips anything that would end a `#` comment early.
 *
 * The same class of bug as an unescaped `*​/` inside a block comment: a newline in a rule name
 * turns the rest of that name into Sieve source.
 */
export function sanitizeComment(text: string): string {
  return text.replace(/[\r\n]+/g, ' ')
}

export interface GeneratedSieve {
  /** The compiled rules, without a `require` line — the caller merges requires across sections. */
  readonly body: string
  /** Extension names this body needs in `require`. */
  readonly requires: readonly string[]
}

/**
 * Compiles a rule set to Sieve. The `require` line is the caller's job (foreign rules add their own).
 *
 * `extensions` is the account's advertised `sieveExtensions`. It only ever picks between two
 * spellings of the same rule (today: the attachment test) — never between rules — so a script
 * generated against a server that advertises less is smaller, not different.
 */
export function generateSieve(
  rules: readonly SieveRule[],
  extensions?: readonly string[] | undefined,
): GeneratedSieve {
  const features = sieveFeatures(extensions)
  const required = new Set<string>()
  const blocks = rules
    .map((rule) => ruleToSieve(rule, required, features))
    .filter((block) => block !== '')
  return { body: blocks.join('\n\n'), requires: [...required].sort() }
}

/** Renders a `require` line, or `''` when nothing is needed. */
export function renderRequire(requires: readonly string[]): string {
  if (requires.length === 0) return ''
  const list = requires.map((name) => quoteSieveString(name)).join(', ')
  return `require [${list}];`
}

/**
 * Which of `requires` this server did not advertise in `sieveExtensions`.
 *
 * Worth checking before a save: a server may compile a `require` for an extension it does not
 * have and only fail at delivery time, so a clean `SieveScript/validate` is not proof that the
 * script will run. An empty `supported` list means the server advertised nothing, which is not
 * the same as "supports nothing" — nothing is reported then.
 */
export function unsupportedRequires(
  requires: readonly string[],
  supported: readonly string[] | undefined,
): readonly string[] {
  if (supported === undefined || supported.length === 0) return []
  const have = new Set(supported)
  return requires.filter((name) => !have.has(name))
}

/**
 * `items` with the entry at `from` moved to `to`.
 *
 * Order is the semantics of a Sieve script — a rule with `stop` ends processing and everything
 * below it never runs — so this is the operation behind both the drag and the keyboard reorder,
 * kept pure and out of the component that renders them.
 */
export function moveItem<T>(items: readonly T[], from: number, to: number): readonly T[] {
  if (from === to || from < 0 || from >= items.length) return items
  const target = Math.min(items.length - 1, Math.max(0, to))
  if (target === from) return items
  const next = [...items]
  const [moved] = next.splice(from, 1)
  if (moved === undefined) return items
  next.splice(target, 0, moved)
  return next
}

/**
 * The index a row dropped at `pointerY` should take, given the mid-height of every row.
 *
 * Split out because jsdom has no layout: every `getBoundingClientRect()` there is zero, so the
 * only way this arithmetic can be tested at all is with the geometry passed in.
 */
export function dropIndex(midpoints: readonly number[], pointerY: number): number {
  let index = 0
  for (const midpoint of midpoints) {
    if (pointerY > midpoint) index += 1
  }
  return Math.min(Math.max(index, 0), Math.max(midpoints.length - 1, 0))
}
