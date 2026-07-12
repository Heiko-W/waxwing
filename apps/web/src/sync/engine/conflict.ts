/**
 * Outbox failure classification (M3.3, FR-OFF-03: "conflicts surface as gentle, actionable notices
 * — never silent data loss"). A pure module: given a JMAP failure it says what the replay loop must
 * DO, and — crucially — what it must NOT do.
 *
 * The three rules that make "never silent loss" hold:
 *  1. A TRANSIENT failure (network, 5xx, 429, `serverFail`, `rateLimit`) is `retry` — the row is
 *     backed off and stays `pending`. It is never rolled back and never dead-lettered, however long
 *     the outage lasts. (Before M3.3, five offline/online flaps silently destroyed a queued action.)
 *  2. An error we cannot PROVE is permanent is treated as transient. Only an explicitly recognized
 *     permanent rejection may dead-letter a row.
 *  3. `notFound` on a DESTROY is `satisfied`, not a conflict: "already gone server-side" means the
 *     optimistic delete was RIGHT. Rolling it back would resurrect the message.
 *
 * Conflicts carry a stable {@link ConflictCode}, never prose — the UI owns the wording (i18n).
 */

import {
  JmapHttpError,
  JmapMethodError,
  JmapProblemError,
  JmapRequestError,
  MethodErrorTypes,
} from '@waxwing/jmap'
import type { ConflictCode } from '../db'
import {
  backoffDelayMs,
  clampRetryAfter,
  DEFAULT_OUTBOX_BACKOFF,
  type OutboxBackoff,
} from './backoff'
import type { OutboxIntent } from './outbox'
import type { PortSetError } from './types'

type IntentKind = OutboxIntent['kind']

/**
 * Per-object `SetError` types (RFC 8620 §5.3, RFC 8621 §4.6 Email / §7.5 EmailSubmission). These are
 * a DIFFERENT vocabulary from the method-level `MethodErrorTypes` in `@waxwing/jmap` — a `notFound`
 * SetError and a `serverFail` method error never appear in the same place — so they are declared
 * here rather than reused from there.
 */
export const SetErrorTypes = {
  notFound: 'notFound',
  invalidProperties: 'invalidProperties',
  invalidPatch: 'invalidPatch',
  forbidden: 'forbidden',
  accountReadOnly: 'accountReadOnly',
  overQuota: 'overQuota',
  tooLarge: 'tooLarge',
  rateLimit: 'rateLimit',
  serverFail: 'serverFail',
  serverPartialFail: 'serverPartialFail',
  mailboxHasChild: 'mailboxHasChild',
  mailboxHasEmail: 'mailboxHasEmail',
  singleton: 'singleton',
  willDestroy: 'willDestroy',
  // EmailSubmission (RFC 8621 §7.5).
  forbiddenFrom: 'forbiddenFrom',
  forbiddenMailFrom: 'forbiddenMailFrom',
  forbiddenToSend: 'forbiddenToSend',
  invalidEmail: 'invalidEmail',
  invalidRecipients: 'invalidRecipients',
  noRecipients: 'noRecipients',
  tooManyRecipients: 'tooManyRecipients',
} as const

/** What the replay loop must do about one failure. */
export type ReplayVerdict =
  /** Transient — back off and keep the row `pending`. NEVER undo, NEVER dead-letter. */
  | { readonly kind: 'retry'; readonly delayMs: number }
  /** `stateMismatch` on a guarded `Mailbox/set` — re-sync to a fresh state and re-execute (bounded). */
  | { readonly kind: 'refresh' }
  /** Already true server-side (a destroy of a gone object) — drop the row as a SUCCESS, no undo. */
  | { readonly kind: 'satisfied' }
  /** Permanent and user-facing — undo the failed objects, dead-letter, raise a gentle notice. */
  | { readonly kind: 'conflict'; readonly code: ConflictCode; readonly detail: string | null }

function conflict(code: ConflictCode, detail: string | null): ReplayVerdict {
  return { kind: 'conflict', code, detail }
}

/** A DESTROY intent — for these, `notFound` means the goal is already met (never a rollback). */
function isDestroy(kind: IntentKind): boolean {
  return kind === 'destroyEmails' || kind === 'discardDraft' || kind === 'deleteMailbox'
}

function isMailboxIntent(kind: IntentKind): boolean {
  return kind === 'renameMailbox' || kind === 'moveMailbox' || kind === 'deleteMailbox'
}

/**
 * Classify ONE rejected object of a `/set` (RFC 8620 §5.3 `SetError`). Called per failed id, so a
 * 500-id destroy where a single id is `notFound` no longer condemns the other 499 (defect D1).
 */
