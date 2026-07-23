/**
 * The page → service-worker handover for Web Push (M4.0, FR-NOTIF-02) — DOM-free, raw IndexedDB.
 *
 * **Why not the replica.** `sync/db.ts` is Dexie, versioned, account-scoped and reaches half the
 * app; importing it into `sw.ts` would break the worker's own program (`tsconfig.sw.json`) and put
 * Dexie in a bundle every visitor downloads. This is a deliberately tiny, separate database with one
 * store and two records — a contract, not a second copy of the replica.
 *
 * **Why the banner text lives here.** The worker cannot run i18next: it has no DOM, no locale
 * detection and no business carrying two translation catalogues. So the PAGE writes the already
 * translated strings, and the worker renders what it is given. That is what keeps "no hardcoded
 * user-visible strings" true on a code path that cannot translate anything — and it is why
 * {@link writePushState} must be called again when the language changes, not only on subscribe.
 *
 * **What is deliberately NOT here: the master switch and the folder list.** Turning notifications off
 * destroys the subscription server-side, so "off" is enforced by the server having nothing to push
 * to, which no stale local record can contradict. Per-folder filtering is not here because it cannot
 * be: an `EmailDelivery` state change names no mailbox (ADR-017).
 */

import type { QuietHours } from './quiet-hours'

const DB_NAME = 'waxwing-push'
const DB_VERSION = 1
const STORE = 'state'
const STATE_KEY = 'state'
const VERIFICATION_KEY = 'verification'
const REGISTRATION_KEY = 'registration'
const DEVICE_KEY = 'deviceClientId'

/** Everything the worker needs to raise one contentless banner without asking anybody. */
export interface PushWorkerState {
  /**
   * The stable `deviceClientId` this installation registers under (RFC 8620 §7.2). Persisted so a
   * reload replaces its own subscription instead of accumulating one per launch.
   */
  readonly deviceClientId: string
  /** Already translated by the page — see the header. */
  readonly title: string
  /** Already translated by the page. Says that mail arrived and nothing about it (ADR-017). */
  readonly body: string
  /** Absolute URLs; the worker cannot resolve `document.baseURI`. */
  readonly iconUrl: string
  readonly badgeUrl: string
  /** `null` = quiet hours off. Applied by the worker exactly as the live channel applies it. */
  readonly quietHours: QuietHours | null
  /** `silent: !sound`. */
  readonly sound: boolean
}

/**
 * The verification code the server pushed (RFC 8620 §7.2.2), parked for the page.
 *
 * The worker cannot write it back itself — that needs an authenticated JMAP call, which is exactly
 * what M4.0 keeps out of the worker (ADR-017). Normally the page is open when a subscription is
 * created and gets the code by `postMessage`; this record is the path for when it is not, and the
 * page drains it on its next start.
 */
export interface PendingVerification {
  readonly pushSubscriptionId: string
  readonly verificationCode: string
}

/**
 * The PAGE's bookkeeping about the subscription it registered. The worker never reads this.
 *
 * It exists because the two halves of a subscription can drift apart independently and neither half
 * can report it: `PushSubscription/get` returns `keys: null` by design and tells us nothing about
 * the endpoint, while the browser will hand out a NEW endpoint after a push-service rotation or a
 * `clearSiteData` without ever saying the old one is gone. Comparing against what we last stored is
 * the only way to notice, and noticing is the difference between "notifications quietly stopped" and
 * "notifications were re-registered".
 */
export interface PushRegistrationRecord {
  /** The JMAP `PushSubscription` id. */
  readonly subscriptionId: string
  /** The browser endpoint this subscription was created for. A change means: destroy and recreate. */
  readonly endpoint: string
  /** The VAPID key it was created against. A server that rotates its key invalidates the endpoint. */
  readonly applicationServerKey: string
  /** What the server GRANTED (not what we asked for) — the renewal clock. `null` = never expires. */
  readonly expires: string | null
}

/** Injectable so tests can drive `fake-indexeddb` and the worker can pass its own global. */
export type IdbFactoryLike = IDBFactory

