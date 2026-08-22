/**
 * The subscribe flow (M4.0) — the half that touches PushManager, JMAP and the store.
 *
 * Two properties are asserted over and over, and they are the ones an owner decision turned on:
 *
 *  1. **The renewal actually happens.** Stalwart grants seven days and refuses more; if the pass
 *     that runs on every start does not renew, background notifications lapse in silence a week
 *     later — long after anyone would connect it to a change made today.
 *  2. **`types: ["EmailDelivery"]` is on every create.** Drop it and the server pushes on every
 *     `Email` state change, so the app buzzes when the user reads a message on their phone. Worse,
 *     it would also mean the worker could no longer trust a push to mean "mail arrived", which is
 *     the entire reason it needs no token (ADR-017).
 */

import type { JmapClient } from '@waxwing/jmap'
import { MethodResponses } from '@waxwing/jmap'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ensureDeviceClientId,
  peekPendingVerification,
  putPendingVerification,
  readPushRegistration,
  readPushState,
  writePushRegistration,
  writePushState,
} from './push-store'
import type { BrowserPushSubscription, PushCapableRegistration } from './push-subscribe'
import {
  ensurePushSubscription,
  newDeviceClientId,
  submitPushVerification,
  tearDownPushSubscription,
  unsubscribePush,
} from './push-subscribe'

const KEY =
  'BLjc7wAlpyEjBJLAhjRWZ5O_g4HspzJGSgk8iUmmqzCFZ8fcHRA0AghHk3KaVU9EJuC-y2yYTBt25bnLw3rylew'
const ENDPOINT = 'https://push.example/endpoint/abc'
const NOW = Date.parse('2026-07-23T12:00:00Z')
const FAR = new Date(NOW + 7 * 24 * 60 * 60 * 1000).toISOString()

let idb: IDBFactory

beforeEach(() => {
  idb = new IDBFactory()
})

// --- fakes ------------------------------------------------------------------------------------

function fakeSubscription(
  endpoint = ENDPOINT,
): BrowserPushSubscription & { unsubscribed: boolean } {
  const sub = {
    endpoint,
    unsubscribed: false,
    getKey: (name: 'p256dh' | 'auth') =>
      name === 'p256dh' ? new Uint8Array(65).fill(4).buffer : new Uint8Array(16).fill(7).buffer,
    unsubscribe: async () => {
      sub.unsubscribed = true
      return true
    },
  }
  return sub
}

interface FakeRegistration extends PushCapableRegistration {
  readonly subscribeCalls: { applicationServerKey: BufferSource; userVisibleOnly: boolean }[]
  current: BrowserPushSubscription | null
}

function fakeRegistration(existing: BrowserPushSubscription | null = null): FakeRegistration {
  const subscribeCalls: FakeRegistration['subscribeCalls'] = []
  const registration: FakeRegistration = {
    subscribeCalls,
    current: existing,
    pushManager: {
      getSubscription: async () => registration.current,
      subscribe: async (options) => {
        subscribeCalls.push(options)
        const created = fakeSubscription()
        registration.current = created
        return created
      },
    },
  }
  return registration
}

type Call = [name: string, args: Record<string, unknown>, id: string]