export function classifySetError(intentKind: IntentKind, error: PortSetError): ReplayVerdict {
  const detail = error.description ?? null
  // A rejected EmailSubmission is ALWAYS user-facing: the submission is not idempotent, so we never
  // auto-retry one (not even on `rateLimit`) — the draft is reopened and the user decides. The send
  // notifier owns the message; the conflict notifier deliberately skips these rows.
  if (intentKind === 'sendEmail') return conflict('sendRejected', detail)

  switch (error.type) {
    case SetErrorTypes.rateLimit:
    case SetErrorTypes.serverFail:
    case SetErrorTypes.serverPartialFail:
      // 0 = "no server-supplied hint" → the caller applies its backoff curve.
      return { kind: 'retry', delayMs: 0 }

    case SetErrorTypes.notFound:
      if (isDestroy(intentKind)) return { kind: 'satisfied' }
      if (isMailboxIntent(intentKind)) return conflict('folderGone', detail)
      return conflict('messageGone', detail)

    case SetErrorTypes.invalidProperties:
    case SetErrorTypes.invalidPatch:
      // A `move` patches `mailboxIds/<to>`; the server rejects that property when the target folder
      // no longer exists — the same user-visible situation as a `notFound` folder.
      return intentKind === 'move' ? conflict('folderGone', detail) : conflict('invalid', detail)

    case SetErrorTypes.forbidden:
    case SetErrorTypes.accountReadOnly:
      return conflict('forbidden', detail)

    case SetErrorTypes.overQuota:
      return conflict('quota', detail)

    case SetErrorTypes.tooLarge:
      return conflict('tooLarge', detail)

    case SetErrorTypes.mailboxHasChild:
    case SetErrorTypes.mailboxHasEmail:
      return conflict('folderNotEmpty', detail)

    default:
      return conflict('serverRejected', detail)
  }
}

/**
 * Classify a THROWN failure (transport, request-level or method-level). `attempts` is the 1-based
 * attempt number this failure belongs to and `jitter ∈ [0,1)` is injected, so the returned
 * `retry.delayMs` is fully deterministic in tests. A server-supplied `Retry-After` WINS over the
 * curve (clamped, so a hostile header cannot park the queue).
 *
 * Auth expiry (401/403) is NOT classified here — the caller checks {@link isAuthExpiry} first and
 * routes it to the re-auth funnel with the row untouched.
 */
export function classifyThrown(
  error: unknown,
  attempts: number,
  jitter: number,
  backoff: OutboxBackoff = DEFAULT_OUTBOX_BACKOFF,
): ReplayVerdict {
  const curve = (): number => backoffDelayMs(attempts, jitter, backoff)
  const hinted = (ms: number | undefined): ReplayVerdict => ({
    kind: 'retry',
    delayMs: ms === undefined ? curve() : clampRetryAfter(ms),
  })

  if (error instanceof JmapMethodError) {
    switch (error.type) {
      case MethodErrorTypes.stateMismatch:
        return { kind: 'refresh' }
      case MethodErrorTypes.serverUnavailable:
      case MethodErrorTypes.serverFail:
      case MethodErrorTypes.serverPartialFail:
        return { kind: 'retry', delayMs: curve() }
      case MethodErrorTypes.forbidden:
      case MethodErrorTypes.accountReadOnly:
        return conflict('forbidden', error.description ?? null)
      case MethodErrorTypes.invalidArguments:
      case MethodErrorTypes.invalidResultReference:
      case MethodErrorTypes.unknownMethod:
      case MethodErrorTypes.requestTooLarge:
        return conflict('invalid', error.description ?? null)
      default:
        // RFC 8620 §3.6.2 says to treat an unknown method error as `serverFail` (i.e. retry). We
        // surface it as an actionable conflict instead: the row is NOT discarded (its undo runs, a
        // notice appears, Retry is offered), which keeps the "never silent" guarantee without
        // spinning forever against a server that will reject it every time.
        return conflict('serverRejected', error.description ?? null)
    }
  }

  // TRANSPORT-LEVEL failures (HTTP status / RFC 7807 problem body). These say NOTHING about the
  // validity of an individual action: a 404 from a moved endpoint, a 413 on the request envelope, a
  // 400 from a reverse proxy — none of them prove that THIS move or THIS flag is permanently bad.
  // Only a per-object `SetError` or a method-level error can prove that. Treating them as conflicts
  // would dead-letter and roll back the ENTIRE queue on one misconfigured hop; a stuck queue is
  // recoverable, a destroyed one is not. (401/403 never reach here — `isAuthExpiry` intercepts them
  // upstream and routes to the re-auth funnel.)
  if (error instanceof JmapProblemError) return hinted(error.retryAfterMs)
  if (error instanceof JmapHttpError) return hinted(error.retryAfterMs)
  if (error instanceof JmapRequestError) return { kind: 'retry', delayMs: curve() }

  // A network failure (`TypeError: Failed to fetch`) — or anything we do not recognize. TRANSIENT by
  // default: an action must never be destroyed on the strength of an error we cannot prove is
  // permanent. It stays queued (and is reported as "stuck") until it succeeds or the user acts.
  return { kind: 'retry', delayMs: curve() }
}

/**
 * The HTTP status behind a thrown JMAP error — whichever class carries it. `JmapProblemError` and
 * `JmapRequestError` are NOT subclasses of `JmapHttpError`, so a status check MUST span all three:
 * a server (or gateway) that answers an expired token with a JSON body yields a `JmapProblemError`,
 * which would otherwise slip past the auth funnel and be misread as a per-action failure.
 */
function httpStatusOf(error: unknown): number | undefined {
  if (error instanceof JmapHttpError) return error.status
  if (error instanceof JmapProblemError) return error.status
  if (error instanceof JmapRequestError) return error.status
  return undefined
}

/** A background 401/403 — the session expired: route to re-auth (FR-AUTH-06), do not fail the row. */
export function isAuthExpiry(error: unknown): boolean {
  const status = httpStatusOf(error)
  return status === 401 || status === 403
}

/** The raw JMAP error `type` behind a thrown failure, for `OutboxConflict.errorType`. */
export function thrownErrorType(error: unknown): string | null {
  if (error instanceof JmapMethodError) return error.type
  if (error instanceof JmapProblemError) return error.type
  if (error instanceof JmapHttpError) return `http:${error.status}`
  return null
}