function defaultFactory(): IDBFactory | null {
  return typeof indexedDB === 'undefined' ? null : indexedDB
}

function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    request.onsuccess = () => {
      resolve(request.result)
    }
    request.onerror = () => {
      reject(request.error ?? new Error('waxwing-push: open failed'))
    }
    // A concurrent tab holding an older version open. Nothing to do but fail — the caller treats a
    // rejection as "no state", which degrades to no banner rather than to a wrong one.
    request.onblocked = () => {
      reject(new Error('waxwing-push: blocked'))
    }
  })
}

async function withStore<T>(
  mode: IDBTransactionMode,
  factory: IDBFactory | null,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const idb = factory ?? defaultFactory()
  if (idb === null) throw new Error('waxwing-push: no IndexedDB')
  const db = await openDb(idb)
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode)
      const request = fn(tx.objectStore(STORE))
      request.onsuccess = () => {
        resolve(request.result)
      }
      request.onerror = () => {
        reject(request.error ?? new Error('waxwing-push: request failed'))
      }
      tx.onabort = () => {
        reject(tx.error ?? new Error('waxwing-push: aborted'))
      }
    })
  } finally {
    db.close()
  }
}

function isQuietHours(value: unknown): value is QuietHours {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.fromMinutes === 'number' && typeof v.toMinutes === 'number'
}

/**
 * Validate what came back out of the database.
 *
 * Not paranoia about our own writes: this record outlives deploys. A build that adds a field reads
 * records written by the build before it, and a half-shaped record must degrade to "no state" —
 * which shows no banner — rather than to a banner with `undefined` in it.
 */
function coercePushState(value: unknown): PushWorkerState | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (typeof v.deviceClientId !== 'string' || v.deviceClientId === '') return null
  if (typeof v.title !== 'string' || typeof v.body !== 'string') return null
  if (typeof v.iconUrl !== 'string' || typeof v.badgeUrl !== 'string') return null
  return {
    deviceClientId: v.deviceClientId,
    title: v.title,
    body: v.body,
    iconUrl: v.iconUrl,
    badgeUrl: v.badgeUrl,
    quietHours: isQuietHours(v.quietHours) ? v.quietHours : null,
    sound: v.sound !== false,
  }
}

/** The worker's read. `null` for "nothing usable stored" — including every failure mode. */
export async function readPushState(
  factory: IDBFactory | null = null,
): Promise<PushWorkerState | null> {
  try {
    return coercePushState(await withStore('readonly', factory, (store) => store.get(STATE_KEY)))
  } catch {
    return null
  }
}

/** The page's write. Throws — the caller is the subscribe flow, which reports failures. */
export async function writePushState(
  state: PushWorkerState,
  factory: IDBFactory | null = null,
): Promise<void> {
  await withStore('readwrite', factory, (store) => store.put(state, STATE_KEY))
}

/** The worker parks a verification code it cannot write back itself. Never throws. */
export async function putPendingVerification(
  verification: PendingVerification,
  factory: IDBFactory | null = null,
): Promise<void> {
  try {
    await withStore('readwrite', factory, (store) => store.put(verification, VERIFICATION_KEY))
  } catch {
    /* a parked code is best-effort; the page re-subscribes if verification never completes */
  }
}

/**
 * Read the parked code WITHOUT consuming it.
 *
 * It used to be a read-and-delete, on the reasoning that a code which fails to write back is
 * worthless anyway. That was wrong in the one case that matters: the write-back can fail because the
 * device is offline, and then the code is still perfectly good — deleting it turns a retryable
 * situation into a subscription that stays unverified until something recreates it. So the delete
 * is now explicit, and only happens once the server has accepted it (or the subscription it belongs
 * to has been replaced).
 */
export async function peekPendingVerification(
  factory: IDBFactory | null = null,
): Promise<PendingVerification | null> {
  try {
    const raw: unknown = await withStore('readonly', factory, (store) =>
      store.get(VERIFICATION_KEY),
    )
    if (typeof raw !== 'object' || raw === null) return null
    const v = raw as Record<string, unknown>
    if (typeof v.pushSubscriptionId !== 'string' || typeof v.verificationCode !== 'string') {
      return null
    }
    return { pushSubscriptionId: v.pushSubscriptionId, verificationCode: v.verificationCode }
  } catch {
    return null
  }
}

