/**
 * Scheduled send (M5.4, FR-CMP-11) — server-side, via SMTP FUTURERELEASE over JMAP.
 *
 * The spec allowed for a client-side fallback where the browser has to be open at send time. It is
 * not needed: Stalwart implements RFC 4865, so the message sits in the server's queue with a due
 * time and goes out whether or not this app is running. That is the difference between a promise a
 * mail client can keep and one it cannot.
 *
 * **How the wish is expressed.** Not by setting `sendAt` — that property is server-set and
 * immutable (RFC 8621 §7.1), and a client that writes it is ignored at best. The request rides as
 * an SMTP parameter on the envelope sender:
 *
 *     envelope.mailFrom.parameters = { HOLDUNTIL: '2026-08-20T08:00:00Z' }
 *
 * **The cap is not what the server advertises.** Stalwart's session says `maxDelayedSend: 2592000`
 * (30 days) while the MTA enforces its `futureRelease` setting, which defaults to 7 days. A client
 * that trusts the advertised number hands the user a date the server then refuses. {@link
 * maxScheduleMs} therefore takes the smaller of the two, and the UI clamps to it.
 */

import type { Session } from '@waxwing/jmap'

/** The SMTP parameter name (RFC 4865 §3). Upper-case: servers are not required to fold it. */
export const HOLD_UNTIL_PARAM = 'HOLDUNTIL'

/** The capability field naming the server's own maximum delay, in seconds (RFC 8621 §1.3.2). */
const MAX_DELAYED_SEND = 'maxDelayedSend'

/**
 * What Stalwart's MTA actually enforces by default (7 days), regardless of the 30 it advertises.
 *
 * Not a guess: the discrepancy is in the server's own code, and a scheduled send beyond it fails
 * with `forbiddenMailFrom` at submission time. Capping here turns a confusing rejection into a
 * date picker that does not offer the impossible.
 */
export const CONSERVATIVE_MAX_MS = 7 * 24 * 60 * 60 * 1000

/** Whether this account can hold a message for later delivery at all. */
export function supportsScheduledSend(session: Session | null, accountId: string | null): boolean {
  return readSubmissionCapability(session, accountId) !== null
}

function readSubmissionCapability(
  session: Session | null,
  accountId: string | null,
): { maxDelayedSend?: unknown; submissionExtensions?: unknown } | null {
  if (session === null || accountId === null) return null
  const capability = session.accounts?.[accountId]?.accountCapabilities?.[
    'urn:ietf:params:jmap:submission'
  ] as { maxDelayedSend?: unknown; submissionExtensions?: unknown } | undefined
  if (capability === undefined) return null

  const extensions = capability.submissionExtensions
  // FUTURERELEASE must be advertised: without it the server has no way to hold anything, and the
  // parameter would come back as a rejected envelope rather than a scheduled message.
  const named =
    typeof extensions === 'object' &&
    extensions !== null &&
    Object.hasOwn(extensions as object, 'FUTURERELEASE')
  if (!named) return null

  const max = capability[MAX_DELAYED_SEND]
  return typeof max === 'number' && max > 0 ? capability : null
}

/**
 * How far ahead this account may schedule, in milliseconds.
 *
 * The smaller of what the server advertises and {@link CONSERVATIVE_MAX_MS}. Returns `0` when
 * scheduling is unavailable.
 */
export function maxScheduleMs(session: Session | null, accountId: string | null): number {
  const capability = readSubmissionCapability(session, accountId)
  if (capability === null) return 0
  const advertised = (capability[MAX_DELAYED_SEND] as number) * 1000
  return Math.min(advertised, CONSERVATIVE_MAX_MS)
}

/** Why a chosen time cannot be used. */
export type ScheduleProblem = 'past' | 'tooFar' | 'unsupported'

/**
 * Checks a requested send time against the account's limits.
 *
 * A time in the past is REFUSED rather than quietly turned into "now": the server refuses it too
 * (`HOLDUNTIL must be a date and time in the future`), and a client that silently sends immediately
 * would deliver a message the user believed they had deferred.
 */
export function checkScheduleTime(at: Date, now: number, maxMs: number): ScheduleProblem | null {
  if (maxMs <= 0) return 'unsupported'
  const delta = at.getTime() - now
  if (delta <= 0) return 'past'
  if (delta > maxMs) return 'tooFar'
  return null
}

/**
 * The envelope parameters expressing "hold until `at`".
 *
 * `HOLDUNTIL` takes an RFC 3339 date-time. Stalwart accepted a Unix timestamp until 0.16.16 and an
 * RFC 3339 string from 0.16.17 — the RFC has always said date-time, so that is what is sent, and
 * the practical consequence is a 0.16.17 floor for this feature.
 */
export function holdUntilParameters(at: Date): Record<string, string> {
  return { [HOLD_UNTIL_PARAM]: at.toISOString() }
}
