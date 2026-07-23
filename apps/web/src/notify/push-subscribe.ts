/**
 * The Web Push subscribe flow (M4.0, FR-NOTIF-02) — the impure half. Every decision it takes is in
 * `push-plan.ts`; this file does the touching: `PushManager`, JMAP, and the worker handover store.
 *
 * **It runs in the PAGE, never in the worker, and that is the security boundary this work package
 * exists to keep.** The JMAP calls below are authenticated, so they live where the token already is.
 * The worker gets a database record with pre-translated strings and nothing else (ADR-017). If this
 * file ever grows an import that `sw.ts` would need, the design has gone wrong.
 *
 * Every entry point is idempotent and safe to call on every start: that is what makes the seven-day
 * expiry survivable, since Stalwart grants seven days whether or not we ask for more, and a
 * subscription can only be renewed by a client that is running.
 */

import type { Id, JmapClient, PushSubscription, PushSubscriptionSetResponse } from '@waxwing/jmap'
import { EMAIL_DELIVERY_TYPE, Methods } from '@waxwing/jmap'
import { base64UrlToBytes, bytesToBase64Url } from './push-keys'
import { planPushSubscription } from './push-plan'
import {
  clearPushState,
  deletePushRegistration,
  type PushWorkerState,
  readPushRegistration,
  writePushRegistration,
  writePushState,
} from './push-store'
import type { QuietHours } from './quiet-hours'

/** The slice of `ServiceWorkerRegistration` this flow needs — a fake supplies it in tests. */
export interface PushCapableRegistration {
  readonly pushManager: {
    getSubscription(): Promise<BrowserPushSubscription | null>
    subscribe(options: {
      userVisibleOnly: boolean
      applicationServerKey: BufferSource
    }): Promise<BrowserPushSubscription>
  }
}

/** The slice of the DOM `PushSubscription` we read. Named apart to avoid the JMAP type's name. */
export interface BrowserPushSubscription {
  readonly endpoint: string
  getKey(name: 'p256dh' | 'auth'): ArrayBuffer | null
  unsubscribe(): Promise<boolean>
}

export interface PushSubscribeDeps {
  readonly registration: PushCapableRegistration
  readonly client: JmapClient
  /** From `getWebPushVapidCapability(session)`. Absent ⇒ this server cannot sign a push at all. */
  readonly applicationServerKey: string
  /** Stable per-installation id; {@link newDeviceClientId} mints one when the store has none. */
  readonly deviceClientId: string
  /** Already translated by the caller — the worker cannot run i18next. */
  readonly title: string
  readonly body: string
  readonly iconUrl: string
  readonly badgeUrl: string
  readonly quietHours: QuietHours | null
  readonly sound: boolean
  /** Injected in tests. */
  readonly now?: () => number
  readonly idb?: IDBFactory | null
}

export type PushSubscribeResult =
  | { readonly status: 'subscribed'; readonly subscriptionId: string }
  /** The browser refused (permission, no push service, iOS outside a Home-Screen install). */
  | { readonly status: 'unsupported' }
  | { readonly status: 'failed'; readonly reason: string }

/** A stable id for THIS installation, persisted in the push store. */
export function newDeviceClientId(): string {
  // `randomUUID` needs a secure context — which a service worker already requires, so anything that
  // reaches this code has one. The fallback is for jsdom, not for production.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `waxwing-${crypto.randomUUID()}`
  }
  return `waxwing-${Math.random().toString(36).slice(2)}-${String(Date.now())}`
}

function keysOf(subscription: BrowserPushSubscription): { p256dh: string; auth: string } | null {
  const p256dh = subscription.getKey('p256dh')
  const auth = subscription.getKey('auth')
  if (p256dh === null || auth === null) return null
  return { p256dh: bytesToBase64Url(p256dh), auth: bytesToBase64Url(auth) }
}

/**
 * Get the browser subscription, creating one if needed — and replacing one minted against a
 * different VAPID key.
 *
 * The replacement case is not hypothetical bookkeeping: an endpoint is bound to the application
 * server key it was created with (RFC 8292 §4.2), so after a server rotates its key the old endpoint
 * still *exists* and still accepts `getSubscription()`, while every push to it is rejected. Reusing
 * it would leave notifications permanently, silently dead.
 */