/** Forget the parked code: the server accepted it, or its subscription no longer exists. */
export async function clearPendingVerification(factory: IDBFactory | null = null): Promise<void> {
  try {
    await withStore('readwrite', factory, (store) => store.delete(VERIFICATION_KEY))
  } catch {
    /* a stale code costs one redundant update on the next start, nothing more */
  }
}

/**
 * The stable `deviceClientId` for this installation — read once, minted once, then never again.
 *
 * It has to outlive every subscription: RFC 8620 §7.2 uses it to recognise a returning device, and
 * a client that mints a fresh one per launch leaves the server accumulating dead subscriptions, each
 * pushing to an endpoint nobody listens to. That is why it is its own record rather than a field on
 * the registration, which is deleted whenever a subscription is torn down.
 *
 * Falls back to a transient id when there is no IndexedDB. Not silently: without persistence there
 * is no stable identity to have, and a transient one at least subscribes successfully this session.
 */
export async function ensureDeviceClientId(
  mint: () => string,
  factory: IDBFactory | null = null,
): Promise<string> {
  try {
    const existing: unknown = await withStore('readonly', factory, (store) => store.get(DEVICE_KEY))
    if (typeof existing === 'string' && existing !== '') return existing
  } catch {
    return mint()
  }
  const minted = mint()
  try {
    await withStore('readwrite', factory, (store) => store.put(minted, DEVICE_KEY))
  } catch {
    /* usable this session; the next start mints another and the server replaces the stale row */
  }
  return minted
}

function coerceRegistration(value: unknown): PushRegistrationRecord | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (typeof v.subscriptionId !== 'string' || v.subscriptionId === '') return null
  if (typeof v.endpoint !== 'string' || typeof v.applicationServerKey !== 'string') return null
  return {
    subscriptionId: v.subscriptionId,
    endpoint: v.endpoint,
    applicationServerKey: v.applicationServerKey,
    expires: typeof v.expires === 'string' ? v.expires : null,
  }
}

/** What we last registered, or `null` — including every failure mode, which forces a fresh create. */
export async function readPushRegistration(
  factory: IDBFactory | null = null,
): Promise<PushRegistrationRecord | null> {
  try {
    return coerceRegistration(
      await withStore('readonly', factory, (store) => store.get(REGISTRATION_KEY)),
    )
  } catch {
    return null
  }
}

export async function writePushRegistration(
  record: PushRegistrationRecord,
  factory: IDBFactory | null = null,
): Promise<void> {
  await withStore('readwrite', factory, (store) => store.put(record, REGISTRATION_KEY))
}

/** Never throws: it runs on paths that are already tearing a subscription down. */
export async function deletePushRegistration(factory: IDBFactory | null = null): Promise<void> {
  try {
    await withStore('readwrite', factory, (store) => store.delete(REGISTRATION_KEY))
  } catch {
    /* nothing to undo — the next ensure() creates a fresh subscription anyway */
  }
}

/**
 * Forget everything (sign-out, or the master switch going off).
 *
 * Deleting the whole database rather than the records: it holds nothing worth migrating, and a
 * deleted database cannot leave a stale `deviceClientId` behind for the next user of a shared
 * machine to re-register under. Never throws — a sign-out is never blocked by this.
 */
export async function clearPushState(factory: IDBFactory | null = null): Promise<void> {
  const idb = factory ?? defaultFactory()
  if (idb === null) return
  await new Promise<void>((resolve) => {
    const request = idb.deleteDatabase(DB_NAME)
    request.onsuccess = () => {
      resolve()
    }
    request.onerror = () => {
      resolve()
    }
    // Another tab has it open. The records left behind are inert without a subscription to match,
    // and blocking a sign-out on another tab's lifecycle would be worse.
    request.onblocked = () => {
      resolve()
    }
  })
}
