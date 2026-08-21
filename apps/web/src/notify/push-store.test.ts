/**
 * The page → worker handover store (M4.0). Driven against `fake-indexeddb`, which is the real IDB
 * semantics rather than a mock of them — the point being that this store is read by a service worker
 * that cannot import Dexie, so the raw-IDB code IS the contract and not an implementation detail.
 *
 * The theme running through it: every read degrades to `null` and every optional write swallows its
 * failure, because the alternative on this path is a banner with `undefined` in it or a sign-out
 * that hangs on a database.
 */

import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearPendingVerification,
  clearPushState,
  deletePushRegistration,
  ensureDeviceClientId,
  type PushWorkerState,
  peekPendingVerification,
  putPendingVerification,
  readPushRegistration,
  readPushState,
  writePushRegistration,
  writePushState,
} from './push-store'

let idb: IDBFactory

beforeEach(() => {
  idb = new IDBFactory()
})

const state: PushWorkerState = {
  deviceClientId: 'waxwing-device-1',
  title: 'Waxwing',
  body: 'Neue Nachricht',
  iconUrl: 'https://mail.example/branding/icon-192.png',
  badgeUrl: 'https://mail.example/branding/icon-192.png',
  quietHours: { fromMinutes: 22 * 60, toMinutes: 7 * 60 },
  sound: true,
  preview: true,
  unknownSender: 'Unbekannter Absender',
  noSubject: '(kein Betreff)',
}

describe('the worker state', () => {
  it('round-trips what the page wrote', async () => {
    await writePushState(state, idb)
    expect(await readPushState(idb)).toEqual(state)
  })

  it('is null before the page has ever written one', async () => {
    expect(await readPushState(idb)).toBeNull()
  })

  /**
   * This record outlives deploys. A build that adds a field reads records written by the build
   * before it, and a half-shaped one must degrade to "no state" — which shows NO banner — rather
   * than to a banner with `undefined` where the text should be.
   */
  it('degrades a half-shaped record to null rather than rendering it', async () => {
    const db = await open(idb)
    for (const bad of [
      null,
      'nope',
      42,
      {},
      { ...state, deviceClientId: '' },
      { ...state, title: undefined },
      { ...state, body: 42 },
      { ...state, iconUrl: null },
    ]) {
      await put(db, bad, 'state')
      expect(await readPushState(idb)).toBeNull()
    }
    db.close()
  })

  it('reads a missing quietHours as "off" and a missing sound as ON', async () => {
    const db = await open(idb)
    const { quietHours: _q, sound: _s, ...rest } = state
    await put(db, rest, 'state')
    db.close()
    const read = await readPushState(idb)
    expect(read?.quietHours).toBeNull()
    // A stored record that predates the sound toggle must not silence every banner.
    expect(read?.sound).toBe(true)
  })

  it('reads sound:false back as false — the toggle has to survive the round trip', async () => {
    await writePushState({ ...state, sound: false }, idb)
    expect((await readPushState(idb))?.sound).toBe(false)
  })

  /**
   * **The asymmetry with `sound` above is the point, and it is a privacy rule.**
   *
   * A record written by the build before content pushes existed has no `preview` field at all.
   * Reading that silence as "yes, show sender and subject" would put a subject on a lock screen on
   * the strength of a field nobody ever wrote. Silence about a privacy switch is not consent — so
   * `sound` defaults ON (an absent field must not silence every banner) and `preview` defaults OFF.
   */
  it('reads a missing preview as OFF, unlike sound — silence is not consent', async () => {
    const db = await open(idb)
    const { preview: _p, unknownSender: _u, noSubject: _n, ...rest } = state
    await put(db, rest, 'state')
    db.close()
    const read = await readPushState(idb)
    expect(read?.preview).toBe(false)
    // …and the two strings the content banner needs fall back to the CONTENTLESS wording, which is
    // translated and always present, rather than to an English literal the worker cannot translate.
    expect(read?.unknownSender).toBe(state.title)
    expect(read?.noSubject).toBe(state.body)
  })

  it('round-trips preview:true and the two fallback strings', async () => {
    await writePushState(state, idb)
    const read = await readPushState(idb)
    expect(read?.preview).toBe(true)
    expect(read?.unknownSender).toBe('Unbekannter Absender')
    expect(read?.noSubject).toBe('(kein Betreff)')
  })

  /** Likewise for the registration: a record from before this feature says the server holds none. */
  it('reads a registration with no emailPush field as "the server holds none"', async () => {
    const db = await open(idb)
    await put(
      db,
      { subscriptionId: 'sub-1', endpoint: 'e', applicationServerKey: 'k', expires: null },
      'registration',
    )
    db.close()
    expect((await readPushRegistration(idb))?.emailPush).toBe(false)
  })

  it('returns null instead of throwing when there is no IndexedDB at all', async () => {
    // The worker on a browser where IDB is unavailable (private mode on some engines). No banner is
    // the right answer; an unhandled rejection inside `push` is not.
    expect(await readPushState(null as unknown as IDBFactory)).toBeNull()
  })
})