/** A JMAP client that answers `PushSubscription/get` from a list and records every call. */
function fakeClient(options: {
  list?: Record<string, unknown>[]
  onSet?: (args: Record<string, unknown>) => Record<string, unknown>
  throwOn?: string
}): JmapClient & { calls: Call[]; usingOf: (readonly string[] | undefined)[] } {
  const calls: Call[] = []
  // Recorded per INVOCATION, aligned with `calls`, because the `using` set is the difference between
  // a request a stock JMAP server answers and one it rejects outright (RFC 8620 §3.3), and the flow
  // makes several calls per pass — the last of them a bookkeeping `get` that carries none.
  const usingOf: (readonly string[] | undefined)[] = []
  let list = options.list ?? []
  const client = {
    calls,
    usingOf,
    async call(invocations: Call[], opts: { using?: readonly string[] } = {}) {
      const responses: Call[] = []
      for (const [name, args, id] of invocations) {
        calls.push([name, args, id])
        usingOf.push(opts.using)
        if (options.throwOn === name) throw new Error(`${name} failed`)
        if (name === 'PushSubscription/get') {
          responses.push(['PushSubscription/get', { list, notFound: [] }, id])
        } else {
          const result = options.onSet?.(args) ?? {
            created: {
              sub: { id: 'sub-1', deviceClientId: String(args.create ?? ''), expires: FAR },
            },
          }
          // Mirror the server: what was created shows up in the next `get`.
          const created = (result.created ?? null) as Record<string, { id: string }> | null
          if (created !== null) {
            const first = Object.values(created)[0]
            const createArgs = (args.create ?? {}) as Record<string, Record<string, unknown>>
            const body = Object.values(createArgs)[0] ?? {}
            if (first !== undefined) {
              list = [
                ...list.filter((row) => row.id !== first.id),
                { ...first, deviceClientId: body.deviceClientId, types: body.types, expires: FAR },
              ]
            }
          }
          const destroy = args.destroy as string[] | undefined
          if (destroy !== undefined)
            list = list.filter((row) => !destroy.includes(row.id as string))
          responses.push(['PushSubscription/set', result, id])
        }
      }
      return new MethodResponses(responses, 'state-1', undefined)
    },
  }
  return client as unknown as JmapClient & {
    calls: Call[]
    usingOf: (readonly string[] | undefined)[]
  }
}

function deps(
  registration: PushCapableRegistration,
  client: JmapClient,
  over: Record<string, unknown> = {},
) {
  return {
    registration,
    client,
    applicationServerKey: KEY,
    deviceClientId: 'waxwing-device-1',
    title: 'Waxwing',
    body: 'New message',
    iconUrl: 'https://mail.example/branding/icon-192.png',
    badgeUrl: 'https://mail.example/branding/icon-192.png',
    quietHours: null,
    sound: true,
    // The DEFAULT in this file is a server WITHOUT `urn:ietf:params:jmap:emailpush`, so every case
    // below asserts the unchanged, contentless behaviour that must survive the amendment. The
    // content path is opted into per test and lives in its own `describe`.
    emailPush: null,
    preview: true,
    unknownSender: 'Unknown sender',
    noSubject: '(no subject)',
    now: () => NOW,
    idb,
    ...over,
  }
}

const setCalls = (client: { calls: Call[] }) =>
  client.calls.filter(([name]) => name === 'PushSubscription/set')

/** The `using` extension of the first `PushSubscription/set` — the only call that may carry one. */
const setUsing = (client: { calls: Call[]; usingOf: (readonly string[] | undefined)[] }) => {
  const index = client.calls.findIndex(([name]) => name === 'PushSubscription/set')
  return index === -1 ? undefined : client.usingOf[index]
}

// --- the flow ---------------------------------------------------------------------------------

describe('ensurePushSubscription — a first subscribe', () => {
  it('subscribes, registers with the server and writes the worker handover', async () => {
    const registration = fakeRegistration()
    const client = fakeClient({})

    const result = await ensurePushSubscription(deps(registration, client))

    expect(result).toEqual({ status: 'subscribed', subscriptionId: 'sub-1' })
    expect(await readPushRegistration(idb)).toEqual({
      subscriptionId: 'sub-1',
      endpoint: ENDPOINT,
      applicationServerKey: KEY,
      expires: FAR,
      emailPush: false,
    })
    const state = await readPushState(idb)
    expect(state?.title).toBe('Waxwing')
    expect(state?.body).toBe('New message')
  })

  /** The property the security argument rests on: the server filters, so the worker asks nobody. */
  it('always creates with types: ["EmailDelivery"]', async () => {
    const client = fakeClient({})
    await ensurePushSubscription(deps(fakeRegistration(), client))

    const [, args] = setCalls(client)[0] ?? []
    const create = (args?.create ?? {}) as Record<string, Record<string, unknown>>
    expect(Object.values(create)[0]?.types).toEqual(['EmailDelivery'])
  })

  it('subscribes with userVisibleOnly and the decoded application server key', async () => {
    const registration = fakeRegistration()
    await ensurePushSubscription(deps(registration, fakeClient({})))

    const call = registration.subscribeCalls[0]
    expect(call?.userVisibleOnly).toBe(true)
    // 65 bytes, uncompressed-point marker — not the base64 string handed through untouched.
    expect((call?.applicationServerKey as Uint8Array).byteLength).toBe(65)
    expect((call?.applicationServerKey as Uint8Array)[0]).toBe(0x04)
  })

  it('reads the GRANTED expiry back rather than trusting what it asked for', async () => {
    // The server shortens: this is the seven-day cap, and the renewal clock has to run on it.
    const client = fakeClient({})
    await ensurePushSubscription(deps(fakeRegistration(), client))
    expect((await readPushRegistration(idb))?.expires).toBe(FAR)
  })
})

