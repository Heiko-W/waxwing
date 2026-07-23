/**
 * What arrived on a Web Push (M4.0, FR-NOTIF-02) — pure and DOM-free, because it is imported by the
 * SERVICE WORKER (`src/sw/sw.ts`), which compiles in its own program (`tsconfig.sw.json`,
 * `lib: WebWorker`, `types: []`). Nothing here may touch `window`, `document` or React.
 *
 * **The wire shapes are re-declared here instead of imported from `@waxwing/jmap`, and that is not
 * an oversight.** A value import from the package barrel would drag `push/` — the SSE and WebSocket
 * transports — into the worker's *typecheck*, where `EventSource` does not exist, and into `sw.js`,
 * a bundle every visitor downloads. `click-route.ts` declares `MailNotificationData` locally for the
 * same reason; the precedent is deliberate. What keeps the duplication honest is a test that imports
 * BOTH this module and `@waxwing/jmap` (the app program may) and asserts the two agree — so the day
 * the canonical name changes, this file goes red rather than silently reading a type nobody sends.
 *
 * Everything is total: the input came through the browser's push decryption from a server we do not
 * control, so a shape we do not recognise is an ordinary outcome and must never throw. A thrown
 * error inside a `push` handler is a notification the user never sees, with nothing on screen to
 * say so.
 *
 * The one thing it DOES import is `quiet-hours.ts`, which is DOM-free for exactly that purpose. The
 * distinction is worth stating: a type NAME may be restated (a test pins the two together), a RULE
 * may not — a second copy of the midnight-crossing logic would drift, and the failure would be
 * invisible until someone was woken at 3 a.m.
 */

import { inQuietHours, type QuietHours } from './quiet-hours'

export type { QuietHours }

/**
 * The RFC 8620 §7 type name meaning **mail arrived** — as opposed to `Email`, which also moves when
 * another client merely reads or files a message. Canonical copy: `EMAIL_DELIVERY_TYPE` in
 * `@waxwing/jmap`; see the header for why this one exists.
 */
export const EMAIL_DELIVERY = 'EmailDelivery'

/**
 * What the worker does about a decrypted push frame.
 *
 *  - `delivery` — a `StateChange` naming `EmailDelivery`: new mail, raise the banner.
 *  - `stateChange` — a `StateChange` without it. Someone read a message on another device, or a
 *    mailbox was renamed. Explicitly NOT `unknown`: it is a frame we understood and decided against,
 *    and the distinction is what a test can pin.
 *  - `verification` — RFC 8620 §7.2.2, the code that must be written back before the server pushes
 *    anything real.
 *  - `unknown` — anything else, including an empty push (some services send one to keep an endpoint
 *    warm) and a payload that is not JSON at all.
 */
export type PushFrame =
  | { readonly kind: 'delivery'; readonly accountIds: readonly string[] }
  | { readonly kind: 'stateChange' }
  | {
      readonly kind: 'verification'
      readonly pushSubscriptionId: string
      readonly verificationCode: string
    }
  | { readonly kind: 'unknown' }

const UNKNOWN: PushFrame = { kind: 'unknown' }

/**
 * SW → page: "the server pushed a verification code; write it back."
 *
 * The worker cannot do it itself — that is an authenticated JMAP call, and keeping those out of the
 * worker is the whole security argument for the contentless banner (ADR-017). Declared here rather
 * than in `click-route.ts` so the two message contracts stay separate, and here rather than in
 * `push-store.ts` so the worker's message path does not depend on its database path.
 */
export const PUSH_VERIFICATION = 'PUSH_VERIFICATION'

export interface PushVerificationMessage {
  readonly type: typeof PUSH_VERIFICATION
  readonly pushSubscriptionId: string
  readonly verificationCode: string
}

