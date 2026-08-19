/**
 * The filter-rule model behind Settings → Filters (M5.2, FR-SIEVE-01).
 *
 * A rule is a small, closed shape — conditions and actions we know how to render — that
 * {@link generateSieve} compiles to Sieve. It is deliberately NOT a general Sieve AST: the
 * builder can express a subset of the language, and everything outside that subset stays
 * untouched text (see `script-io.ts`).
 *
 * Two decisions worth stating, because they are the ones a later change is likely to undo:
 *
 * - **Mailboxes are addressed by id first, name second.** `fileinto :mailboxid "<id>" "<name>"`
 *   survives a rename — which a name-only `fileinto` does not — while leaving a readable
 *   fallback for a server that lost the id. RFC 9042 §4.
 * - **The rule set is stored as JSON in a comment, and never recovered by re-parsing the
 *   generated Sieve.** Round-tripping through a language whose semantics are richer than the
 *   builder's is how a rule editor silently changes what a rule does.
 */

/** How a text condition compares. */
export type SieveMatch = 'contains' | 'is' | 'startsWith' | 'endsWith' | 'matches'

/** Which part of the message a text condition reads. */
export type SieveTextField = 'from' | 'to' | 'cc' | 'subject' | 'body'

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

/** What a rule does when it matches. */
export type SieveAction =
  | { readonly kind: 'fileInto'; readonly mailboxId: string; readonly mailboxName: string }
  | { readonly kind: 'addFlag'; readonly flag: '\\Flagged' | '\\Seen' }
  | { readonly kind: 'redirect'; readonly address: string }
  | { readonly kind: 'discard' }

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
const REQUIRES: Readonly<Record<string, string>> = {
  fileInto: 'fileinto',
  mailboxId: 'mailboxid',
  addFlag: 'imap4flags',
  body: 'body',
  matches: 'variables',
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

/** Compiles one condition to a Sieve test, collecting the extensions it needs. */
function conditionToTest(condition: SieveCondition, required: Set<string>): string {
  switch (condition.kind) {
    case 'text': {
      if (condition.field === 'body') {
        required.add(REQUIRES.body as string)
        if (
          condition.match === 'matches' ||
          condition.match === 'startsWith' ||
          condition.match === 'endsWith'
        ) {
          required.add(REQUIRES.matches as string)
        }
        return `body :text ${matchOperator(condition.match)} ${quoteSieveString(matchValue(condition))}`
      }
      const header =
        condition.field === 'from'
          ? 'From'
          : condition.field === 'to'
            ? 'To'
            : condition.field === 'cc'
              ? 'Cc'
              : 'Subject'
      return `header ${matchOperator(condition.match)} ${quoteSieveString(header)} ${quoteSieveString(matchValue(condition))}`
    }
    case 'size':
      return `size :${condition.operator} ${String(Math.max(0, Math.floor(condition.bytes)))}`
    case 'hasAttachment':
      // No `hasAttachment` test exists in Sieve; a multipart Content-Type is the closest
      // approximation a server can evaluate without parsing the body.
      return `header :contains "Content-Type" "multipart/mixed"`
  }
}

/** Compiles one action, collecting the extensions it needs. */
function actionToCommand(action: SieveAction, required: Set<string>): string {
  switch (action.kind) {
    case 'fileInto':
      required.add(REQUIRES.fileInto as string)
      required.add(REQUIRES.mailboxId as string)
      // Id first so a renamed mailbox still receives the mail; the name is the fallback.
      return `fileinto :mailboxid ${quoteSieveString(action.mailboxId)} ${quoteSieveString(action.mailboxName)};`
    case 'addFlag':
      required.add(REQUIRES.addFlag as string)
      return `addflag ${quoteSieveString(action.flag)};`
    case 'redirect':
      return `redirect ${quoteSieveString(action.address)};`
    case 'discard':
      return `discard;`
  }
}

/** The Sieve for one rule, or `''` when it is disabled or has no actions. */
function ruleToSieve(rule: SieveRule, required: Set<string>): string {
  if (!rule.enabled || rule.actions.length === 0) return ''

  const commands = rule.actions.map((action) => actionToCommand(action, required))
  if (rule.stop) commands.push('stop;')
  const body = commands.map((line) => `    ${line}`).join('\n')

  if (rule.conditions.length === 0) {
    // No conditions means "every message" — `if true` keeps the shape uniform and stays readable.
    return `# ${sanitizeComment(rule.name)}\nif true {\n${body}\n}`
  }

  const tests = rule.conditions.map((condition) => conditionToTest(condition, required))
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

/** Compiles a rule set to Sieve. The `require` line is the caller's job (foreign rules add their own). */
export function generateSieve(rules: readonly SieveRule[]): GeneratedSieve {
  const required = new Set<string>()
  const blocks = rules.map((rule) => ruleToSieve(rule, required)).filter((block) => block !== '')
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
