/**
 * `Authentication-Results` parsing (RFC 8601) for the header-details disclosure (M3.9, FR-RD-06).
 * Pure: no React, no i18n — it turns one header value into `{ method, result }` pairs and nothing more.
 *
 * ## Why this reports rather than judges
 *
 * **The header is forgeable.** RFC 8601 §7.1 is explicit: it "is not a security mechanism" and a
 * message arrives with whatever `Authentication-Results` its author chose to write. A verifier is
 * expected to (a) delete foreign reports and (b) trust only those bearing its OWN `authserv-id` — and
 * we can do neither: JMAP exposes no way to learn the server's trusted authserv-id (there is no such
 * property in RFC 8620's session or RFC 8621's account capabilities), so we cannot tell our server's
 * report apart from a forged one that names it.
 *
 * **`[0]` is nevertheless the only candidate worth showing.** The receiving MTA PREPENDS its report
 * (RFC 8601 §5), so the topmost value is our server's — whenever our server wrote one at all. That is
 * also why {@link topmostAuthResults} must never fall through to `[1]` when `[0]` fails to parse:
 * every step down the list is a step closer to the sender.
 *
 * **Hence: report, never verdict.** The UI renders these pairs as plain text, always named with the
 * authserv-id they are quoting and always alongside a note that the report cannot be verified — no
 * verdict, no colour, no tick. A green check next to a forged `dmarc=pass` is worse than showing
 * nothing at all.
 *
 * (NB the fetch is `header:Authentication-Results:asText:all`, not `:asText` — see
 * `sync/engine/types.ts`. RFC 8621 §4.1.3: the singular form is "the value of the last instance of
 * the header field", i.e. the attacker's.)
 */

/** One `method=result` pair from a report (RFC 8601 §2.2 `resinfo`). */
export interface AuthResult {
  readonly method: string
  readonly result: string
}

/** One `Authentication-Results` header: who reported, and what they claim. */
export interface AuthResultsReport {
  readonly authservId: string
  readonly results: AuthResult[]
}

/** RFC 5321 `Keyword` — the shape both `method` and `result` must have. Anything else is garbage. */
const KEYWORD = /^[A-Za-z][A-Za-z0-9-]*$/

/**
 * RFC 2045 `token` = any ASCII CHAR except SPACE, CTLs and tspecials
 * (`( ) < > @ , ; : \ " / [ ] ?  =`). RFC 8601 defines `authserv-id = value = token / quoted-string`.
 *
 * **This is a security check, not tidiness.** The authserv-id is attacker text on any message whose
 * path prepended no report of its own, and it is rendered as "Reported by {id}". Excluding `=` and
 * `:` is what stops it from being *shaped into a verdict*: without this,
 * `Authentication-Results: mx.example.test:dkim=pass·dmarc=pass; dkim=fail` renders as
 * "Reported by mx.example.test:dkim=pass·dmarc=pass: dkim=fail" — the reader's own MTA name followed
 * by passes. `method`/`result` were always keyword-guarded; the host field was not.
 */
