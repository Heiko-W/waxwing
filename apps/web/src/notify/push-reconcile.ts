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
import { Capabilities, getWebPushVapidCapability, hasCapability } from '@waxwing/jmap'
import {
  clearPendingVerification,
  ensureDeviceClientId,
  peekPendingVerification,
} from './push-store'
import {
  type EmailPushRequest,
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
   * The master switch (`localPrefs`) — the user's own, explicit answer. **Only this (once loaded)
   * and a `denied` permission may tear a subscription down.**
   */
  readonly enabled: boolean
  /**
   * Has the master switch actually LOADED from IndexedDB? `useLocalPref` returns `undefined` for a
   * beat on every start, which the host reads as the default (`enabled: false`) — and that default
   * is NOT the user's "off". `false` here means "still loading, do not act yet"; only a LOADED
   * `enabled === false` is a decision. Conflating the two tore the subscription down on every single
   * app start (B29, 2026-07-24 hand-test): reopening the tab unregistered the working endpoint and
   * minted a fresh one, over and over.
   */
  readonly prefsLoaded: boolean
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
  /**
   * FR-NOTIF-03's "show sender and subject". **It governs the WIRE, not only the banner**: with it
   * off, no `emailPush` config is sent, so the server never puts a subject in a push at all. A push
   * that carries a subject is content even when the banner declines to show it — it crosses the push
   * service, sits in the browser's queue and is decrypted in a worker — and a privacy toggle that
   * only hid it at the last step would be honouring the letter of the setting and not its point.
   */
  readonly preview: boolean
  /** Already translated. Used only when a pushed message lacks a `from` / a `subject`. */
  readonly unknownSender: string
  readonly noSubject: string
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
/**
 * Serialisation state for {@link reconcilePush}. Module-level on purpose: the thing being protected
 * is not a component but the browser's ONE push subscription and its server-side twin.
 */
let inFlight: Promise<unknown> | null = null
/** The deps of the pass waiting behind the running one. Latest wins — see {@link reconcilePush}. */
let pendingDeps: ReconcileDeps | null = null
let pendingWaiters: ((outcome: ReconcileOutcome) => void)[] = []

/**
 * Reconcile, but never twice at once — a bug fix, not a nicety.
 *
 * The React host's effect legitimately re-runs several times within a second while a session settles:
 * the client arrives, then the session document, then the capability probe flips. Without a guard
 * those passes OVERLAP, and each one that finds no matching server subscription creates one and
 * destroys the other's — so they undo each other. Seen verbatim in Stalwart's request log
 * (2026-07-23, B29): `create` with one FCM endpoint, `destroy` of the previous id, and a second
 * `create` with a DIFFERENT endpoint, all inside three seconds. The subscription therefore never
 * settled, the verification code the service worker had parked never matched the subscription that
 * currently existed, and the handshake could not close.
 *
 * Waiting passes are COALESCED to the latest: several queued callers share one later run, because
 * they would otherwise each redo the same work against the same final state.
 */
export function reconcilePush(deps: ReconcileDeps): Promise<ReconcileOutcome> {
  if (inFlight !== null) {
    pendingDeps = deps // latest wins
    return new Promise<ReconcileOutcome>((resolve) => pendingWaiters.push(resolve))
  }
  return startPass(deps)
}

function startPass(deps: ReconcileDeps): Promise<ReconcileOutcome> {
  const run = reconcilePushSubscription(deps)
  inFlight = run.catch(() => undefined)
  void run
    .catch(() => 'failed' as ReconcileOutcome)
    .then(() => {
      inFlight = null
      const next = pendingDeps
      const waiters = pendingWaiters
      pendingDeps = null
      pendingWaiters = []
      if (next === null) return
      void startPass(next).then(
        (outcome) => {
          for (const resolve of waiters) resolve(outcome)
        },
        () => {
          for (const resolve of waiters) resolve('failed')
        },
      )
    })
  return run
}

/** Test seam: forget any in-flight/queued pass between cases. */
export function resetReconcileSerialisation(): void {
  inFlight = null
  pendingDeps = null
  pendingWaiters = []
}

/**
 * The `emailPush` configuration for this session (`draft-ietf-jmap-emailpush-03`).
 *
 * **`null` is reserved for one thing only: the server does not advertise the capability.** Then the
 * property is never mentioned — not in the body, not in `using` — and Waxwing behaves exactly as the
 * build before this amendment did, which is the condition on running against any JMAP server.
 *
 * Everything else returns a request with an account list, EMPTY when there is nothing to configure:
 * the user's preview toggle is off, or the session names no primary mail account. An empty list is
 * not the same as no capability, and collapsing the two was the bug worth avoiding — a server that
 * understands `emailPush` and is holding one has to be TOLD to drop it, and that patch has to carry
 * the URN or the server will refuse it and go on sending subjects.
 *
 * The account is `primaryAccounts['…:mail']`, the one this client syncs (`SessionProvider.tsx`) and
 * the one the credentials certainly reach — Stalwart rejects the whole `set` with `invalidProperties`
 * if the map names an account they cannot see, which would take the subscription down with it. Other
 * reachable accounts are deliberately left out: their deliveries keep arriving as the plain
 * `StateChange` they always did, so they raise the contentless banner exactly as before. Adding them
 * changes what a shared mailbox puts on a lock screen, which is a product decision, not a loop.
 */
function emailPushRequest(session: Session, preview: boolean): EmailPushRequest | null {
  if (!hasCapability(session, Capabilities.emailPush)) return null
  if (!preview) return { accountIds: [] }
  const accountId = session.primaryAccounts[Capabilities.mail]
  if (accountId === undefined || accountId === '') return { accountIds: [] }
  return { accountIds: [accountId] }
}

export async function reconcilePushSubscription(deps: ReconcileDeps): Promise<ReconcileOutcome> {
  const idb = deps.idb ?? null
  if (deps.registration === null) return 'noServiceWorker'

  // An explicit "no" — the only thing that may destroy a subscription. `denied` is a decision the
  // browser has recorded. A master switch that is off is the user's decision — but ONLY once the
  // pref has loaded: while `prefsLoaded` is false the switch merely reads as its default (off), which
  // is not a decision and must not tear anything down. `default`/`unsupported` permission are not
  // decisions either. (See `prefsLoaded` — this conflation destroyed the subscription on every start.)
  if (deps.permission === 'denied' || (deps.prefsLoaded && !deps.enabled)) {
    await unsubscribePush({ registration: deps.registration, client: deps.client, idb })
    return 'unsubscribed'
  }

  // Everything below needs the pref loaded, a live client and a loaded session. Not having them is a
  // "come back later", never a teardown.
  if (!deps.prefsLoaded) return 'cannotAct'
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
    emailPush: emailPushRequest(deps.session, deps.preview),
    preview: deps.preview,
    unknownSender: deps.unknownSender,
    noSubject: deps.noSubject,
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
