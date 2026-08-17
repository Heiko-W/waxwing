import type { Invocation, MethodErrorObject, ProblemDetails, SetError } from './types/core'
import type { WsRequestError } from './types/push'

/**
 * Error hierarchy for the three JMAP failure layers (RFC 8620 §3.6):
 *
 *  - {@link JmapProblemError} / {@link JmapHttpError} — request-level (HTTP error body).
 *  - {@link JmapMethodError} — method-level (an `["error", …]` response invocation).
 *  - {@link SetError} — per-record failure inside a `/set` response (a value, not thrown).
 */

/** Base class for all errors thrown by `@waxwing/jmap`. */
export class JmapError extends Error {
  override name = 'JmapError'
}

/**
 * A non-JMAP HTTP failure (401 auth, 404 wrong URL, 5xx, …) where the body is not an
 * RFC 7807 problem document.
 */
export class JmapHttpError extends JmapError {
  override name = 'JmapHttpError'
  constructor(
    /** HTTP status code. */
    readonly status: number,
    /** Raw response body (text), if any. */
    readonly body: string,
    message?: string,
    /**
     * Parsed `Retry-After` in milliseconds, or `undefined` if absent. A 429/503 whose body is NOT a
     * problem document surfaces here rather than as a {@link JmapProblemError}, so the retry hint
     * must be carried on both (M3.3 outbox backoff).
     */
    readonly retryAfterMs?: number | undefined,
  ) {
    super(message ?? `HTTP ${status}`)
  }
}

/**
 * A request-level JMAP error (RFC 8620 §3.6.1): HTTP 400 with
 * `Content-Type: application/problem+json`. `type` is a URN such as
 * `urn:ietf:params:jmap:error:limit`.
 */
export class JmapProblemError extends JmapError {
  override name = 'JmapProblemError'
  readonly type: string
  readonly status: number | undefined
  readonly detail: string | undefined
  readonly limit: string | undefined
  readonly problem: ProblemDetails
  /** Parsed `Retry-After` in milliseconds (e.g. on a 429 rate-limit), or `undefined` if absent. */
  readonly retryAfterMs: number | undefined
  constructor(problem: ProblemDetails, httpStatus?: number, retryAfterMs?: number) {
    super(problem.detail ?? problem.type)
    this.type = problem.type
    this.status = problem.status ?? httpStatus
    this.detail = problem.detail
    this.limit = problem.limit
    this.problem = problem
    this.retryAfterMs = retryAfterMs
  }
}

/**
 * A method-level error (RFC 8620 §3.6.2): an `["error", { type, description }, callId]`
 * invocation. HTTP stays 200 and later method calls still run, so this is thrown only
 * when a caller unwraps a specific call's result.
 */
export class JmapMethodError extends JmapError {
  override name = 'JmapMethodError'
  readonly type: string
  readonly description: string | undefined
  constructor(
    error: MethodErrorObject,
    /** `methodCallId` this error was returned for. */
    readonly callId: string,
    /** The invoked method name, when known. */
    readonly methodName?: string,
  ) {
    super(error.description ?? error.type)
    this.type = error.type
    this.description = error.description
  }
}

/**
 * A WebSocket request-level error (RFC 8887 §4.2): a `{ "@type": "RequestError", … }` frame
 * answering a malformed/rejected `Request`. The body is shaped like an RFC 8620 §3.6.1
 * problem document (the HTTP transport surfaces the same failure as {@link JmapProblemError}),
 * plus the `requestId` correlating it to the offending call.
 */
export class JmapRequestError extends JmapError {
  override name = 'JmapRequestError'
  readonly type: string
  readonly status: number | undefined
  readonly detail: string | undefined
  readonly requestId: string | undefined
  readonly problem: WsRequestError
  constructor(problem: WsRequestError) {
    super(problem.detail ?? problem.type)
    this.type = problem.type
    this.status = problem.status
    this.detail = problem.detail
    this.requestId = problem.requestId
    this.problem = problem
  }
}

/**
 * A Session that points one of its four `*Url` fields at a foreign origin (S7).
 *
 * Every consumer attaches the `Authorization` header to those URLs unconditionally, so a session
 * document naming another host would hand the credential to that host on the next request. The
 * session is rejected whole rather than partially used: the fields are not independent (a client
 * that kept `apiUrl` and dropped `downloadUrl` would still be a broken client), and there is no
 * legitimate case for it against Stalwart.
 */