describe('ensurePushSubscription — an existing subscription', () => {
  async function withStored(over: Record<string, unknown> = {}) {
    await writePushRegistration(
      {
        subscriptionId: 'sub-1',
        endpoint: ENDPOINT,
        applicationServerKey: KEY,
        expires: FAR,
        emailPush: false,
        ...over,
      },
      idb,
    )
  }

  it('does nothing when it is healthy', async () => {
    await withStored()
    const client = fakeClient({
      list: [{ id: 'sub-1', deviceClientId: 'waxwing-device-1', expires: FAR }],
    })
    const result = await ensurePushSubscription(deps(fakeRegistration(fakeSubscription()), client))

    expect(result).toEqual({ status: 'subscribed', subscriptionId: 'sub-1' })
    expect(setCalls(client)).toHaveLength(0)
  })

  /**
   * The case that decides whether this feature survives a week. Without it the subscription simply
   * stops, and the first sign is a user saying notifications "just stopped working" days later.
   */
  it('renews when the grant is inside the margin', async () => {
    const soon = new Date(NOW + 60_000).toISOString()
    await withStored({ expires: soon })
    const client = fakeClient({
      list: [{ id: 'sub-1', deviceClientId: 'waxwing-device-1', expires: soon }],
      onSet: () => ({ updated: { 'sub-1': null } }),
    })

    await ensurePushSubscription(deps(fakeRegistration(fakeSubscription()), client))

    const [, args] = setCalls(client)[0] ?? []
    const update = (args?.update ?? {}) as Record<string, Record<string, unknown>>
    expect(typeof update['sub-1']?.expires).toBe('string')
  })

  it('recreates and destroys the stale row when the browser endpoint changed', async () => {
    await withStored({ endpoint: 'https://push.example/endpoint/OLD' })
    const client = fakeClient({
      list: [{ id: 'sub-1', deviceClientId: 'waxwing-device-1', expires: FAR }],
    })

    await ensurePushSubscription(deps(fakeRegistration(fakeSubscription()), client))

    const [, args] = setCalls(client)[0] ?? []
    expect(args?.destroy).toEqual(['sub-1'])
    expect(args?.create).toBeDefined()
  })

  /**
   * An endpoint is bound to the VAPID key it was minted against (RFC 8292 §4.2). The old one still
   * answers `getSubscription()` and every push to it is rejected — so the BROWSER subscription has
   * to be replaced too, not only the server row.
   */
  it('unsubscribes the browser when the server rotated its VAPID key', async () => {
    await withStored({ applicationServerKey: 'B-old-key' })
    const existing = fakeSubscription()
    const registration = fakeRegistration(existing)
    const client = fakeClient({
      list: [{ id: 'sub-1', deviceClientId: 'waxwing-device-1', expires: FAR }],
    })

    await ensurePushSubscription(deps(registration, client))

    expect(existing.unsubscribed).toBe(true)
    expect(registration.subscribeCalls).toHaveLength(1)
  })

  it('creates afresh when the server no longer lists our subscription', async () => {
    await withStored()
    const client = fakeClient({ list: [] })

    await ensurePushSubscription(deps(fakeRegistration(fakeSubscription()), client))

    const [, args] = setCalls(client)[0] ?? []
    expect(args?.create).toBeDefined()
    // Nothing to destroy — it is already gone, and naming it would be a guaranteed `notDestroyed`.
    expect(args?.destroy).toBeUndefined()
  })
})

