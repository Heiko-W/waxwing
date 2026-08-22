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

import type {
  EmailPushConfig,
  Id,
  JmapClient,
  PushSubscription,
  PushSubscriptionSetResponse,
} from '@waxwing/jmap'
import { Capabilities, EMAIL_DELIVERY_TYPE, Methods } from '@waxwing/jmap'
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
  /**
   * What this server understands about `draft-ietf-jmap-emailpush-03`, and what to ask it for.
   *
   * **`null` means the server does not advertise the capability** — then the property is never
   * mentioned, in the body or in `using`, and the request is the one the previous build sent.
   * A non-null value with an EMPTY `accountIds` is the other case entirely: the server understands
   * the property and is being told to hold none, which is a patch that must be sent.
   */
  readonly emailPush: EmailPushRequest | null
  /** The user's preview toggle, mirrored into the worker's handover record. */
  readonly preview: boolean
  /** Already translated by the caller. */
  readonly unknownSender: string
  readonly noSubject: string
  /** Injected in tests. */
  readonly now?: () => number
  readonly idb?: IDBFactory | null
}

/**
 * The `emailPush` configuration to send (`draft-ietf-jmap-emailpush-03`). Its EXISTENCE means the
 * server advertises the capability; its contents say what to ask for.
 *
 * `accountIds` is a list because a subscription belongs to the CREDENTIALS: the server pushes for
 * every account they can see, and each one is configured separately. An account left out of the map
 * is not silenced — its deliveries simply arrive as the plain `StateChange` they always did. An
 * EMPTY list means "configure none", i.e. remove whatever the server is holding, which is what the
 * privacy toggle going off asks for.
 */
export interface EmailPushRequest {
  readonly accountIds: readonly string[]
}

/**
 * The `Email` properties a closed-app banner needs, and not one more.
 *
 * Sender, subject, preview, arrival time — the four an iOS Mail notification shows. Everything else
 * on offer (`id`, `blobId`, `threadId`, `mailboxIds`, `keywords`, `bodyValues`, arbitrary headers…)
 * would spend the 4096-byte budget on data no banner renders; `preview` alone can run to a couple of
 * hundred bytes, and the server truncates on its own once the budget is gone — silently, so the
 * symptom of over-asking would be a banner that intermittently loses its subject.
 *
 * `receivedAt` earns its place: it becomes `NotificationOptions.timestamp`, so the shade shows when
 * the mail ARRIVED rather than when a woken worker got around to drawing it.
 */
export const EMAIL_PUSH_PROPERTIES: readonly string[] = ['from', 'subject', 'preview', 'receivedAt']

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

  const wantEmailPush = isConfigured(emailPushMap(deps))

  const plan = planPushSubscription({
    stored,
    endpoint: subscription.endpoint,
    applicationServerKey: deps.applicationServerKey,
    serverHasSubscription: matchesStored,
    expires: mine?.expires ?? null,
    now: now(),
    wantEmailPush,
  })

  try {
    const subscriptionId = await applyPlan(
      plan,
      deps,
      subscription.endpoint,
      keys,
      mine,
      (stored?.emailPush ?? false) !== wantEmailPush,
    )
    await writePushRegistration(
      {
        subscriptionId,
        endpoint: subscription.endpoint,
        applicationServerKey: deps.applicationServerKey,
        // Re-read: the server may have shortened whatever we asked for, and the renewal clock must
        // run on what was GRANTED. Stalwart grants 7 days for any request, including none.
        expires: await grantedExpiry(deps.client, subscriptionId),
        emailPush: wantEmailPush,
      },
      idb,
    )
    await writePushState(workerState(deps), idb)
    return { status: 'subscribed', subscriptionId }
  } catch (error) {
    return { status: 'failed', reason: describe(error) }
  }
}

/**
 * The `emailPush` value to send: a map, `null` to REMOVE the configuration, or `undefined` for
 * "this server must not see the property at all".
 *
 * The three-way return is the whole portability story in one function. `undefined` is a server
 * without `urn:ietf:params:jmap:emailpush`: the request built below is byte-for-byte the one the
 * previous build sent, and its `using` set is the one the method names derive — no unknown URN,
 * nothing for a stock JMAP server to reject. `null` is a server that HAS the capability being told
 * to hold nothing, which is a real patch and must travel with the URN, or the server would reject
 * the request and the configuration would silently stay in place.
 */