async function browserSubscription(
  deps: PushSubscribeDeps,
  storedKey: string | null,
): Promise<BrowserPushSubscription> {
  const existing = await deps.registration.pushManager.getSubscription()
  if (existing !== null && storedKey !== null && storedKey !== deps.applicationServerKey) {
    // Best-effort: a failed unsubscribe still lets `subscribe()` return the existing subscription,
    // which the plan will then handle as an endpoint we already know.
    await existing.unsubscribe().catch(() => false)
  } else if (existing !== null) {
    return existing
  }
  return deps.registration.pushManager.subscribe({
    // Mandatory on Chromium: a subscription that may push silently is refused outright. It is also
    // the honest declaration — every push this app receives does raise a banner.
    userVisibleOnly: true,
    applicationServerKey: base64UrlToBytes(deps.applicationServerKey),
  })
}

/** Ids the server currently holds for this device, and what it granted them. */
async function serverSubscriptions(client: JmapClient): Promise<PushSubscription[]> {
  const responses = await client.call([[Methods.pushSubscriptionGet.name, { ids: null }, 'p0']])
  return responses.get<{ list: PushSubscription[] }>('p0').list
}

function firstCreated(response: PushSubscriptionSetResponse): PushSubscription | null {
  const created = response.created
  if (created === null || created === undefined) return null
  for (const value of Object.values(created)) return value
  return null
}

function setErrorText(response: PushSubscriptionSetResponse): string {
  const notCreated = response.notCreated
  if (notCreated !== null && notCreated !== undefined) {
    for (const error of Object.values(notCreated)) {
      return `${error.type}${error.description === null ? '' : `: ${String(error.description)}`}`
    }
  }
  return 'no subscription was created'
}

/**
 * Bring the subscription in line, whatever state it is in. Safe on every start.
 *
 * Failures return rather than throw. A subscription that cannot be established is a feature that
 * does not work, not an app that should break — the caller surfaces it, and everything the live push
 * channel does keeps working regardless.
 */
export async function ensurePushSubscription(
  deps: PushSubscribeDeps,
): Promise<PushSubscribeResult> {
  const now = deps.now ?? Date.now
  const idb = deps.idb ?? null

  const stored = await readPushRegistration(idb)

  let subscription: BrowserPushSubscription
  try {
    subscription = await browserSubscription(deps, stored?.applicationServerKey ?? null)
  } catch {
    // `NotAllowedError` (permission), `AbortError` (no push service, or a key the browser rejects),
    // `NotSupportedError` (WebKit outside a Home-Screen install). None of them is a bug on our side,
    // and none is retryable within this session — so it is `unsupported`, not `failed`.
    return { status: 'unsupported' }
  }

  const keys = keysOf(subscription)
  if (keys === null) return { status: 'failed', reason: 'the browser subscription carries no keys' }

  let onServer: PushSubscription[]
  try {
    onServer = await serverSubscriptions(deps.client)
  } catch (error) {
    return { status: 'failed', reason: describe(error) }
  }
  const mine = onServer.find((row) => row.deviceClientId === deps.deviceClientId) ?? null
  const matchesStored = stored !== null && mine !== null && mine.id === stored.subscriptionId

  const plan = planPushSubscription({
    stored,
    endpoint: subscription.endpoint,
    applicationServerKey: deps.applicationServerKey,
    serverHasSubscription: matchesStored,
    expires: mine?.expires ?? null,
    now: now(),
  })

  try {
    const subscriptionId = await applyPlan(plan, deps, subscription.endpoint, keys, mine)
    await writePushRegistration(
      {
        subscriptionId,
        endpoint: subscription.endpoint,
        applicationServerKey: deps.applicationServerKey,
        // Re-read: the server may have shortened whatever we asked for, and the renewal clock must
        // run on what was GRANTED. Stalwart grants 7 days for any request, including none.
        expires: await grantedExpiry(deps.client, subscriptionId),
      },
      idb,
    )
    await writePushState(workerState(deps), idb)
    return { status: 'subscribed', subscriptionId }
  } catch (error) {
    return { status: 'failed', reason: describe(error) }
  }
}

async function applyPlan(
  plan: ReturnType<typeof planPushSubscription>,
  deps: PushSubscribeDeps,
  endpoint: string,
  keys: { p256dh: string; auth: string },
  mine: PushSubscription | null,
): Promise<string> {
  if (plan.kind === 'keep') return plan.subscriptionId

  if (plan.kind === 'renew') {
    // An `expires` in the future is a REQUEST; the server answers with what it is willing to grant.
    // We ask for the far end deliberately and read back what we got rather than assuming.
    const requested = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString()
    await deps.client.call([
      [
        Methods.pushSubscriptionSet.name,
        { update: { [plan.subscriptionId]: { expires: requested } } },
        'p0',
      ],
    ])
    return plan.subscriptionId
  }

  // `create` — destroy the row we know is stale first, in the SAME request, so a failure cannot
  // leave two subscriptions where the server pushes to a dead endpoint alongside a live one.
  const destroy = plan.destroyId ?? mine?.id ?? null
  const responses = await deps.client.call([
    [
      Methods.pushSubscriptionSet.name,
      {
        ...(destroy === null ? {} : { destroy: [destroy] }),
        create: {
          sub: {
            deviceClientId: deps.deviceClientId,
            url: endpoint,
            keys,
            // The whole reason the worker needs no token: the SERVER filters, so a push arrives only
            // when mail was delivered — never when another client merely read a message (ADR-017).
            types: [EMAIL_DELIVERY_TYPE],
          },
        },
      },
      'p0',
    ],
  ])
  const response = responses.get<PushSubscriptionSetResponse>('p0')
  const created = firstCreated(response)
  if (created === null) throw new Error(setErrorText(response))
  return created.id
}

