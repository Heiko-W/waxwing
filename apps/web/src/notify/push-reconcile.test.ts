/**
 * One reconciliation pass (M4.0). Each case is a way the feature can stop working with no error, no
 * UI state and nothing on screen to say so — which is why the pass reports a NAMED outcome rather
 * than returning void: a test can then tell "we deliberately did nothing" apart from "we silently
 * did nothing".
 */

import type { JmapClient, Session } from '@waxwing/jmap'
import { MethodResponses } from '@waxwing/jmap'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import { reconcilePushSubscription } from './push-reconcile'
import {
  peekPendingVerification,
  putPendingVerification,
  readPushRegistration,
  readPushState,
  writePushRegistration,
} from './push-store'
import type { BrowserPushSubscription, PushCapableRegistration } from './push-subscribe'

const KEY =
  'BLjc7wAlpyEjBJLAhjRWZ5O_g4HspzJGSgk8iUmmqzCFZ8fcHRA0AghHk3KaVU9EJuC-y2yYTBt25bnLw3rylew'
const ENDPOINT = 'https://push.example/endpoint/abc'
const FAR = '2026-07-30T04:55:11Z'

let idb: IDBFactory

beforeEach(() => {
  idb = new IDBFactory()
})

function fakeSubscription(): BrowserPushSubscription & { unsubscribed: boolean } {
  const sub = {
    endpoint: ENDPOINT,
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

function fakeRegistration(
  existing: BrowserPushSubscription | null = null,
): PushCapableRegistration & {
  current: BrowserPushSubscription | null
} {
  const registration = {
    current: existing,
    pushManager: {
      getSubscription: async (): Promise<BrowserPushSubscription | null> => registration.current,
      subscribe: async (): Promise<BrowserPushSubscription> => {
        const created = fakeSubscription()
        registration.current = created
        return created
      },
    },
  }
  return registration
}

type Call = [string, Record<string, unknown>, string]

/** `offline: true` makes every UPDATE throw — the create still works, as after a reconnect. */
function fakeClient(options: { offline?: boolean } = {}): JmapClient & { calls: Call[] } {
  const calls: Call[] = []
  let list: Record<string, unknown>[] = []
  const client = {
    calls,
    async call(invocations: Call[]) {
      const responses: Call[] = []
      for (const [name, args, id] of invocations) {
        calls.push([name, args, id])
        if (name === 'PushSubscription/get') {
          responses.push([name, { list, notFound: [] }, id])
          continue
        }
        const create = (args.create ?? null) as Record<string, Record<string, unknown>> | null
        if (create !== null) {
          const body = Object.values(create)[0] ?? {}
          list = [{ id: 'sub-1', deviceClientId: body.deviceClientId, expires: FAR }]
          responses.push([name, { created: { sub: { id: 'sub-1', expires: FAR } } }, id])
        } else {
          if (options.offline === true) throw new TypeError('Failed to fetch')
          responses.push([name, { updated: { 'sub-1': null } }, id])
        }
      }
      return new MethodResponses(responses, 'state-1', undefined)
    },
  }
  return client as unknown as JmapClient & { calls: Call[] }
}

/** The `deviceClientId` this client was actually asked to register — the server's view of us. */
function deviceIdSentBy(client: { calls: Call[] }): string | undefined {
  for (const [, args] of client.calls) {
    const create = args.create as Record<string, Record<string, unknown>> | undefined
    const body = create === undefined ? undefined : Object.values(create)[0]
    const id = body?.deviceClientId
    if (typeof id === 'string') return id
  }
  return undefined
}

const session = (withKey = true): Session =>
  ({
    capabilities: withKey
      ? { 'urn:ietf:params:jmap:webpush-vapid': { applicationServerKey: KEY } }
      : {},
  }) as unknown as Session

function deps(over: Record<string, unknown> = {}) {
  return {
    registration: fakeRegistration(),
    client: fakeClient(),
    session: session(),
    wanted: true,
    title: 'Waxwing',
    body: 'New message',
    iconUrl: 'https://mail.example/branding/icon-192.png',
    badgeUrl: 'https://mail.example/branding/icon-192.png',
    quietHours: null,
    sound: true,
    idb,
    ...over,
  }
}

describe('reconcilePushSubscription', () => {
  it('subscribes when everything lines up', async () => {
    expect(await reconcilePushSubscription(deps())).toBe('subscribed')
    expect(await readPushRegistration(idb)).not.toBeNull()
    expect((await readPushState(idb))?.body).toBe('New message')
  })

  it('does nothing at all without a service worker', async () => {
    expect(await reconcilePushSubscription(deps({ registration: null }))).toBe('noServiceWorker')
    expect(await readPushRegistration(idb)).toBeNull()
  })

  it('tears the subscription down when the user switched it off', async () => {
    await writePushRegistration(
      { subscriptionId: 'sub-1', endpoint: ENDPOINT, applicationServerKey: KEY, expires: FAR },
      idb,
    )
    const existing = fakeSubscription()

    expect(
      await reconcilePushSubscription(
        deps({ wanted: false, registration: fakeRegistration(existing) }),
      ),
    ).toBe('unsubscribed')

    expect(existing.unsubscribed).toBe(true)
    expect(await readPushRegistration(idb)).toBeNull()
  })

  it('tears it down on sign-out, when there is no client left to destroy it with', async () => {
    const existing = fakeSubscription()
    expect(
      await reconcilePushSubscription(
        deps({ client: null, registration: fakeRegistration(existing) }),
      ),
    ).toBe('unsubscribed')
    expect(existing.unsubscribed).toBe(true)
  })

  /**
   * Order: teardown comes BEFORE the capability check. A server that stops advertising RFC 9749
   * would otherwise strand a live subscription the user can no longer switch off — and the server
   * would go on pushing to it, because nothing about a capability disappearing cancels anything.
   */
  it('still tears down when the server has stopped advertising a key', async () => {
    const existing = fakeSubscription()
    expect(
      await reconcilePushSubscription(
        deps({ wanted: false, session: session(false), registration: fakeRegistration(existing) }),
      ),
    ).toBe('unsubscribed')
    expect(existing.unsubscribed).toBe(true)
  })

  it('does not subscribe against a server that publishes no key', async () => {
    const client = fakeClient()
    expect(await reconcilePushSubscription(deps({ session: session(false), client }))).toBe(
      'noServerKey',
    )
    expect(client.calls).toHaveLength(0)
  })

  it('does not subscribe when the session is gone', async () => {
    expect(await reconcilePushSubscription(deps({ session: null }))).toBe('noServerKey')
  })

  /**
   * The recovery path for a subscription that would otherwise be silent forever: the server verified
   * while no window was open, the worker parked the code, and this is the pass that completes the
   * handshake. Without it the app is subscribed, the settings say notifications are on, and the
   * server pushes nothing but the verification it is still waiting for.
   */
  it('writes back a verification code the worker parked', async () => {
    await putPendingVerification({ pushSubscriptionId: 'sub-1', verificationCode: 'code-1' }, idb)
    const client = fakeClient()

    expect(await reconcilePushSubscription(deps({ client }))).toBe('subscribedAndVerified')

    const update = client.calls.find(([, args]) => args.update !== undefined)
    expect(
      (update?.[1].update as Record<string, Record<string, unknown>>)['sub-1']?.verificationCode,
    ).toBe('code-1')
    // Consumed, because the server took it. See the offline case below for why that condition is
    // not "we tried".
    expect(await peekPendingVerification(idb)).toBeNull()
  })

  /**
   * **The code must survive a failed write-back**, and this is the case that decides it.
   *
   * The first version deleted the parked code on read, reasoning that a code which cannot be written
   * back is worthless. That is true when the SERVER rejects it — and false in the case that actually
   * happens, which is the device being offline. Dropping it there turns a situation that fixes
   * itself on the next start into a subscription that stays unverified until something recreates
   * it: the server pushes nothing but the verification, and nothing anywhere says so.
   */
  it('keeps the parked code when the write-back fails, so the next pass can retry', async () => {
    await putPendingVerification({ pushSubscriptionId: 'sub-1', verificationCode: 'code-1' }, idb)

    const offline = fakeClient({ offline: true })
    expect(await reconcilePushSubscription(deps({ client: offline }))).toBe('subscribed')
    expect(await peekPendingVerification(idb)).toEqual({
      pushSubscriptionId: 'sub-1',
      verificationCode: 'code-1',
    })

    // Back online: the very next pass completes the handshake, with no user action at all.
    const online = fakeClient()
    expect(await reconcilePushSubscription(deps({ client: online }))).toBe('subscribedAndVerified')
    expect(await peekPendingVerification(idb)).toBeNull()
  })

  it('reports `unsupported` when the browser refuses, without recording anything', async () => {
    const registration = fakeRegistration()
    registration.pushManager.subscribe = () => Promise.reject(new Error('NotAllowedError'))

    expect(await reconcilePushSubscription(deps({ registration }))).toBe('unsupported')
    expect(await readPushRegistration(idb)).toBeNull()
  })

  /**
   * **Asserted on what reaches the SERVER, not on what the store returns**, and the difference is
   * the whole test. The first version called `ensureDeviceClientId` afterwards and compared the two
   * results — which passes even when the pass mints a fresh id every time, because the assertion
   * itself is what persists one. A mutation run caught it.
   *
   * What matters is that the server keeps seeing the same device: RFC 8620 §7.2 uses
   * `deviceClientId` to recognise a returning client, and a fresh one per launch leaves the server
   * accumulating dead subscriptions, one per start, each pushing at an endpoint nobody listens to.
   */
  it('sends the SAME deviceClientId on every pass, not a fresh one per start', async () => {
    const first = fakeClient()
    await reconcilePushSubscription(deps({ client: first }))

    // A second start: a new client and a new registration, the same browser and the same store.
    const second = fakeClient()
    await reconcilePushSubscription(
      deps({ client: second, registration: fakeRegistration(fakeSubscription()) }),
    )

    expect(deviceIdSentBy(first)).toBeDefined()
    expect(deviceIdSentBy(second)).toBe(deviceIdSentBy(first))
  })

  /**
   * The worker renders strings it cannot translate, so a language switch has to rewrite the handover
   * record. In the app that is carried by react-i18next handing back a new `t`; here it is the plain
   * fact that a pass with different text overwrites what the last one wrote.
   */
  it('rewrites the worker handover when the language changed', async () => {
    await reconcilePushSubscription(deps())
    expect((await readPushState(idb))?.body).toBe('New message')

    await reconcilePushSubscription(deps({ body: 'Neue Nachricht' }))
    expect((await readPushState(idb))?.body).toBe('Neue Nachricht')
  })

  it('rewrites the handover when quiet hours changed', async () => {
    await reconcilePushSubscription(deps())
    expect((await readPushState(idb))?.quietHours).toBeNull()

    await reconcilePushSubscription(deps({ quietHours: { fromMinutes: 1320, toMinutes: 420 } }))
    expect((await readPushState(idb))?.quietHours).toEqual({ fromMinutes: 1320, toMinutes: 420 })
  })
})
