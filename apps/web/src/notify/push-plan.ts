/**
 * What a subscribe pass should DO — pure (M4.0, FR-NOTIF-02).
 *
 * The impure half (`push-subscribe.ts`) touches the PushManager, JMAP and IndexedDB, and none of
 * those can answer the question this file answers: *given what we last registered, what the browser
 * hands us now, and what the server says, is the subscription still good?* Keeping that decision
 * here is what makes the renewal rule — the one an owner decision turned on, because Stalwart grants
 * seven days and never more — a thing tests can pin instead of a thing that is discovered in a week.
 */

import type { PushRegistrationRecord } from './push-store'

/**
 * Renew this long before the server's `expires`.
 *
 * Two days out of a seven-day grant. The margin has to survive a user who opens the app on Friday
 * and not again until Monday — miss it and the subscription lapses silently, which is the failure
 * mode ADR-017 refuses to paper over. A larger margin costs one extra `PushSubscription/set` per
 * few days; a smaller one costs the feature.
 */
export const RENEW_BEFORE_MS = 2 * 24 * 60 * 60 * 1000

/** What the caller must do to bring the subscription in line. */
export type PushPlan =
  /** Nothing to do — the registration matches the browser and is not near expiry. */
  | { readonly kind: 'keep'; readonly subscriptionId: string }
  /** Extend the existing subscription's lifetime: `PushSubscription/set update { expires }`. */
  | { readonly kind: 'renew'; readonly subscriptionId: string }
  /**
   * Register from scratch. `destroyId` names a server-side subscription that must go first — set
   * whenever we know of one whose browser endpoint no longer exists, so a stale subscription cannot
   * accumulate on the server every time an endpoint rotates.
   */
  | { readonly kind: 'create'; readonly destroyId: string | null }

export interface PushPlanInput {
  /** What we last registered, or `null` on a first run / after a wipe. */
  readonly stored: PushRegistrationRecord | null
  /** The endpoint the browser hands us NOW. */
  readonly endpoint: string
  /** The server's current VAPID key. A rotation invalidates every endpoint minted against the old one. */
  readonly applicationServerKey: string
  /**
   * Does the server still list `stored.subscriptionId`? A subscription can expire out from under us
   * while the browser endpoint stays perfectly valid, and then only the server knows.
   */
  readonly serverHasSubscription: boolean
  /** The `expires` the SERVER granted, which may be shorter than anything we asked for. */
  readonly expires: string | null
  readonly now: number
}

/**
 * Decide.
 *
 * Order matters and is not arbitrary: identity questions (do we even have a record, is it about this
 * endpoint, this key, does the server still have it) are settled before the lifetime question,
 * because a `renew` against a subscription the server has dropped would be an update to nothing —
 * succeeding as a no-op with `notUpdated`, and leaving the app believing it is subscribed.
 */
export function planPushSubscription(input: PushPlanInput): PushPlan {
  const { stored } = input

  if (stored === null) return { kind: 'create', destroyId: null }

  // The browser minted a new endpoint (push-service rotation, cleared site data, a re-install). The
  // server's copy points at an endpoint that no longer receives, so it is garbage — name it for
  // destruction rather than leaving it to expire on its own.
  if (stored.endpoint !== input.endpoint) {
    return { kind: 'create', destroyId: stored.subscriptionId }
  }

  // The server rotated its VAPID key. Endpoints are bound to the key they were created with
  // (RFC 8292 §4.2), so the browser subscription itself has to be replaced — the caller unsubscribes
  // before re-subscribing, and the old server-side row goes with it.
  if (stored.applicationServerKey !== input.applicationServerKey) {
    return { kind: 'create', destroyId: stored.subscriptionId }
  }

  // We think we have one and the server does not. Nothing to destroy — it is already gone.
  if (!input.serverHasSubscription) return { kind: 'create', destroyId: null }

  if (input.expires === null) return { kind: 'keep', subscriptionId: stored.subscriptionId }

  const expiresAt = Date.parse(input.expires)
  // An unparsable date is the server telling us something we cannot act on. Renewing is the safe
  // reading: the cost is one redundant call, and the alternative is trusting a value we cannot read.
  if (Number.isNaN(expiresAt)) return { kind: 'renew', subscriptionId: stored.subscriptionId }

  if (expiresAt - input.now <= RENEW_BEFORE_MS) {
    return { kind: 'renew', subscriptionId: stored.subscriptionId }
  }

  return { kind: 'keep', subscriptionId: stored.subscriptionId }
}