describe('ensurePushSubscription — failures', () => {
  it('reports `unsupported` when the browser refuses to subscribe', async () => {
    const registration = fakeRegistration()
    registration.pushManager.subscribe = () => Promise.reject(new Error('NotAllowedError'))

    const result = await ensurePushSubscription(deps(registration, fakeClient({})))
    expect(result).toEqual({ status: 'unsupported' })
  })

  it('reports `failed`, not `subscribed`, when the JMAP call throws', async () => {
    const client = fakeClient({ throwOn: 'PushSubscription/get' })
    const result = await ensurePushSubscription(deps(fakeRegistration(), client))
    expect(result.status).toBe('failed')
  })

  /**
   * A `notCreated` is a successful HTTP response carrying a refusal — the shape most likely to be
   * read as success. Stalwart answers exactly this way for a malformed key, which is how our own
   * live probe first failed.
   */
  it('reports `failed` when the server refuses the create', async () => {
    const client = fakeClient({
      onSet: () => ({
        created: null,
        notCreated: { sub: { type: 'invalidProperties', description: 'Invalid P-256 key' } },
      }),
    })
    const result = await ensurePushSubscription(deps(fakeRegistration(), client))

    expect(result.status).toBe('failed')
    expect(result.status === 'failed' && result.reason).toContain('invalidProperties')
    // And nothing was recorded, so the next pass retries rather than believing it is subscribed.
    expect(await readPushRegistration(idb)).toBeNull()
  })

  it('reports `failed` when the browser subscription carries no keys', async () => {
    const registration = fakeRegistration({
      ...fakeSubscription(),
      getKey: () => null,
    } as unknown as BrowserPushSubscription)

    const result = await ensurePushSubscription(deps(registration, fakeClient({})))
    expect(result.status).toBe('failed')
  })
})

describe('submitPushVerification', () => {
  it('writes the code back and reports success', async () => {
    const client = fakeClient({ onSet: () => ({ updated: { 'sub-1': null } }) })
    expect(await submitPushVerification(client, 'sub-1', 'code-1')).toBe(true)

    const [, args] = setCalls(client)[0] ?? []
    const update = (args?.update ?? {}) as Record<string, Record<string, unknown>>
    expect(update['sub-1']).toEqual({ verificationCode: 'code-1' })
  })

  /**
   * `notUpdated` is the silent case: the server accepted the request and refused the object. Reading
   * it as success would leave a subscription that never delivers, with the app sure it is fine.
   */
  it('reports failure when the server did not update it', async () => {
    const client = fakeClient({
      onSet: () => ({ updated: null, notUpdated: { 'sub-1': { type: 'notFound' } } }),
    })
    expect(await submitPushVerification(client, 'sub-1', 'code-1')).toBe(false)
  })

  it('reports failure instead of throwing when the call throws', async () => {
    const client = fakeClient({ throwOn: 'PushSubscription/set' })
    expect(await submitPushVerification(client, 'sub-1', 'code-1')).toBe(false)
  })
})

