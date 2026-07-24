/**
 * Lifecycle tests for {@link PushSubscriptionHost} — the seam every earlier test missed.
 *
 * The five B29 defects (2026-07-23) all sat in ONE place: where React state meets the browser's
 * single Web Push subscription and its server twin. Not one of ~2600 green tests could see them,
 * because each drove ONE function against a fake on ONE side of the seam. The reconcile unit test
 * even drove `reconcilePush` directly with `wanted: true` and so never modelled the transient states
 * the React layer actually produces on a reconnect.
 *
 * So these tests mount the REAL host and drive the REAL sequences:
 *  - the real `permission-store`, `push-store` (global fake-indexeddb), `reconcilePush`, and the real
 *    SW→page message channel;
 *  - the ONE subscription modelled as ONE shared fake — one PushManager (one endpoint), one JMAP
 *    client that records every `PushSubscription/set` create/update/destroy, one
 *    `navigator.serviceWorker` — so "exactly one create, zero destroy" is a global fact, not a
 *    per-call one;
 *  - only the data sources ABOVE the host (session/client, config, prefs, permission) are steered.
 *
 * Each case is written to go RED under the specific defect it guards (noted per test).
 */

import { act, render, waitFor } from '@testing-library/react'
import { type JmapClient, MethodResponses, type Session } from '@waxwing/jmap'
import type { ComponentProps, ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../app/config'
import { ConfigProvider } from '../app/config-context'
import { SessionContext } from '../app/session/context'
import { resetSwRegistrationState, setActiveSwRegistration } from '../pwa/register-sw'
import { type ReplicaDb, ReplicaProvider, setPref } from '../sync'
import { freshDb } from '../sync/test-utils'
import { NOTIFY_PREF_KEY, type NotificationPrefs } from './notify-model'
import { publishPermission, resetPermissionStore } from './permission-store'
import { resetReconcileSerialisation } from './push-reconcile'
import { clearPushState, peekPendingVerification, putPendingVerification } from './push-store'
import type { BrowserPushSubscription, PushCapableRegistration } from './push-subscribe'
import { PushSubscriptionHost } from './use-push-subscription'

// The real 87-char unpadded base64url VAPID key shape (same constant the reconcile unit test uses).
const KEY =
  'BLjc7wAlpyEjBJLAhjRWZ5O_g4HspzJGSgk8iUmmqzCFZ8fcHRA0AghHk3KaVU9EJuC-y2yYTBt25bnLw3rylew'
const ENDPOINT = 'https://push.example/endpoint/abc'
const FAR = '2026-07-30T04:55:11Z'
const ACC = 'acc-1'

type SessionValue = ComponentProps<typeof SessionContext.Provider>['value']
type Call = [string, Record<string, unknown>, string]

/** One browser subscription. `unsubscribed` flips true iff someone tears it down — the L1 tripwire. */
function fakeSubscription(): BrowserPushSubscription & { unsubscribed: boolean } {
  const sub = {
    endpoint: ENDPOINT,
    unsubscribed: false,
    getKey: (name: 'p256dh' | 'auth'): ArrayBuffer =>
      name === 'p256dh' ? new Uint8Array(65).fill(4).buffer : new Uint8Array(16).fill(7).buffer,
    unsubscribe: async (): Promise<boolean> => {
      sub.unsubscribed = true
      return true
    },
  }
  return sub
}

/** One registration + its ONE `pushManager`. `active` is set so `getPushRegistration` accepts it. */
function fakeRegistration(): PushCapableRegistration & {
  current: (BrowserPushSubscription & { unsubscribed: boolean }) | null
  active: unknown
} {
  const registration = {
    current: null as (BrowserPushSubscription & { unsubscribed: boolean }) | null,
    active: {},
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

/**
 * One JMAP client answering `PushSubscription/get|set`. Records every call in `calls`, so
 * create/update/destroy are counted across the whole test — the "one resource" seen from the server.
 * `flags.offline` makes every UPDATE throw (as after a reconnect): the create still lands.
 */
function fakeClient(session: Session): JmapClient & { calls: Call[]; flags: { offline: boolean } } {
  const calls: Call[] = []
  const flags = { offline: false }
  let list: Record<string, unknown>[] = []
  const client = {
    calls,
    flags,
    session,
    async call(invocations: Call[]): Promise<MethodResponses> {
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
          if (flags.offline) throw new TypeError('Failed to fetch')
          responses.push([name, { updated: { 'sub-1': null } }, id])
        }
      }
      return new MethodResponses(responses, 'state-1', undefined)
    },
  }
  return client as unknown as JmapClient & { calls: Call[]; flags: { offline: boolean } }
}

function makeSession(withKey = true): Session {
  return {
    capabilities: withKey
      ? { 'urn:ietf:params:jmap:webpush-vapid': { applicationServerKey: KEY } }
      : {},
  } as unknown as Session
}

/** A connected session value. `jmapSession === client.session` (as `SessionProvider` builds it). */
function connectedValue(client: JmapClient): SessionValue {
  return {
    connected: {
      client,
      jmapSession: (client as unknown as { session: Session }).session,
      accountId: ACC,
      username: 'alice',
      method: 'oauth',
    },
  } as unknown as SessionValue
}

const DISCONNECTED = { connected: null } as unknown as SessionValue

/** A `navigator.serviceWorker` stand-in: jsdom has none. EventTarget gives the message channel. */
class FakeSwContainer extends EventTarget {
  startMessagesCalls = 0
  readonly ready: Promise<unknown>
  constructor(registration: unknown) {
    super()
    this.ready = Promise.resolve(registration)
  }
  startMessages(): void {
    this.startMessagesCalls++
  }
}

/**
 * jsdom has no `Notification`. `permission.ts` only recognises it when it is a FUNCTION (the DOM
 * constructor), reading `.permission` off it — so a plain object is invisible. This is a ctor whose
 * `permission` getter reads a mutable holder, so a test can flip the browser's answer mid-run.
 */
const fakeNotification = { permission: 'granted' as NotificationPermission }
const NotificationCtor = function NotificationCtor(): void {} as unknown as {
  permission: NotificationPermission
  requestPermission(): Promise<NotificationPermission>
}
Object.defineProperty(NotificationCtor, 'permission', {
  get: () => fakeNotification.permission,
  configurable: true,
})
NotificationCtor.requestPermission = async (): Promise<NotificationPermission> =>
  fakeNotification.permission

const DEFAULT_PREFS: NotificationPrefs = {
  enabled: true,
  mailboxIds: [],
  quietHours: null,
  preview: true,
  sound: true,
}

function Providers({
  db,
  session,
  children,
}: {
  db: ReplicaDb
  session: SessionValue
  children: ReactNode
}): ReactNode {
  return (
    <ConfigProvider config={DEFAULT_CONFIG}>
      <ReplicaProvider accountId={ACC} db={db}>
        <SessionContext.Provider value={session}>{children}</SessionContext.Provider>
      </ReplicaProvider>
    </ConfigProvider>
  )
}

const creates = (client: { calls: Call[] }): Call[] =>
  client.calls.filter(([, args]) => args.create !== undefined)
const destroys = (client: { calls: Call[] }): Call[] =>
  client.calls.filter(([, args]) => args.destroy !== undefined)
const updates = (client: { calls: Call[] }): Call[] =>
  client.calls.filter(([, args]) => args.update !== undefined)

/** Let the effect's async chain (registration lookup → reconcile → real IDB) drain. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

let db: ReplicaDb
let registration: ReturnType<typeof fakeRegistration>

beforeEach(async () => {
  resetReconcileSerialisation()
  resetPermissionStore()
  resetSwRegistrationState()
  fakeNotification.permission = 'granted'
  Object.defineProperty(globalThis, 'Notification', {
    value: NotificationCtor,
    configurable: true,
    writable: true,
  })
  await clearPushState() // wipe the global `waxwing-push` DB between tests
  db = freshDb()
  await setPref(db, ACC, NOTIFY_PREF_KEY, DEFAULT_PREFS)
  registration = fakeRegistration()
  setActiveSwRegistration(registration as unknown as ServiceWorkerRegistration)
})

afterEach(() => {
  resetSwRegistrationState()
  resetReconcileSerialisation()
  resetPermissionStore()
  Reflect.deleteProperty(navigator, 'serviceWorker')
  Reflect.deleteProperty(globalThis, 'Notification')
})

describe('PushSubscriptionHost lifecycle', () => {
  it('L1: reconnect churn never tears the subscription down', async () => {
    // The exact scenario the plan says no unit test could find: client null while reconnecting,
    // then a healthy subscription, then a reconnect drop. The old collapsed-`wanted` reconciler
    // unsubscribed on the transient. Fixed: only an explicit "no" tears down.
    const client = fakeClient(makeSession())

    const { rerender } = render(
      <Providers db={db} session={DISCONNECTED}>
        <PushSubscriptionHost />
      </Providers>,
    )
    await settle()
    expect(creates(client)).toHaveLength(0)

    rerender(
      <Providers db={db} session={connectedValue(client)}>
        <PushSubscriptionHost />
      </Providers>,
    )
    await waitFor(() => expect(creates(client)).toHaveLength(1))
    const sub = registration.current
    expect(sub).not.toBeNull()

    // Reconnect drop, then reconnect. Neither may destroy the subscription that already exists.
    rerender(
      <Providers db={db} session={DISCONNECTED}>
        <PushSubscriptionHost />
      </Providers>,
    )
    await settle()
    rerender(
      <Providers db={db} session={connectedValue(client)}>
        <PushSubscriptionHost />
      </Providers>,
    )
    await settle()

    expect(creates(client)).toHaveLength(1) // still exactly one — no recreate
    expect(destroys(client)).toHaveLength(0)
    expect(sub?.unsubscribed).toBe(false) // the browser sub was never torn down
  })

  // The overlapping-passes race (defect #5) is deliberately NOT reproduced here. Driving rapid
  // re-renders in jsdom does not reliably interleave two passes — each effect run awaits
  // `getPushRegistration` first, and the stateful `PushSubscription/get` fake returns the existing
  // subscription once the first create lands, so a host-level test stays green with OR without the
  // serialisation. A test that cannot fail is worse than none. The guarantee is covered where it can
  // truly bite: the concurrent `Promise.all([reconcilePush, …])` case in `push-reconcile.test.ts`,
  // which goes red the moment the serialisation is removed.

  it('L3: a grant obtained elsewhere reaches the host and it subscribes', async () => {
    // Defect #1: the permission was per-component `useState`, so the settings screen granted it into
    // its own copy while the host kept a stale `default` and never subscribed. Now one shared store.
    fakeNotification.permission = 'default'
    resetPermissionStore()
    const client = fakeClient(makeSession())

    render(
      <Providers db={db} session={connectedValue(client)}>
        <PushSubscriptionHost />
      </Providers>,
    )
    await settle()
    expect(creates(client)).toHaveLength(0) // default permission: nothing yet

    // The settings switch grants and publishes into the SHARED store — the host must see it.
    fakeNotification.permission = 'granted'
    await act(async () => {
      publishPermission('granted')
    })
    await waitFor(() => expect(creates(client)).toHaveLength(1))
  })

  it('L4: startMessages is called and a posted verification completes the round-trip', async () => {
    // Defects #2/#3: the code was posted (not parked) and `startMessages()` was missing, so the
    // container never drained the queued message. Here we pin the call and drive the channel.
    const client = fakeClient(makeSession())
    const container = new FakeSwContainer(registration)
    Object.defineProperty(navigator, 'serviceWorker', { value: container, configurable: true })

    render(
      <Providers db={db} session={connectedValue(client)}>
        <PushSubscriptionHost />
      </Providers>,
    )
    await waitFor(() => expect(creates(client)).toHaveLength(1))

    // jsdom's EventTarget cannot model the pre-attach queue, so `startMessages` is pinned by its
    // call, not by behaviour — which is exactly what the host's own comment says a test must do.
    expect(container.startMessagesCalls).toBe(1)

    await putPendingVerification({ pushSubscriptionId: 'sub-1', verificationCode: 'code-1' })
    await act(async () => {
      container.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'PUSH_VERIFICATION',
            pushSubscriptionId: 'sub-1',
            verificationCode: 'code-1',
          },
        }),
      )
    })

    await waitFor(() => expect(updates(client)).toHaveLength(1))
    const update = updates(client)[0]?.[1].update as Record<string, { verificationCode?: string }>
    expect(update['sub-1']?.verificationCode).toBe('code-1')
    await waitFor(async () => expect(await peekPendingVerification()).toBeNull())
  })

  it('L5: the reliable peek path writes a parked code back, and retains it on failure', async () => {
    // Defect #2/#4: the worker parks every code; the reconcile pass picks it up even with no
    // window listening. On a failed write-back the code must be RETAINED, not dropped.
    const client = fakeClient(makeSession())
    client.flags.offline = true // write-back will fail
    await putPendingVerification({ pushSubscriptionId: 'sub-1', verificationCode: 'code-1' })

    render(
      <Providers db={db} session={connectedValue(client)}>
        <PushSubscriptionHost />
      </Providers>,
    )
    await waitFor(() => expect(creates(client)).toHaveLength(1))
    await settle()
    // Offline: the code was attempted but the server did not take it, so it stays for a retry.
    expect(await peekPendingVerification()).not.toBeNull()

    // A later pass, now online, must complete it. Toggling a pref re-runs the effect.
    client.flags.offline = false
    await act(async () => {
      await setPref(db, ACC, NOTIFY_PREF_KEY, { ...DEFAULT_PREFS, sound: false })
    })
    await waitFor(async () => expect(await peekPendingVerification()).toBeNull())
  })

  it('L6: the master switch off is the one allowed teardown', async () => {
    // Distinct from L1: turning notifications OFF (or a `denied` permission) is the user's explicit
    // "no" — the only thing that may destroy the subscription.
    const client = fakeClient(makeSession())

    const { rerender } = render(
      <Providers db={db} session={connectedValue(client)}>
        <PushSubscriptionHost />
      </Providers>,
    )
    await waitFor(() => expect(creates(client)).toHaveLength(1))
    const sub = registration.current

    await act(async () => {
      await setPref(db, ACC, NOTIFY_PREF_KEY, { ...DEFAULT_PREFS, enabled: false })
    })
    rerender(
      <Providers db={db} session={connectedValue(client)}>
        <PushSubscriptionHost />
      </Providers>,
    )
    await waitFor(() => expect(destroys(client)).toHaveLength(1))
    expect(sub?.unsubscribed).toBe(true)
  })
})