const TOKEN = /^[!#$%&'*+\-.0-9A-Z^_`a-z{|}~]+$/

/** Longest authserv-id kept. A hostname is ≤ 255 octets; anything longer is not one. */
const MAX_AUTHSERV_ID = 255

/**
 * The head segment is `authserv-id [ CFWS version ]`. Returns the id, or `null` if it is not a
 * well-formed `value` — in which case the whole report is dropped rather than shown with a
 * suspicious host (fail closed).
 */
function parseAuthservId(head: string): string | null {
  const trimmed = head.trim()
  if (trimmed === '') return null
  // A quoted-string id is legal but vanishingly rare. Unquote it and hold it to the SAME bar:
  // `"mx.test"` → `mx.test` (fine), `"mx.test: dkim=pass"` → rejected (it is not a token).
  const first =
    trimmed.startsWith('"') && trimmed.length > 1
      ? unquote(trimmed)
      : (trimmed.split(/\s+/)[0] ?? '')
  if (first === null || first.length === 0 || first.length > MAX_AUTHSERV_ID) return null
  return TOKEN.test(first) ? first : null
}

/** Read a leading quoted-string and return its unescaped content, or `null` if it is unterminated. */
function unquote(value: string): string | null {
  let out = ''
  for (let index = 1; index < value.length; index++) {
    const char = value[index] ?? ''
    if (char === '\\') {
      out += value[index + 1] ?? ''
      index++
    } else if (char === '"') {
      return out
    } else {
      out += char
    }
  }
  return null
}

/**
 * Parse ONE Authentication-Results value (RFC 8601 §2.2). `null` = unparsable, or a report with
 * nothing to show (a missing/ill-formed authserv-id, or the `none` no-result production).
 *
 * **Fail closed, deliberately.** If any delimiter is unbalanced the whole value is rejected rather
 * than parsed as far as it goes: `mx.test; dkim=pass header.d=x(oops; dmarc=fail; spf=fail` would
 * otherwise report a lone `dkim=pass` — swallowing precisely the two failures — and a partial report
 * shown as a complete one is worse than no report at all.
 */
export function parseAuthResults(value: string): AuthResultsReport | null {
  if (typeof value !== 'string') return null
  const stripped = stripComments(value)
  if (stripped === null) return null
  const segments = splitOnSemicolons(stripped)
  if (segments === null) return null
  const authservId = parseAuthservId(segments[0] ?? '')
  if (authservId === null) return null
  const results: AuthResult[] = []
  for (const segment of segments.slice(1)) {
    const result = parseResInfo(segment)
    if (result !== null) results.push(result)
  }
  if (results.length === 0) return null
  return { authservId, results }
}

/**
 * The topmost report from `Email/get`'s `:asText:all` array — see the module doc-comment.
 *
 * Only `all[0]` is ever considered: the receiving MTA prepends its report, so index 0 is the one our
 * server wrote (if any). An unparsable `[0]` yields `null` rather than falling through to `[1]`,
 * which would be a strictly less trustworthy report presented as if it were more.
 */
export function topmostAuthResults(all: readonly string[] | undefined): AuthResultsReport | null {
  const first = all?.[0]
  if (first === undefined) return null
  return parseAuthResults(first)
}

/**
 * One `resinfo`: `method[/version] = result [propspec …]`. The propspecs (`ptype.property=pvalue`)
 * are deliberately dropped — they are forensic detail, not something a reader can act on.
 */
function parseResInfo(segment: string): AuthResult | null {
  const trimmed = segment.trim()
  const equals = trimmed.indexOf('=')
  // No `=` at all: the RFC 8601 `no-result` production (`; none`), or noise. Either way, nothing.
  if (equals === -1) return null
  const method = (trimmed.slice(0, equals).split('/')[0] ?? '').trim()
  // The result is the first token after `=`; everything after it is a propspec.
  const result = (
    trimmed
      .slice(equals + 1)
      .trim()
      .split(/\s+/)[0] ?? ''
  ).trim()
  if (!KEYWORD.test(method) || !KEYWORD.test(result)) return null
  return { method, result }
}

/**
 * Remove RFC 5322 comments — `(…)`, nestable, with `\)` quoted-pairs — replacing each with a space so
 * it still separates tokens (`dkim (why not) = pass`). Parens inside a quoted-string are literal
 * text, not a comment; a quoted-string inside a comment is not (comments hold `ctext`, so `"` is
 * ordinary there) — hence the depth check runs first.
 *
 * Returns `null` when a delimiter is left open at EOF: everything after an unbalanced `(` would
 * otherwise be swallowed, silently shortening the report (see {@link parseAuthResults}).
 */
function stripComments(value: string): string | null {
  let out = ''
  let depth = 0
  let quoted = false
  for (let index = 0; index < value.length; index++) {
    const char = value[index] ?? ''
    if (depth > 0) {
      if (char === '\\') index++
      else if (char === '(') depth++
      else if (char === ')') depth--
      continue
    }
    if (quoted) {
      out += char
      if (char === '\\') {
        out += value[index + 1] ?? ''
        index++
      } else if (char === '"') {
        quoted = false
      }
      continue
    }
    if (char === '(') {
      depth++
      out += ' '
    } else if (char === '"') {
      quoted = true
      out += char
    } else {
      out += char
    }
  }
  return depth === 0 && !quoted ? out : null
}

/**
 * Split on `;` at the top level — a `;` inside a quoted-string (`reason="a; b"`) is data.
 * Returns `null` on an unterminated quote, for the same fail-closed reason as {@link stripComments}.
 */
function splitOnSemicolons(value: string): string[] | null {
  const out: string[] = []
  let current = ''
  let quoted = false
  for (let index = 0; index < value.length; index++) {
    const char = value[index] ?? ''
    if (quoted) {
      current += char
      if (char === '\\') {
        current += value[index + 1] ?? ''
        index++
      } else if (char === '"') {
        quoted = false
      }
      continue
    }
    if (char === '"') {
      quoted = true
      current += char
    } else if (char === ';') {
      out.push(current)
      current = ''
    } else {
      current += char
    }
  }
  if (quoted) return null
  out.push(current)
  return out
}
