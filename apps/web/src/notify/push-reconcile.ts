/**
 * One reconciliation pass: bring the Web Push subscription in line with what the user asked for
 * (M4.0, FR-NOTIF-02). Extracted from the React host so it can be tested — the host is then a
 * `useEffect` that calls this and nothing else.
 *
 * It is worth separating precisely because the failure it guards against is **silence**. If this
 * pass stops running, or takes a wrong branch, nothing breaks visibly: the app works, the settings
 * still say notifications are on, and the user finds out a week later when the seven-day grant
 * lapses and the banners simply stop. There is no error to surface, no state to inspect, and no
 * moment at which anyone would connect it to a change made today. So each branch gets a name and a
 * test rather than living inside an effect nobody can drive.
 */

import type { JmapClient, Session } from '@waxwing/jmap'
import { getWebPushVapidCapability } from '@waxwing/jmap'
import {
  clearPendingVerification,
  ensureDeviceClientId,
  peekPendingVerification,
} from './push-store'
import {
  ensurePushSubscription,
  newDeviceClientId,
  type PushCapableRegistration,
  submitPushVerification,
  unsubscribePush,
} from './push-subscribe'
import type { QuietHours } from './quiet-hours'

/** What happened, named so a test can tell the silences apart. */
export type ReconcileOutcome =
  /** No service worker at all: the dev server, an insecure context, a failed registration. */
  | 'noServiceWorker'
  /** The user switched it off (or the browser blocked it) — the subscription is torn down. */
  | 'unsubscribed'
  /**
   * We cannot act right now and must NOT guess: signed out, session still loading, capability not
   * yet known. Distinct from `unsubscribed` on purpose — see {@link reconcilePushSubscription}.
   */
  | 'cannotAct'
  /** The server publishes no RFC 9749 key, so there is nothing to subscribe against. */
  | 'noServerKey'
  /** The browser refused (permission, no push service, iOS outside a Home-Screen install). */
  | 'unsupported'
  | 'failed'
  | 'subscribed'
  /** Subscribed, and a verification code the worker had parked was written back. */
  | 'subscribedAndVerified'

export interface ReconcileDeps {
  /** `null` when the browser has no usable service-worker registration. */
  readonly registration: PushCapableRegistration | null
  /** `null` when signed out OR while the session is (re)connecting — the two are indistinguishable. */
  readonly client: JmapClient | null
  readonly session: Session | null
  /**
   * The master switch (`localPrefs`) — the user's own, explicit answer. **Only this and a `denied`
   * permission may tear a subscription down.**
   */
  readonly enabled: boolean
  /** The browser permission. `denied` is a decision; `default` is merely "not asked yet". */
  readonly permission: 'unsupported' | 'default' | 'granted' | 'denied'
  /** Does the SERVER advertise RFC 9749? Unknown (false) while the session is still loading. */
  readonly serverSupports: boolean
  /** Already translated — the worker cannot run i18next (ADR-017). */
  readonly title: string
  readonly body: string
  readonly iconUrl: string
  readonly badgeUrl: string
  readonly quietHours: QuietHours | null
  readonly sound: boolean
  /** Injected in tests. */
  readonly idb?: IDBFactory | null
}

/**
 * Run one pass. Never throws: a subscription that cannot be established is a feature that does not
 * work, not an app that should break, and everything the live channel does keeps working regardless.
 *
 * **Tearing down and being unable to act are DIFFERENT, and conflating them destroyed working
 * subscriptions in a loop.** The first version collapsed the master switch, the permission, the
 * server capability and the client into one `wanted` boolean and tore the subscription down whenever
 * it was false. But three of those four are *transient*: `client` is null while the session
 * reconnects, `serverSupports` is false until the session document has loaded, and `permission` is
 * `default` before it is read. So an ordinary reconnect — or the re-render that follows a push —
 * destroyed a healthy subscription, the next pass built a new one, and the verification code the
 * service worker had just parked now belonged to a subscription that no longer existed. The
 * handshake could never complete, and each round did it again. Observed live in Chrome's
 * `gcm-internals` (2026-07-23, B29): message received at 22:17:15, unregistration in the same
 * second, re-registration 44 s later.
 *
 * So the rule is: **only an explicit "no" tears anything down.** The master switch being off is the
 * user's own answer; a `denied` permission is the browser's. Everything else — no client, no
 * session, capability not yet known — means *we do not know yet*, and the honest response to not
 * knowing is to leave the subscription alone.
 */
export async function reconcilePushSubscription(deps: ReconcileDeps): Promise<ReconcileOutcome> {
  const idb = deps.idb ?? null
  if (deps.registration === null) return 'noServiceWorker'

  // An explicit "no" — the only thing that may destroy a subscription. `denied` is a decision the
  // browser has recorded; `default`/`unsupported` are not, and must not be read as one.
  if (!deps.enabled || deps.permission === 'denied') {
    await unsubscribePush({ registration: deps.registration, client: deps.client, idb })
    return 'unsubscribed'
  }

  // Everything below needs a live client and a loaded session. Not having them is a "come back
  // later", never a teardown.
  if (deps.client === null || deps.session === null) return 'cannotAct'
  if (deps.permission !== 'granted') return 'cannotAct'
  if (!deps.serverSupports) return 'cannotAct'

  const vapid = getWebPushVapidCapability(deps.session)
  if (vapid === null) return 'noServerKey'

  const deviceClientId = await ensureDeviceClientId(newDeviceClientId, idb)

  const result = await ensurePushSubscription({
    registration: deps.registration,
    client: deps.client,
    applicationServerKey: vapid.applicationServerKey,
    deviceClientId,
    title: deps.title,
    body: deps.body,
    iconUrl: deps.iconUrl,
    badgeUrl: deps.badgeUrl,
    quietHours: deps.quietHours,
    sound: deps.sound,
    idb,
  })
  if (result.status !== 'subscribed') return result.status

  // The verification the worker parked (RFC 8620 §7.2.2). The worker parks it on EVERY verification
  // push, not only when no window was open — so this is the reliable path, and the `postMessage` the
  // page also receives is only what saves a reload. A subscription stuck unverified is silent
  // forever with nothing anywhere to say why; it is the failure this whole branch exists for.
  const pending = await peekPendingVerification(idb)
  if (pending === null) return 'subscribed'

  const accepted = await submitPushVerification(
    deps.client,
    pending.pushSubscriptionId,
    pending.verificationCode,
  )
  // Consumed only once the SERVER has taken it. A write-back can fail because the device is offline,
  // and then the code is still good — dropping it would strand the subscription until something
  // recreated it.
  if (accepted) await clearPendingVerification(idb)
  return accepted ? 'subscribedAndVerified' : 'subscribed'
}