describe('the device client id', () => {
  it('mints once and returns the same value forever after', async () => {
    let minted = 0
    const mint = () => `device-${String(++minted)}`
    const first = await ensureDeviceClientId(mint, idb)
    expect(first).toBe('device-1')
    expect(await ensureDeviceClientId(mint, idb)).toBe('device-1')
    expect(await ensureDeviceClientId(mint, idb)).toBe('device-1')
    expect(minted).toBe(1)
  })

  /**
   * It must outlive a subscription, which is why it is its own record. A client that mints a fresh
   * id per launch leaves the server accumulating dead subscriptions, one per start, each pushing to
   * an endpoint nobody listens to.
   */
  it('survives the registration being deleted', async () => {
    const id = await ensureDeviceClientId(() => 'device-1', idb)
    await writePushRegistration(
      {
        subscriptionId: 's',
        endpoint: 'e',
        applicationServerKey: 'k',
        expires: null,
        emailPush: false,
      },
      idb,
    )
    await deletePushRegistration(idb)
    expect(await ensureDeviceClientId(() => 'device-2', idb)).toBe(id)
  })

  it('is wiped by clearPushState — a shared machine must not inherit an identity', async () => {
    await ensureDeviceClientId(() => 'device-1', idb)
    await clearPushState(idb)
    expect(await ensureDeviceClientId(() => 'device-2', idb)).toBe('device-2')
  })
})

describe('the registration record', () => {
  const record = {
    subscriptionId: 'sub-1',
    endpoint: 'https://push.example/e/1',
    applicationServerKey: 'BLjc',
    expires: '2026-07-30T04:55:11Z',
    emailPush: false,
  }

  it('round-trips', async () => {
    await writePushRegistration(record, idb)
    expect(await readPushRegistration(idb)).toEqual(record)
  })

  it('reads a malformed record as null, which forces a fresh create', async () => {
    const db = await open(idb)
    for (const bad of [null, {}, { ...record, subscriptionId: '' }, { ...record, endpoint: 7 }]) {
      await put(db, bad, 'registration')
      expect(await readPushRegistration(idb)).toBeNull()
    }
    db.close()
  })

  it('normalises a non-string expires to null rather than to a date that cannot be parsed', async () => {
    const db = await open(idb)
    await put(db, { ...record, expires: 12345 }, 'registration')
    db.close()
    expect((await readPushRegistration(idb))?.expires).toBeNull()
  })
})

describe('the parked verification', () => {
  /**
   * **Reading no longer consumes it, and that is a bug fix.** The first version deleted on read,
   * reasoning that a code which fails to write back is worthless. That is wrong in the one case
   * that matters: the write-back fails when the device is OFFLINE, and the code is then still
   * perfectly good — dropping it strands the subscription unverified until something recreates it.
   */
  it('survives being read, and is only consumed on an explicit clear', async () => {
    await putPendingVerification({ pushSubscriptionId: 'sub-1', verificationCode: 'code' }, idb)
    const expected = { pushSubscriptionId: 'sub-1', verificationCode: 'code' }
    expect(await peekPendingVerification(idb)).toEqual(expected)
    // Still there — an offline write-back must be retryable.
    expect(await peekPendingVerification(idb)).toEqual(expected)

    await clearPendingVerification(idb)
    expect(await peekPendingVerification(idb)).toBeNull()
  })

  it('is null when the worker never parked one', async () => {
    expect(await peekPendingVerification(idb)).toBeNull()
  })

  it('never throws when there is no IndexedDB', async () => {
    await expect(
      putPendingVerification(
        { pushSubscriptionId: 'a', verificationCode: 'b' },
        null as unknown as IDBFactory,
      ),
    ).resolves.toBeUndefined()
  })
})

describe('clearPushState', () => {
  it('removes everything, so a sign-out leaves nothing behind', async () => {
    await writePushState(state, idb)
    await writePushRegistration(
      {
        subscriptionId: 's',
        endpoint: 'e',
        applicationServerKey: 'k',
        expires: null,
        emailPush: false,
      },
      idb,
    )
    await putPendingVerification({ pushSubscriptionId: 's', verificationCode: 'c' }, idb)

    await clearPushState(idb)

    expect(await readPushState(idb)).toBeNull()
    expect(await readPushRegistration(idb)).toBeNull()
    expect(await peekPendingVerification(idb)).toBeNull()
  })

  it('resolves rather than throwing when there is no IndexedDB — a sign-out is never blocked', async () => {
    await expect(clearPushState(null as unknown as IDBFactory)).resolves.toBeUndefined()
  })
})

/** Write a raw value past the store's own validation, to test what it does with what it finds. */
function open(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open('waxwing-push', 1)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains('state')) db.createObjectStore('state')
    }
    request.onsuccess = () => {
      resolve(request.result)
    }
    request.onerror = () => {
      reject(request.error ?? new Error('open failed'))
    }
  })
}

function put(db: IDBDatabase, value: unknown, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('state', 'readwrite')
    tx.objectStore('state').put(value, key)
    tx.oncomplete = () => {
      resolve()
    }
    tx.onerror = () => {
      reject(tx.error ?? new Error('put failed'))
    }
  })
}