describe('unsubscribePush', () => {
  it('destroys the server row, unsubscribes the browser and forgets the registration', async () => {
    await writePushRegistration(
      {
        subscriptionId: 'sub-1',
        endpoint: ENDPOINT,
        applicationServerKey: KEY,
        expires: FAR,
        emailPush: false,
      },
      idb,
    )
    const existing = fakeSubscription()
    const client = fakeClient({ onSet: () => ({ destroyed: ['sub-1'] }) })

    await unsubscribePush({ registration: fakeRegistration(existing), client, idb })

    expect(setCalls(client)[0]?.[1].destroy).toEqual(['sub-1'])
    expect(existing.unsubscribed).toBe(true)
    expect(await readPushRegistration(idb)).toBeNull()
  })

  /**
   * Offline, or already signed out. The browser half still has to happen: leaving the browser
   * subscribed to a server row we could not delete is the one combination that keeps delivering.
   */
  it('still unsubscribes the browser when the JMAP call fails', async () => {
    await writePushRegistration(
      {
        subscriptionId: 'sub-1',
        endpoint: ENDPOINT,
        applicationServerKey: KEY,
        expires: FAR,
        emailPush: false,
      },
      idb,
    )
    const existing = fakeSubscription()
    const client = fakeClient({ throwOn: 'PushSubscription/set' })

    await unsubscribePush({ registration: fakeRegistration(existing), client, idb })

    expect(existing.unsubscribed).toBe(true)
    expect(await readPushRegistration(idb)).toBeNull()
  })

  it('is safe when there is nothing subscribed at all', async () => {
    await expect(
      unsubscribePush({ registration: fakeRegistration(null), client: fakeClient({}), idb }),
    ).resolves.toBeUndefined()
  })
})

describe('tearDownPushSubscription (sign-out)', () => {
  /**
   * A subscription outlives a sign-out on the SERVER, which knows nothing about it. Left in place,
   * this browser keeps waking up and announcing new mail for a mailbox nobody is signed into —
   * possibly to the next person at the machine.
   */
  /**
   * **Every record must be populated before this runs, and that is the whole point.**
   *
   * The first version of this test asserted `readPushState()` was null afterwards without ever
   * having written one — so it passed against a `tearDown` that wiped nothing, and a mutation run
   * caught it. `unsubscribePush` alone deletes only the REGISTRATION; what `clearPushState` adds is
   * the worker's handover record, the parked verification and the `deviceClientId`. Asserting the
   * difference requires all three to exist first.
   */
  it('destroys the subscription and wipes the whole store', async () => {
    await writePushRegistration(
      {
        subscriptionId: 'sub-1',
        endpoint: ENDPOINT,
        applicationServerKey: KEY,
        expires: FAR,
        emailPush: false,
      },
      idb,
    )
    await writePushState(
      {
        deviceClientId: 'waxwing-device-1',
        title: 'Waxwing',
        body: 'New message',
        iconUrl: 'https://mail.example/branding/icon-192.png',
        badgeUrl: 'https://mail.example/branding/icon-192.png',
        quietHours: null,
        sound: true,
        preview: true,
        unknownSender: 'Unknown sender',
        noSubject: '(no subject)',
      },
      idb,
    )
    await putPendingVerification({ pushSubscriptionId: 'sub-1', verificationCode: 'code' }, idb)
    const deviceId = await ensureDeviceClientId(() => 'device-before', idb)
    expect(await readPushState(idb)).not.toBeNull()

    const client = fakeClient({ onSet: () => ({ destroyed: ['sub-1'] }) })
    const existing = fakeSubscription()

    await tearDownPushSubscription({ registration: fakeRegistration(existing), client, idb })

    expect(setCalls(client)[0]?.[1].destroy).toEqual(['sub-1'])
    expect(existing.unsubscribed).toBe(true)
    expect(await readPushState(idb)).toBeNull()
    expect(await readPushRegistration(idb)).toBeNull()
    expect(await peekPendingVerification(idb)).toBeNull()
    // The identity goes too: the next user of a shared machine must not re-register as the last one.
    expect(await ensureDeviceClientId(() => 'device-after', idb)).not.toBe(deviceId)
  })

  it('never throws, even with no registration and no client', async () => {
    await expect(
      tearDownPushSubscription({ registration: null, client: null, idb }),
    ).resolves.toBeUndefined()
  })
})