export function isPushVerificationMessage(value: unknown): value is PushVerificationMessage {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    v.type === PUSH_VERIFICATION &&
    typeof v.pushSubscriptionId === 'string' &&
    typeof v.verificationCode === 'string'
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Which accounts in this frame reported a delivery.
 *
 * A subscription is bound to CREDENTIALS, not to an account (RFC 8620 §7.2), so one push can carry
 * several accounts at once — and the `changed` map is attacker-adjacent data: a server may put
 * anything in it. Values are checked to be objects before they are read, and a `changed` that is not
 * a record yields no accounts rather than an exception.
 */
function deliveringAccounts(changed: unknown): string[] {
  if (!isRecord(changed)) return []
  const accounts: string[] = []
  for (const [accountId, typeStates] of Object.entries(changed)) {
    if (!isRecord(typeStates)) continue
    if (Object.hasOwn(typeStates, EMAIL_DELIVERY)) accounts.push(accountId)
  }
  return accounts
}

/** Classify one decrypted push payload. Never throws. */
export function classifyPushFrame(value: unknown): PushFrame {
  if (!isRecord(value)) return UNKNOWN

  if (value['@type'] === 'StateChange') {
    const accountIds = deliveringAccounts(value.changed)
    return accountIds.length > 0 ? { kind: 'delivery', accountIds } : { kind: 'stateChange' }
  }

  if (value['@type'] === 'PushVerification') {
    const id = value.pushSubscriptionId
    const code = value.verificationCode
    // Both must be present AND non-empty: an empty code written back would be indistinguishable from
    // never having verified, and the subscription would sit silent with nothing to explain it.
    if (typeof id === 'string' && id !== '' && typeof code === 'string' && code !== '') {
      return { kind: 'verification', pushSubscriptionId: id, verificationCode: code }
    }
    return UNKNOWN
  }

  return UNKNOWN
}

/**
 * Parse a push payload's text into a frame. `null`/absent data is an ordinary empty push.
 *
 * Kept beside {@link classifyPushFrame} rather than inlined at the call site so the worker's handler
 * stays glue — nothing in `src/sw/` can have a test.
 */
export function parsePushFrame(text: string | null | undefined): PushFrame {
  if (text === null || text === undefined || text === '') return UNKNOWN
  try {
    return classifyPushFrame(JSON.parse(text))
  } catch {
    return UNKNOWN
  }
}

/** Why a push did not become a banner — so a test can tell the four silences apart. */
export type PushBannerDecision =
  | { readonly show: true }
  | {
      readonly show: false
      readonly because: 'notADelivery' | 'noState' | 'quietHours' | 'visible'
    }

export interface PushBannerInput {
  readonly frame: PushFrame
  /** Did the page leave a handover record? Without one there is no text to show. */
  readonly hasState: boolean
  /** Is a window of OURS visible right now? Then the live channel already said it, and better. */
  readonly hasVisibleClient: boolean
  readonly quietHours: QuietHours | null
  /** Local wall-clock minutes since midnight, from the worker's own clock. */
  readonly minutesOfDay: number
}

/**
 * Should this push raise a banner? Pure, so the worker's handler stays glue and every branch of it
 * has a test — nothing in `src/sw/` can have one.
 *
 * The `visible` rule is the subtle one, and it is a deliberate, bounded exception rather than an
 * optimisation. `userVisibleOnly: true` was promised at subscribe time and browsers enforce it: a
 * push handled without showing anything earns a "this site was updated in the background" notice
 * from the browser itself, and repeated offences cost the subscription. What justifies it is that a
 * visible window means the live channel has ALREADY raised the richer banner, with sender and
 * subject — two banners for one message is worse than one.
 *
 * Order is load-bearing: `visible` is checked BEFORE quiet hours, because during quiet hours with
 * the app open the live channel is the one that decided to stay silent, and this path must not
 * second-guess it either way.
 */
export function shouldRaisePushBanner(input: PushBannerInput): PushBannerDecision {
  if (input.frame.kind !== 'delivery') return { show: false, because: 'notADelivery' }
  // No state ⇒ the page never completed a subscribe pass, or was signed out and wiped. A banner
  // would mean inventing its text, and an untranslated string is not a fallback.
  if (!input.hasState) return { show: false, because: 'noState' }
  if (input.hasVisibleClient) return { show: false, because: 'visible' }
  // `inQuietHours` is IMPORTED, not restated. `quiet-hours.ts` is DOM-free precisely so both paths
  // can share it: a second copy of the midnight-crossing rule would drift, and the symptom would be
  // quiet hours working with the app open and failing with it closed — silently, at 3 a.m.
  if (input.quietHours !== null && inQuietHours(input.minutesOfDay, input.quietHours)) {
    return { show: false, because: 'quietHours' }
  }
  return { show: true }
}