function emailPushMap(deps: PushSubscribeDeps): Record<Id, EmailPushConfig> | null | undefined {
  if (deps.emailPush === null) return undefined
  const accountIds = deps.emailPush.accountIds.filter((id) => id !== '')
  if (accountIds.length === 0) return null
  const map: Record<Id, EmailPushConfig> = {}
  for (const accountId of accountIds) {
    map[accountId] = {
      // **`null`, deliberately, and it is the one place this feature declines an obvious saving.**
      // A server-side filter would let the per-folder preference finally apply while the app is
      // closed and would save the device every push it does not want. It would also make a
      // non-matching delivery produce NO push whatsoever — not even a `StateChange` (measured) — so
      // this channel would go blind for every message outside the chosen folders, and any future
      // use of it to wake a sync would inherit a notification preference as its trigger. That is a
      // trade the ADR-017 amendment records as deferred, not one to make inside a property bag.
      filter: null,
      properties: [...EMAIL_PUSH_PROPERTIES],
    }
  }
  return map
}

async function applyPlan(
  plan: ReturnType<typeof planPushSubscription>,
  deps: PushSubscribeDeps,
  endpoint: string,
  keys: { p256dh: string; auth: string },
  mine: PushSubscription | null,
  /** Does the server hold a different `emailPush` config than the user now wants? */
  emailPushChanged: boolean,
): Promise<string> {
  if (plan.kind === 'keep') return plan.subscriptionId

  const emailPush = emailPushMap(deps)
  // The URN travels with any request that MENTIONS the property — including the one that removes it,
  // which a server would otherwise refuse, leaving the old configuration in place with nothing to
  // report it. It travels with nothing else: RFC 8620 §3.3 obliges a server to fail the whole
  // request on an unknown `using` entry, so sending it unconditionally would break every server
  // without the draft, which is nearly all of them.
  const mentionsProperty = emailPush !== undefined
  const callOptions = mentionsProperty ? { using: [Capabilities.emailPush] } : {}

  if (plan.kind === 'renew' || plan.kind === 'reconfigure') {
    // An `expires` in the future is a REQUEST; the server answers with what it is willing to grant.
    // We ask for the far end deliberately and read back what we got rather than assuming.
    const requested = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString()
    // Both patches ride in ONE update when both are due. A renewal that postponed the content change
    // to the next pass would postpone it by however long it takes the user to open the app again —
    // up to a week, on a switch about what appears on their lock screen.
    const patch = {
      ...(plan.kind === 'renew' ? { expires: requested } : {}),
      // `null` is not "leave it alone": it is how the config is REMOVED when the preview toggle went
      // off. Sent only when it changes, which is what `reconfigure` means and what the renewal path
      // asks `emailPushChanged` about.
      ...(emailPushChanged && mentionsProperty ? { emailPush } : {}),
    }
    await deps.client.call(
      [[Methods.pushSubscriptionSet.name, { update: { [plan.subscriptionId]: patch } }, 'p0']],
      callOptions,
    )
    return plan.subscriptionId
  }

  // `create` — destroy the row we know is stale first, in the SAME request, so a failure cannot
  // leave two subscriptions where the server pushes to a dead endpoint alongside a live one.
  const destroy = plan.destroyId ?? mine?.id ?? null
  const responses = await deps.client.call(
    [
      [
        Methods.pushSubscriptionSet.name,
        {
          ...(destroy === null ? {} : { destroy: [destroy] }),
          create: {
            sub: {
              deviceClientId: deps.deviceClientId,
              url: endpoint,
              keys,
              // Still the server's filter, and still the reason the worker needs no token: a push
              // arrives only when mail was delivered, never when another client merely read a
              // message (ADR-017). What the amendment of 2026-08-21 changed is what the push CARRIES.
              types: [EMAIL_DELIVERY_TYPE],
              // Absent entirely when `null` — see `emailPushMap`. A stock JMAP server must see the
              // exact request the previous build sent.
              ...(isConfigured(emailPush) ? { emailPush } : {}),
            },
          },
        },
        'p0',
      ],
    ],
    callOptions,
  )
  const response = responses.get<PushSubscriptionSetResponse>('p0')
  const created = firstCreated(response)
  if (created === null) throw new Error(setErrorText(response))
  return created.id
}

/** Is this a configuration the server should HOLD, as opposed to none and as opposed to absent? */
function isConfigured(
  value: Record<Id, EmailPushConfig> | null | undefined,
): value is Record<Id, EmailPushConfig> {
  return value !== null && value !== undefined
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
    preview: deps.preview,
    unknownSender: deps.unknownSender,
    noSubject: deps.noSubject,
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