describe('newDeviceClientId', () => {
  it('is namespaced and unique', () => {
    const a = newDeviceClientId()
    const b = newDeviceClientId()
    expect(a.startsWith('waxwing-')).toBe(true)
    expect(a).not.toBe(b)
  })

  it('falls back when crypto.randomUUID is unavailable', () => {
    const spy = vi
      .spyOn(globalThis, 'crypto', 'get')
      .mockReturnValue(undefined as unknown as Crypto)
    try {
      expect(newDeviceClientId().startsWith('waxwing-')).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })
})

// -----------------------------------------------------------------------------------------------
// draft-ietf-jmap-emailpush-03 (ADR-017 amendment, 2026-08-21)
// -----------------------------------------------------------------------------------------------

/** The configuration the measured probe sent and Stalwart v0.16.18 accepted, keyed by accountId. */
const WANTED_CONFIG = {
  b: { filter: null, properties: ['from', 'subject', 'preview', 'receivedAt'] },
}

const createBody = (client: { calls: Call[] }): Record<string, unknown> => {
  for (const [, args] of setCalls(client)) {
    const create = args.create as Record<string, Record<string, unknown>> | undefined
    const body = create === undefined ? undefined : Object.values(create)[0]
    if (body !== undefined) return body
  }
  return {}
}

describe('ensurePushSubscription — asking the server to put the message in the push', () => {
  it('sends the emailPush map, keyed by account, with only the properties a banner needs', async () => {
    const client = fakeClient({})
    await ensurePushSubscription(
      deps(fakeRegistration(), client, { emailPush: { accountIds: ['b'] } }),
    )
    expect(createBody(client).emailPush).toEqual(WANTED_CONFIG)
  })

  /**
   * **`filter: null` is a decision, not an omission.**
   *
   * A server-side filter would let the per-folder preference finally apply while the app is closed
   * and would save the device every push it does not want. It would also mean a non-matching
   * delivery produces NO push at all — not even a `StateChange` (measured, v0.16.18) — so this
   * channel would go blind for every message outside the chosen folders. Waxwing does not use the
   * channel to drive sync today; making it unable to is a bigger step than a battery saving, and the
   * ADR-017 amendment records it as deferred rather than taken.
   */
  it('never sends a filter — the channel must not go blind for a folder', async () => {
    const client = fakeClient({})
    await ensurePushSubscription(
      deps(fakeRegistration(), client, { emailPush: { accountIds: ['b'] } }),
    )
    const map = createBody(client).emailPush as Record<string, { filter: unknown } | undefined>
    expect(map.b?.filter).toBeNull()
  })

  /**
   * RFC 8620 §3.3: a server MUST fail the whole request when `using` names a capability it does not
   * implement. `PushSubscription/*` is core, so nothing derives this URN from the method name — it
   * has to be opted into per call, and only on the call that actually carries the property.
   */
  it('adds the emailpush URN to `using`, and ONLY when the property is sent', async () => {
    const withContent = fakeClient({})
    await ensurePushSubscription(
      deps(fakeRegistration(), withContent, { emailPush: { accountIds: ['b'] } }),
    )
    expect(setUsing(withContent)).toEqual(['urn:ietf:params:jmap:emailpush'])

    const without = fakeClient({})
    await ensurePushSubscription(deps(fakeRegistration(), without, { emailPush: null }))
    for (const using of without.usingOf) expect(using).toBeUndefined()
  })

  /**
   * The portability guarantee, asserted as an ABSENCE. A server without the draft must see the
   * request the previous build sent — `emailPush: null` in the body would be a property it does not
   * know, and RFC 8620 §3.3 lets it reject the lot.
   */
  it('omits the property entirely against a server that does not offer it', async () => {
    const client = fakeClient({})
    await ensurePushSubscription(deps(fakeRegistration(), client, { emailPush: null }))
    expect(Object.hasOwn(createBody(client), 'emailPush')).toBe(false)
    expect(createBody(client)).toEqual({
      deviceClientId: 'waxwing-device-1',
      url: ENDPOINT,
      keys: { p256dh: expect.any(String), auth: expect.any(String) },
      types: ['EmailDelivery'],
    })
  })

  /**
   * A capable server, nothing to configure (the preview toggle is off, or the session names no
   * primary mail account). A CREATE says nothing: absent already is the default, and sending
   * `emailPush: null` would spend the URN on a no-op.
   */
  it('sends no map on a create when there is nothing to configure', async () => {
    const client = fakeClient({})
    await ensurePushSubscription(
      deps(fakeRegistration(), client, { emailPush: { accountIds: [] } }),
    )
    expect(Object.hasOwn(createBody(client), 'emailPush')).toBe(false)
  })

  it('remembers what the server was told, so the next pass can notice a change', async () => {
    const client = fakeClient({})
    await ensurePushSubscription(
      deps(fakeRegistration(), client, { emailPush: { accountIds: ['b'] } }),
    )
    expect((await readPushRegistration(idb))?.emailPush).toBe(true)
  })

  /**
   * The privacy switch going off, on a subscription that is otherwise perfectly healthy. `null`
   * REMOVES the configuration — leaving it in place would keep subjects arriving on a device whose
   * owner has just said they do not want them, with nothing anywhere to report it.
   */
  it('clears the configuration server-side when the preview toggle goes off', async () => {
    await writePushRegistration(
      {
        subscriptionId: 'sub-1',
        endpoint: ENDPOINT,
        applicationServerKey: KEY,
        expires: FAR,
        emailPush: true,
      },
      idb,
    )
    const client = fakeClient({
      list: [{ id: 'sub-1', deviceClientId: 'waxwing-device-1', expires: FAR }],
    })

    await ensurePushSubscription(
      deps(fakeRegistration(fakeSubscription()), client, {
        // Capability present, nothing wanted — the case a `null` would have flattened into "server
        // does not support it", which is exactly how the patch below would have been lost.
        emailPush: { accountIds: [] },
        preview: false,
      }),
    )

    const [, args] = setCalls(client)[0] ?? []
    const update = (args?.update ?? {}) as Record<string, Record<string, unknown>>
    expect(update['sub-1']).toEqual({ emailPush: null })
    expect((await readPushRegistration(idb))?.emailPush).toBe(false)
    // **The removal patch MUST carry the URN.** RFC 8620 §3.3 lets a server refuse a request that
    // uses a capability it was not told about, and a refused removal is the worst outcome in this
    // whole file: the server keeps putting subjects in a push for a user who has just said no, the
    // local record says it was cleared, and no error is raised anywhere.
    expect(setUsing(client)).toEqual(['urn:ietf:params:jmap:emailpush'])
  })

  /** Turning it on again on an existing subscription — an update, not a destroy-and-recreate. */
  it('adds the configuration to a subscription that already exists', async () => {
    await writePushRegistration(
      {
        subscriptionId: 'sub-1',
        endpoint: ENDPOINT,
        applicationServerKey: KEY,
        expires: FAR,
        emailPush: false,
      },
      idb,
    )
    const client = fakeClient({
      list: [{ id: 'sub-1', deviceClientId: 'waxwing-device-1', expires: FAR }],
    })

    await ensurePushSubscription(
      deps(fakeRegistration(fakeSubscription()), client, { emailPush: { accountIds: ['b'] } }),
    )

    const [, args] = setCalls(client)[0] ?? []
    const update = (args?.update ?? {}) as Record<string, Record<string, unknown>>
    expect(update['sub-1']).toEqual({ emailPush: WANTED_CONFIG })
    expect(setCalls(client)[0]?.[1].create).toBeUndefined()
  })

  /** The worker renders what the page wrote; the switch has to reach it, not only the wire. */
  it('mirrors the preview toggle and both fallback strings into the worker handover', async () => {
    const client = fakeClient({})
    await ensurePushSubscription(
      deps(fakeRegistration(), client, {
        emailPush: null,
        preview: false,
        unknownSender: 'Unbekannter Absender',
        noSubject: '(kein Betreff)',
      }),
    )
    const state = await readPushState(idb)
    expect(state?.preview).toBe(false)
    expect(state?.unknownSender).toBe('Unbekannter Absender')
    expect(state?.noSubject).toBe('(kein Betreff)')
  })
})
