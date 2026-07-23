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
import { ensureDeviceClientId, takePendingVerification } from './push-store'
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
  /** The user does not want it, or is signed out — the subscription is torn down. */
  | 'unsubscribed'
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
  /** `null` when signed out. */
  readonly client: JmapClient | null
  readonly session: Session | null
  /**
   * Does the user want background notifications right now? The master switch AND a granted browser
   * permission AND a server that can sign a push — collapsed by the caller, because all three are
   * React state and none of them belongs in here.
   */
  readonly wanted: boolean
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
 * **Order is the part worth reading.** The teardown branch comes before the capability check, so
 * switching notifications off tears the subscription down even on a server that has since stopped
 * advertising RFC 9749 — otherwise a capability that disappeared would strand a live subscription
 * the user can no longer turn off, and the server would go on pushing to it.
 */
export async function reconcilePushSubscription(deps: ReconcileDeps): Promise<ReconcileOutcome> {
  const idb = deps.idb ?? null
  if (deps.registration === null) return 'noServiceWorker'

  if (!deps.wanted || deps.client === null) {
    await unsubscribePush({ registration: deps.registration, client: deps.client, idb })
    return 'unsubscribed'
  }

  const vapid = deps.session === null ? null : getWebPushVapidCapability(deps.session)
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

  // A code the worker parked because no window was open when the server verified. Normally there is
  // none — the page is open when a subscription is created — but a subscription stuck unverified is
  // silent FOREVER, with nothing anywhere to say why, so the recovery path is not optional.
  const pending = await takePendingVerification(idb)
  if (pending === null) return 'subscribed'
  await submitPushVerification(deps.client, pending.pushSubscriptionId, pending.verificationCode)
  return 'subscribedAndVerified'
}
