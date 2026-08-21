/**
 * Per-message send options (M-7 / M-11): priority, a delivery receipt, and TLS-only delivery.
 *
 * Three switches that ride on ONE send and are not worth a settings screen. They land in two
 * different places, and the split is the whole point of this module:
 *
 * - **Priority is a message header.** `X-Priority` / `Importance` are what the recipient's client
 *   reads and renders as the little exclamation mark. Nothing about it involves the envelope.
 * - **Receipt and TLS are envelope parameters.** They are instructions to the MTAs on the way, not
 *   content, so they never appear in the message and the recipient never sees them.
 *
 * **Why not MT-PRIORITY alone.** The session advertises `MT-PRIORITY: [MIXER]`, and it is tempting
 * to treat that as "the server can do priority". It cannot do the thing a user means: MT-PRIORITY
 * (RFC 6710) orders the MTA's own queue and is invisible to the recipient. So the headers are sent
 * unconditionally (they work against every server) and MT-PRIORITY is added *as well* where it is
 * advertised — it costs one parameter and it is what the local queue actually honours.
 *
 * Measured against the fixture (Stalwart v0.16.18, `:18080`) rather than read off the RFC:
 *
 * | sent | result |
 * |---|---|
 * | `NOTIFY: SUCCESS` / `FAILURE` / `DELAY` and any comma-set of them | accepted |
 * | `NOTIFY: SUCCESS,NEVER` | **rejected** — `Invalid parameter: NOTIFY` (RFC 3461 forbids the mix) |
 * | `ORCPT: rfc822;<addr>` | accepted; **without the `rfc822;` prefix: rejected** |
 * | `ORCPT` holding a raw space | rejected, and it takes the rest of the parameter list with it — hence {@link xtext} |
 * | `RET: HDRS` / `FULL` | accepted; anything else rejected |
 * | `REQUIRETLS: null` | accepted; `REQUIRETLS: ""` **rejected** (`Unsupported parameter: REQUIRETLS=`) |
 * | `MT-PRIORITY` | accepted for **-6 … 5** only; `-9`, `6`, `9` → `501 5.5.4 Invalid priority value` |
 *
 * The last row is why {@link MT_PRIORITY_HIGH}/{@link MT_PRIORITY_LOW} are ±4 and not the ±9 the
 * RFC's range would allow: a value the advertised profile permits and this server refuses would
 * fail the whole submission, not the priority.
 *
 * A receipt was verified to WORK end to end, not merely to be accepted: a submission carrying
 * `NOTIFY: SUCCESS,DELAY,FAILURE` produced a "Successfully delivered message" report from
 * `MAILER-DAEMON` in the sender's own inbox. It arrives as an ordinary message —
 * `EmailSubmission.dsnBlobIds` stayed `[]` — so nothing on the reading side has to change for it.
 */

import type { Session } from '@waxwing/jmap'

/** How the message announces itself to the recipient's client. */
export type MessagePriority = 'low' | 'normal' | 'high'

export interface SendOptions {
  readonly priority: MessagePriority
  /** Ask the delivering MTAs to report back (SMTP DSN, RFC 3461). */
  readonly deliveryReceipt: boolean
  /** Refuse delivery rather than take an unencrypted hop (SMTP REQUIRETLS, RFC 8689). */
  readonly requireTls: boolean
}

/** What every draft starts as — and what a draft written before this feature deserializes to. */
export const DEFAULT_SEND_OPTIONS: SendOptions = {
  priority: 'normal',
  deliveryReceipt: false,
  requireTls: false,
}

/** Whether anything here departs from the default (drives the "options set" dot on the trigger). */
export function hasSendOptions(options: SendOptions): boolean {
  return options.priority !== 'normal' || options.deliveryReceipt || options.requireTls
}

// ── What the account can actually do ────────────────────────────────────────────────────────────

/** Which submission extensions this account advertises (RFC 8621 §7.5 `submissionExtensions`). */
export interface SubmissionExtensions {
  /** RFC 3461 — delivery status notifications. */
  readonly dsn: boolean
  /** RFC 8689 — refuse an unencrypted hop. */
  readonly requireTls: boolean
  /** RFC 6710 — queue priority at the MTA. */
  readonly mtPriority: boolean
}

const NO_EXTENSIONS: SubmissionExtensions = { dsn: false, requireTls: false, mtPriority: false }

/**
 * Read the advertised extensions for `accountId`.
 *
 * Presence of the KEY is the signal, not its value: the fixture advertises `"DSN": []` and
 * `"MT-PRIORITY": ["MIXER"]`, and an empty array is an extension with no parameters, not an absent
 * one. `scheduled-send.ts` reads `FUTURERELEASE` the same way.
 */