export class JmapSessionOriginError extends JmapError {
  override name = 'JmapSessionOriginError'
  constructor(
    /** Which session field carried the foreign URL (`apiUrl`, `downloadUrl`, …). */
    readonly field: string,
    /** The offending (already resolved) URL. */
    readonly url: string,
    /** The origin the credential was sent to, and the only one it may be sent to. */
    readonly expectedOrigin: string,
  ) {
    super(
      `Session field ${field} points at "${url}", which is not on the connected origin ${expectedOrigin}; refusing to send credentials there.`,
    )
  }
}

/** Standard request-level problem URNs (RFC 8620 §3.6.1). */
export const ProblemTypes = {
  unknownCapability: 'urn:ietf:params:jmap:error:unknownCapability',
  notJSON: 'urn:ietf:params:jmap:error:notJSON',
  notRequest: 'urn:ietf:params:jmap:error:notRequest',
  limit: 'urn:ietf:params:jmap:error:limit',
} as const

/**
 * Standard method-level error `type` strings (RFC 8620 §3.6.2 + the per-method additions in
 * §5). Unknown types MUST be treated as `serverFail`, so match against these but never switch
 * exhaustively. Notably `cannotCalculateChanges` is what `Foo/changes` and `Foo/queryChanges`
 * raise when a delta cannot be produced — the client must discard its cache and full-resync.
 */
export const MethodErrorTypes = {
  serverUnavailable: 'serverUnavailable',
  serverFail: 'serverFail',
  serverPartialFail: 'serverPartialFail',
  unknownMethod: 'unknownMethod',
  invalidArguments: 'invalidArguments',
  invalidResultReference: 'invalidResultReference',
  forbidden: 'forbidden',
  accountNotFound: 'accountNotFound',
  accountNotSupportedByMethod: 'accountNotSupportedByMethod',
  accountReadOnly: 'accountReadOnly',
  requestTooLarge: 'requestTooLarge',
  cannotCalculateChanges: 'cannotCalculateChanges',
  stateMismatch: 'stateMismatch',
  unsupportedFilter: 'unsupportedFilter',
  unsupportedSort: 'unsupportedSort',
  anchorNotFound: 'anchorNotFound',
  tooManyChanges: 'tooManyChanges',
} as const

/** `true` if a thrown {@link JmapMethodError} (or any `{ type }`) has the given method-error type. */
export function isMethodErrorType(error: { type: string }, type: string): boolean {
  return error.type === type
}

/** `true` if an invocation is a method-level error response (`["error", …]`). */
export function isMethodError(invocation: Invocation): invocation is Invocation<MethodErrorObject> {
  return invocation[0] === 'error'
}

/** Narrows an unknown value to an RFC 7807 problem document (has a string `type`). */
function isProblemDetails(value: unknown): value is ProblemDetails {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
  )
}

/**
 * Parses an HTTP `Retry-After` header (RFC 9110 §10.2.3 — delta-seconds OR an HTTP-date) to
 * milliseconds from now. Returns `undefined` for an absent/unparseable value.
 */
export function parseRetryAfter(header: string | null): number | undefined {
  if (header === null) return undefined
  const trimmed = header.trim()
  if (trimmed === '') return undefined
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000
  const when = Date.parse(trimmed)
  if (Number.isNaN(when)) return undefined
  return Math.max(0, when - Date.now())
}

/**
 * Maps a failed `fetch` Response to the appropriate error. An
 * `application/problem+json` body becomes a {@link JmapProblemError}; anything else a
 * {@link JmapHttpError}. Never throws on a malformed body.
 */
export async function errorFromResponse(response: Response): Promise<JmapError> {
  const contentType = response.headers.get('content-type') ?? ''
  const text = await response.text().catch(() => '')
  if (
    contentType.includes('application/problem+json') ||
    contentType.includes('application/json')
  ) {
    try {
      const parsed: unknown = JSON.parse(text)
      if (isProblemDetails(parsed)) {
        return new JmapProblemError(
          parsed,
          response.status,
          parseRetryAfter(response.headers.get('Retry-After')),
        )
      }
    } catch {
      // fall through to a plain HTTP error
    }
  }
  return new JmapHttpError(
    response.status,
    text,
    `HTTP ${response.status} ${response.statusText}`.trim(),
    parseRetryAfter(response.headers.get('Retry-After')),
  )
}

/** `true` if a {@link SetError} represents the given standard type. */
export function isSetErrorType(error: SetError, type: string): boolean {
  return error.type === type
}