async function grantedExpiry(client: JmapClient, subscriptionId: Id): Promise<string | null> {
  try {
    const rows = await serverSubscriptions(client)
    return rows.find((row) => row.id === subscriptionId)?.expires ?? null
  } catch {
    // Unknown expiry ⇒ the plan renews on the next pass rather than trusting a value we do not have.
    return null
  }
}

function workerState(deps: PushSubscribeDeps): PushWorkerState {
  return {
    deviceClientId: deps.deviceClientId,
    title: deps.title,
    body: deps.body,
    iconUrl: deps.iconUrl,
    badgeUrl: deps.badgeUrl,
    quietHours: deps.quietHours,
    sound: deps.sound,
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Write the verification code back (RFC 8620 §7.2.2). Until this succeeds the server pushes nothing
 * but the verification itself, so a silent failure here looks exactly like "notifications are on and
 * nothing ever arrives".
 */
export async function submitPushVerification(
  client: JmapClient,
  pushSubscriptionId: string,
  verificationCode: string,
): Promise<boolean> {
  try {
    const responses = await client.call([
      [
        Methods.pushSubscriptionSet.name,
        { update: { [pushSubscriptionId]: { verificationCode } } },
        'p0',
      ],
    ])
    const response = responses.get<PushSubscriptionSetResponse>('p0')
    return response.updated !== null && Object.hasOwn(response.updated ?? {}, pushSubscriptionId)
  } catch {
    return false
  }
}

/**
 * Tear the subscription down: the browser's, the server's, and our bookkeeping.
 *
 * Called when the master switch goes off and on sign-out. Order matters — the server row goes first,
 * because a browser unsubscribe that succeeds while the JMAP call fails would leave the server
 * pushing to a dead endpoint with nothing on our side left to name it by. Never throws.
 */
export async function unsubscribePush(deps: {
  readonly registration: PushCapableRegistration
  readonly client: JmapClient | null
  readonly idb?: IDBFactory | null
}): Promise<void> {
  const idb = deps.idb ?? null
  const stored = await readPushRegistration(idb)

  if (stored !== null && deps.client !== null) {
    try {
      await deps.client.call([
        [Methods.pushSubscriptionSet.name, { destroy: [stored.subscriptionId] }, 'p0'],
      ])
    } catch {
      /* offline, or already gone; the browser half below still has to happen */
    }
  }

  try {
    const subscription = await deps.registration.pushManager.getSubscription()
    if (subscription !== null) await subscription.unsubscribe()
  } catch {
    /* nothing left to do — the server row is gone, so nothing can be delivered anyway */
  }

  await deletePushRegistration(idb)
}

/**
 * Sign-out (FR-AUTH-05): destroy the subscription and forget everything about it.
 *
 * **This must run while the client is still usable.** A subscription outlives a sign-out on the
 * SERVER, and the server has no idea anyone signed out — so a browser left subscribed keeps waking
 * up and raising "New message" banners for a mailbox nobody is signed into, on a machine that may
 * now belong to someone else. That it says nothing about the message is not a defence: it still
 * announces that this account receives mail, and clicking it opens the app.
 *
 * The whole `waxwing-push` database goes, including the `deviceClientId` — the next user of a shared
 * machine must not re-register under the identity of the last one. Never throws: a sign-out
 * completes regardless.
 */
export async function tearDownPushSubscription(deps: {
  readonly registration: PushCapableRegistration | null
  readonly client: JmapClient | null
  readonly idb?: IDBFactory | null
}): Promise<void> {
  try {
    if (deps.registration !== null) {
      await unsubscribePush({
        registration: deps.registration,
        client: deps.client,
        ...(deps.idb === undefined ? {} : { idb: deps.idb }),
      })
    }
    await clearPushState(deps.idb ?? null)
  } catch {
    /* a sign-out is never blocked by the push store */
  }
}