export function readSubmissionExtensions(
  session: Session | null,
  accountId: string | null,
): SubmissionExtensions {
  if (session === null || accountId === null) return NO_EXTENSIONS
  const capability = session.accounts?.[accountId]?.accountCapabilities?.[
    'urn:ietf:params:jmap:submission'
  ] as { submissionExtensions?: unknown } | undefined
  const extensions = capability?.submissionExtensions
  if (typeof extensions !== 'object' || extensions === null) return NO_EXTENSIONS
  const has = (name: string): boolean => Object.hasOwn(extensions as object, name)
  return { dsn: has('DSN'), requireTls: has('REQUIRETLS'), mtPriority: has('MT-PRIORITY') }
}

// ── Priority → message headers ──────────────────────────────────────────────────────────────────

/**
 * The `Email/set create` properties expressing `priority`, or `{}` for normal.
 *
 * Two headers because no single one is universally read: Thunderbird and most webmail go by
 * `X-Priority`, Apple Mail and Outlook by `Importance`. Both are set from one choice so they can
 * never disagree — a message that says "1" in one header and "low" in the other is worse than one
 * that says nothing.
 *
 * The keys are literal `header:{name}:asText` create properties (RFC 8621 §4.1.3), verified
 * accepted and round-tripped by the fixture.
 */
export function priorityHeaders(priority: MessagePriority): Record<string, string> {
  switch (priority) {
    case 'high':
      return { 'header:X-Priority:asText': '1', 'header:Importance:asText': 'high' }
    case 'low':
      return { 'header:X-Priority:asText': '5', 'header:Importance:asText': 'low' }
    case 'normal':
      return {}
  }
}

// ── Options → envelope parameters ───────────────────────────────────────────────────────────────

/** What a receipt asks to be told about. `NEVER` is deliberately absent — RFC 3461 forbids mixing it. */
const NOTIFY_ALL = 'SUCCESS,DELAY,FAILURE'

/**
 * Return the message's HEADERS in a report, not the whole message.
 *
 * `FULL` would bounce every attachment back at the sender, which for the one case a receipt is
 * asked for — a large, important message — is the worst possible answer.
 */
const RET_HEADERS = 'HDRS'

/** Inside the -6…5 the fixture accepts, and far enough from 0 to mean something. */
const MT_PRIORITY_HIGH = '4'
const MT_PRIORITY_LOW = '-4'

/**
 * RFC 3461 §4 xtext: printable ASCII passes through, except `+` and `=`; everything else becomes
 * `+` and two upper-case hex digits, per UTF-8 BYTE.
 *
 * Not decoration. An ESMTP parameter list is space-separated, so an unencoded space inside `ORCPT`
 * ends the parameter and the remainder is read as a new one — measured, and the server's answer was
 * `Unsupported parameter: PROBE@WAXWING.TEST`, which names a fragment of the address and explains
 * nothing. Encoding here is what keeps an unusual address from breaking the parameters beside it.
 */
export function xtext(value: string): string {
  let out = ''
  for (const byte of new TextEncoder().encode(value)) {
    const printable = byte >= 0x21 && byte <= 0x7e
    if (printable && byte !== 0x2b && byte !== 0x3d) out += String.fromCharCode(byte)
    else out += `+${byte.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return out
}

/**
 * ESMTP parameters for `MAIL FROM`, or `null` when the options ask for nothing the account can do.
 *
 * `null` rather than `{}` on purpose: the envelope's `parameters` is omitted entirely in that case,
 * so a message sent with default options produces byte-for-byte the request it produced before this
 * feature existed.
 */
export function mailFromParameters(
  options: SendOptions,
  extensions: SubmissionExtensions,
): Record<string, string | null> | null {
  const parameters: Record<string, string | null> = {}
  if (options.deliveryReceipt && extensions.dsn) parameters.RET = RET_HEADERS
  // `null` is the VALUE, and it means a parameter with no value (`REQUIRETLS`). An empty string is
  // a different thing — `REQUIRETLS=` — and the server rejects it.
  if (options.requireTls && extensions.requireTls) parameters.REQUIRETLS = null
  if (options.priority !== 'normal' && extensions.mtPriority) {
    parameters['MT-PRIORITY'] = options.priority === 'high' ? MT_PRIORITY_HIGH : MT_PRIORITY_LOW
  }
  return Object.keys(parameters).length > 0 ? parameters : null
}

/**
 * ESMTP parameters for one `RCPT TO`, or `null`.
 *
 * `ORCPT` carries the address as the SENDER wrote it, so a report that comes back after an alias or
 * a forward still says which recipient it was about. Without it a receipt for a list address is a
 * report about a name the sender never typed.
 */
export function rcptToParameters(
  email: string,
  options: SendOptions,
  extensions: SubmissionExtensions,
): Record<string, string | null> | null {
  if (!options.deliveryReceipt || !extensions.dsn) return null
  return { NOTIFY: NOTIFY_ALL, ORCPT: `rfc822;${xtext(email)}` }
}
