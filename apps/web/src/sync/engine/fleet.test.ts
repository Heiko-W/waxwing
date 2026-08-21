/**
 * Fleet orchestration tests (M4.4 Etappe 2): N engines, one per account, over the SAME replica.
 *
 * The DoD lives here: two accounts' deltas land under their OWN `accountId`; each account gets its
 * own leader lock (so two tabs never double-sync the same shared account); ONE push channel wakes
 * every engine; the 0→1→0 shared-account lifecycle builds up and tears down cleanly with no leak; and
 * the single-account path is byte-for-byte the pre-M4.4 wiring (bare lock, own SSE channel, real bus,
 * global badge, no registry write). Real {@link SyncEngine}s with fake ports/locks/push prove the
 * behaviour; a stubbed engine factory proves the pure orchestration lifecycle deterministically.
 */

import type {
  PushChannel,
  PushErrorListener,
  PushStatus,
  StateChange,
  StateChangeListener,
  StatusListener,
  Unsubscribe,
} from '@waxwing/jmap'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AccountRecord, ReplicaDb } from '../db'
import { getAccount, upsertAccount } from '../repo'
import { freshDb } from '../test-utils'
import type { BroadcastChannelLike } from './bus'
import { SyncEngine, type SyncEngineDeps } from './engine'
import {
  createPushMux,
  type EngineSpec,
  type FleetAccount,
  type FleetDeps,
  type PushMux,
  startEngineFleet,
} from './fleet'
import { type LockManagerLike, SYNC_LOCK } from './leader'
import { getEngineStatus, setEngineStatus } from './status'
import {
  type ChangesResult,
  type EngineClock,
  INITIAL_ENGINE_STATUS,
  type JmapPort,
  type PortSetResult,
} from './types'

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
async function waitFor(predicate: () => boolean | Promise<boolean>, tries = 80): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (await predicate()) return
    await flush()
  }
  throw new Error('waitFor timed out')
}

const emptyChanges = (state: string): ChangesResult => ({
  newState: state,
  hasMoreChanges: false,
  created: [],
  updated: [],
  destroyed: [],
})

const emptySet = (): PortSetResult => ({
  oldState: null,
  newState: 's',
  created: {},
  updated: [],
  destroyed: [],
  notCreated: {},
  notUpdated: {},
  notDestroyed: {},
})

const noopBus = (): BroadcastChannelLike => ({ postMessage() {}, close() {}, onmessage: null })

// ── Fakes ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Models `navigator.locks` exclusive queueing (FIFO handover per name), and RECORDS every requested
 * name so a test can assert each account contends on its OWN lock. Mirrors leader.test.ts.
 */
class FakeLockManager implements LockManagerLike {
  readonly requested: string[] = []
  private readonly busy = new Set<string>()
  private readonly queues = new Map<string, Array<() => void>>()

  request(
    name: string,
    options: { signal?: AbortSignal },
    cb: (lock: unknown) => Promise<unknown>,
  ): Promise<unknown> {
    this.requested.push(name)
    return new Promise((resolve, reject) => {
      let granted = false
      const run = () => {
        granted = true
        this.busy.add(name)
        Promise.resolve()
          .then(() => cb(undefined))
          .then(
            (value) => {
              this.busy.delete(name)
              resolve(value)
              this.pump(name)
            },
            (error) => {
              this.busy.delete(name)
              reject(error)
              this.pump(name)
            },
          )
      }
      const queue = this.queues.get(name) ?? []
      queue.push(run)
      this.queues.set(name, queue)

      const signal = options.signal
      if (signal) {
        const onAbort = () => {
          if (granted) return
          const q = this.queues.get(name)
          const index = q?.indexOf(run) ?? -1
          if (q && index >= 0) q.splice(index, 1)
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        }
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      }
      this.pump(name)
    })
  }

  private pump(name: string): void {
    if (this.busy.has(name)) return
    const next = (this.queues.get(name) ?? []).shift()
    next?.()
  }
}

class FakePush implements PushChannel {
  readonly transport = 'sse' as const
  status: PushStatus = 'closed'
  opened = false
  closed = false
  private stateCb: StateChangeListener | undefined
  open(): void {
    this.opened = true
    this.status = 'open'
  }
  close(): void {
    this.closed = true
    this.status = 'closed'
  }
  subscribe(listener: StateChangeListener): Unsubscribe {
    this.stateCb = listener
    return () => {
      this.stateCb = undefined
    }
  }
  onStatus(_listener: StatusListener): Unsubscribe {
    return () => {}
  }
  onError(_listener: PushErrorListener): Unsubscribe {
    return () => {}
  }
  fireStateChange(): void {
    this.stateCb?.({ '@type': 'StateChange', changed: {} } as StateChange)
  }
}

/** A JmapPort that populates an inbox + the given email ids under ONE account, empty for the rest. */
function fakePort(accountId: string, emails: string[]): JmapPort {
  return {
    accountId,
    async mailboxChanges(s) {
      return emptyChanges(s)
    },
    async threadChanges(s) {
      return emptyChanges(s)
    },
    async emailChanges(s) {
      return emptyChanges(s)
    },
    async getMailboxes() {
      return {
        list: [
          {
            id: 'inbox',
            name: 'Inbox',
            parentId: null,
            role: 'inbox',
            sortOrder: 0,
            totalEmails: emails.length,
            unreadEmails: 0,
            totalThreads: 0,
            unreadThreads: 0,
            myRights: {
              mayReadItems: true,
              mayAddItems: true,
              mayRemoveItems: true,
              maySetSeen: true,
              maySetKeywords: true,
              mayCreateChild: true,
              mayRename: true,
              mayDelete: true,
              maySubmit: true,
              mayShare: false,
            },
            isSubscribed: true,
          },
        ],
        notFound: [],
        state: 'mbx-1',
      }
    },
    async getIdentities() {
      return { list: [], notFound: [], state: 'idn-1' }
    },
    async getThreads(ids) {
      return { list: ids.map((id) => ({ id, emailIds: [id] })), notFound: [], state: 'thr-1' }
    },
    async getEmailEnvelopes(ids) {
      return {
        list: ids.map((id) => ({
          id,
          blobId: `b-${id}`,
          threadId: id,
          mailboxIds: { inbox: true },
          keywords: {},
          size: 1,
          receivedAt: '2026-07-01T00:00:00Z',
          sentAt: null,
          from: null,
          to: null,
          cc: null,
          replyTo: null,
          subject: id,
          messageId: null,
          inReplyTo: null,
          references: null,
          preview: '',
          hasAttachment: false,
        })),
        notFound: [],
        state: 'eml-1',
      }
    },
    async getEmailBodies() {
      return { list: [], notFound: [], state: 'eml-1' }
    },
    async queryEmails() {
      return {
        ids: emails,
        queryState: 'q-1',
        canCalculateChanges: true,
        position: 0,
        total: emails.length,
      }
    },
    async queryEmailChanges() {
      return { oldQueryState: 'q-1', newQueryState: 'q-1', removed: [], added: [] }
    },
    async setEmails() {
      return emptySet()
    },
    async setMailboxes() {
      return emptySet()
    },
    async submitEmail() {
      return emptySet()
    },
    async getSearchSnippets() {
      return { list: [], notFound: [] }
    },
    async getAddressBooks() {
      return { list: [], notFound: [], state: 'abk-1' }
    },
    async addressBookChanges(s) {
      return emptyChanges(s)
    },
    async setAddressBooks() {
      return emptySet()
    },
    async getContactCards() {
      return { list: [], notFound: [], state: 'cc-1' }
    },
    async contactCardChanges(s) {
      return emptyChanges(s)
    },
    async queryContactCards() {
      return { ids: [], queryState: 'cq-1', canCalculateChanges: true, position: 0, total: 0 }
    },
    async queryContactCardChanges() {
      return { oldQueryState: 'cq-1', newQueryState: 'cq-1', removed: [], added: [] }
    },
    async setContactCards() {
      return emptySet()
    },
    async getCalendars() {
      return { list: [], notFound: [], state: 's' }
    },
    async calendarChanges(s: string) {
      return emptyChanges(s)
    },
    async getCalendarEvents() {
      return { list: [], notFound: [], state: 's' }
    },
    async calendarEventChanges(s: string) {
      return emptyChanges(s)
    },
    async queryCalendarEvents() {
      return { ids: [], queryState: 'q', canCalculateChanges: true, position: 0 }
    },
    async fileNodePage() {
      return { ids: [], list: [], state: 's' }
    },
    async getFileNodes() {
      return { list: [], notFound: [], state: 's' }
    },
    async fileNodeChanges(s: string) {
      return emptyChanges(s)
    },
  }
}

/** Build real-engine deps from a resolved {@link EngineSpec} (fake port/locks/push, fake clock). */
function engineDeps(opts: {
  db: ReplicaDb
  locks: LockManagerLike
  port: JmapPort
  spec: EngineSpec
  onStandalonePush?: (push: FakePush) => void
}): SyncEngineDeps {
  let t = 1000
  const clock: EngineClock = {
    now: () => t++,
    setTimeout: () => 0,
    clearTimeout: () => {},
  }
  const { spec } = opts
  return {
    db: opts.db,
    port: opts.port,
    session: {} as SyncEngineDeps['session'],
    auth: { scheme: 'bearer', authorization: () => 'x' },
    config: { cacheDays: 30, maxStorageMB: 512 },
    clock,
    locks: opts.locks,
    createBus: spec.createBus ?? noopBus,
    createPush:
      spec.createPush ??
      (() => {
        const push = new FakePush()
        opts.onStandalonePush?.(push)
        return push
      }),
    isOnline: () => true,
    onOnlineChange: () => () => {},
    foregroundAckMs: 10,
    ...(spec.lockName === undefined ? {} : { lockName: spec.lockName }),
    ...(spec.publishStatus === undefined ? {} : { publishStatus: spec.publishStatus }),
  }
}

const primary = (id: string): FleetAccount => ({ id, name: id, isPrimary: true })
const shared = (id: string): FleetAccount => ({ id, name: id, isPrimary: false })

/** The registry record the production host writes — replicated so registry assertions are real. */
const recordFor = (account: FleetAccount): AccountRecord => ({
  id: account.id,
  username: account.name,
  name: account.name,
  issuer: null,
  isPrimary: account.isPrimary,
  addedAt: 1,
  lastSeenAt: 1,
})

let db: ReplicaDb

beforeEach(() => {
  db = freshDb()
  setEngineStatus(INITIAL_ENGINE_STATUS)
})

afterEach(async () => {
  await db.delete()
})

describe('startEngineFleet — two accounts', () => {
  it('syncs each account into its OWN scope over one shared push channel', async () => {
    const locks = new FakeLockManager()
    const ports: Record<string, JmapPort> = {
      acc1: fakePort('acc1', ['a1', 'a2']),
      acc2: fakePort('acc2', ['b1']),
    }
    const realPushes: FakePush[] = []
    const setActiveCalls: (SyncEngine | null)[] = []
    const registered: string[] = []
    const engines = new Map<string, SyncEngine>()

    const deps: FleetDeps = {
      createEngine: (spec) => {
        const engine = new SyncEngine(
          engineDeps({ db, locks, port: ports[spec.account.id] as JmapPort, spec }),
        )
        engines.set(spec.account.id, engine)
        return engine
      },
      createPushMux: () =>
        createPushMux(() => {
          const push = new FakePush()
          realPushes.push(push)
          return push
        }),
      setActive: (engine) => setActiveCalls.push(engine),
      publish: () => {},
      register: (account) => {
        registered.push(account.id)
        void upsertAccount(db, recordFor(account))
      },
    }

    const teardown = startEngineFleet([primary('acc1'), shared('acc2')], deps)

    await waitFor(
      async () =>
        (await db.emails.get(['acc1', 'a1'])) !== undefined &&
        (await db.emails.get(['acc2', 'b1'])) !== undefined,
    )

    // Each account's delta landed under its OWN accountId — and nowhere else.
    expect(await db.emails.get(['acc1', 'a2'])).toBeDefined()
    expect(await db.emails.get(['acc1', 'b1'])).toBeUndefined()
    expect(await db.emails.get(['acc2', 'a1'])).toBeUndefined()
    expect(await db.mailboxes.get(['acc1', 'inbox'])).toBeDefined()
    expect(await db.mailboxes.get(['acc2', 'inbox'])).toBeDefined()

    // ONE shared push channel for the whole fleet (not one per account).
    expect(realPushes).toHaveLength(1)
    // The primary alone is the active engine the UI dispatches through.
    expect(setActiveCalls).toEqual([engines.get('acc1')])
    // Multi-account mode registers BOTH accounts (the shared one, then the primary).
    expect(registered.sort()).toEqual(['acc1', 'acc2'])
    await waitFor(async () => (await getAccount(db, 'acc2')) !== undefined)
    expect(await getAccount(db, 'acc1')).toBeDefined()

    // The single shared channel wakes BOTH engines: fire it once, both run another pass.
    const before1 = engines.get('acc1')?.getStatus().lastSyncedAt
    const before2 = engines.get('acc2')?.getStatus().lastSyncedAt
    realPushes[0]?.fireStateChange()
    await waitFor(
      () =>
        engines.get('acc1')?.getStatus().lastSyncedAt !== before1 &&
        engines.get('acc2')?.getStatus().lastSyncedAt !== before2,
    )

    teardown()
    await flush()
    expect(realPushes[0]?.closed).toBe(true)
  })

  it('gives each account its own leader lock so two tabs never double-lead one account', async () => {
    const locks = new FakeLockManager()
    const makeFleet = () => {
      const engines = new Map<string, SyncEngine>()
      const teardown = startEngineFleet([primary('acc1'), shared('acc2')], {
        createEngine: (spec) => {
          const engine = new SyncEngine(
            engineDeps({ db, locks, port: fakePort(spec.account.id, []), spec }),
          )
          engines.set(spec.account.id, engine)
          return engine
        },
        createPushMux: () => createPushMux(() => new FakePush()),
        setActive: () => {},
        publish: () => {},
        register: () => {},
      })
      return { engines, teardown }
    }

    // Two tabs contend on the SAME per-account locks.
    const tab1 = makeFleet()
    const tab2 = makeFleet()

    await waitFor(() => tab1.engines.get('acc2')?.getStatus().isLeader === true)
    // Tab 1 (requested first) leads BOTH accounts; tab 2 waits behind it on BOTH locks.
    expect(tab1.engines.get('acc1')?.getStatus().isLeader).toBe(true)
    expect(tab1.engines.get('acc2')?.getStatus().isLeader).toBe(true)
    expect(tab2.engines.get('acc1')?.getStatus().isLeader).toBe(false)
    expect(tab2.engines.get('acc2')?.getStatus().isLeader).toBe(false)

    // The primary keeps the bare historical name; the shared account gets a suffixed lock. Each name
    // is contended by BOTH tabs (so they serialise on it), never a per-tab private lock.
    expect(locks.requested.filter((name) => name === SYNC_LOCK)).toHaveLength(2)
    expect(locks.requested.filter((name) => name === `${SYNC_LOCK}:acc2`)).toHaveLength(2)

    // Tab 1 releases → tab 2 takes over BOTH accounts (per-lock re-election).
    tab1.teardown()
    await waitFor(() => tab2.engines.get('acc2')?.getStatus().isLeader === true)
    expect(tab2.engines.get('acc1')?.getStatus().isLeader).toBe(true)

    tab2.teardown()
    await flush()
  })
})

describe('startEngineFleet — single account is unchanged', () => {
  it('builds exactly the pre-M4.4 engine: bare lock, own push, no mux, no registry write', () => {
    const specs: EngineSpec[] = []
    const setActiveCalls: (SyncEngine | null)[] = []
    let muxCalls = 0
    let registerCalls = 0
    const stopped: SyncEngine[] = []

    const stubEngine = () => {
      const engine = {
        start() {},
        stop() {
          stopped.push(engine as unknown as SyncEngine)
          return Promise.resolve()
        },
      }
      return engine as unknown as SyncEngine
    }

    const teardown = startEngineFleet([primary('acc1')], {
      createEngine: (spec) => {
        specs.push(spec)
        return stubEngine()
      },
      createPushMux: () => {
        muxCalls += 1
        return { handle: () => new FakePush(), closeAll() {} } satisfies PushMux
      },
      setActive: (engine) => setActiveCalls.push(engine),
      publish: () => {},
      register: () => {
        registerCalls += 1
      },
    })

    // Exactly one engine, and its spec carries NONE of the account overrides (all fall back to the
    // pre-M4.4 defaults inside the engine): bare lock, own SSE channel, real bus, global badge.
    expect(specs).toHaveLength(1)
    const spec = specs[0] as EngineSpec
    expect(spec.isPrimary).toBe(true)
    expect(spec.lockName).toBeUndefined()
    expect(spec.createPush).toBeUndefined()
    expect(spec.createBus).toBeUndefined()
    expect(spec.publishStatus).toBeUndefined()
    // No shared push mux and NO registry write in the single-account path.
    expect(muxCalls).toBe(0)
    expect(registerCalls).toBe(0)
    expect(setActiveCalls).toHaveLength(1)

    teardown()
    expect(setActiveCalls[1]).toBeNull()
    expect(stopped).toHaveLength(1)
  })

  it('a real single engine drives the global badge and writes nothing to the registry', async () => {
    const locks = new FakeLockManager()
    const standalone: FakePush[] = []
    let muxCalls = 0

    const teardown = startEngineFleet([primary('acc1')], {
      createEngine: (spec) =>
        new SyncEngine(
          engineDeps({
            db,
            locks,
            port: fakePort('acc1', ['a1']),
            spec,
            onStandalonePush: (push) => standalone.push(push),
          }),
        ),
      createPushMux: () => {
        muxCalls += 1
        return { handle: () => new FakePush(), closeAll() {} }
      },
      setActive: () => {},
      publish: () => {},
      // A real writer, so "registry stays empty" proves the fleet never CALLED register (not that the
      // fake was a no-op).
      register: (account) => {
        void upsertAccount(db, recordFor(account))
      },
    })

    await waitFor(() => getEngineStatus().phase === 'idle' && getEngineStatus().isLeader)

    expect(await db.emails.get(['acc1', 'a1'])).toBeDefined()
    // The primary opened its OWN channel (no mux was ever built), and the registry stays empty.
    expect(muxCalls).toBe(0)
    expect(standalone).toHaveLength(1)
    expect(standalone[0]?.opened).toBe(true)
    expect(await getAccount(db, 'acc1')).toBeUndefined()

    teardown()
    await flush()
    expect(standalone[0]?.closed).toBe(true)
  })
})

describe('startEngineFleet — 0→1→0 shared-account lifecycle', () => {
  it('builds up and tears down cleanly across transitions with no engine/mux leak', () => {
    const started: string[] = []
    const stopped: string[] = []
    let muxOpen = 0
    let muxClosed = 0
    const setActiveCalls: (SyncEngine | null)[] = []

    const stubEngine = (id: string) => {
      const engine = {
        start() {
          started.push(id)
        },
        stop() {
          stopped.push(id)
          return Promise.resolve()
        },
      }
      return engine as unknown as SyncEngine
    }

    const deps: FleetDeps = {
      createEngine: (spec) => stubEngine(spec.account.id),
      createPushMux: (): PushMux => {
        muxOpen += 1
        return {
          handle: () => new FakePush(),
          closeAll() {
            muxClosed += 1
          },
        }
      },
      setActive: (engine) => setActiveCalls.push(engine),
      publish: () => {},
      register: () => {},
    }

    // 0 shared: one engine, no mux.
    const t0 = startEngineFleet([primary('acc1')], deps)
    expect(started).toEqual(['acc1'])
    expect(muxOpen).toBe(0)
    t0()
    expect(stopped).toEqual(['acc1'])
    expect(setActiveCalls[1]).toBeNull()

    // 0→1 shared: primary + shared, one mux built.
    const t1 = startEngineFleet([primary('acc1'), shared('acc2')], deps)
    expect(started).toEqual(['acc1', 'acc1', 'acc2'])
    expect(muxOpen).toBe(1)
    t1()
    expect(stopped).toEqual(['acc1', 'acc1', 'acc2'])
    expect(muxClosed).toBe(1)

    // 1→0 shared: back to a single engine, no new mux.
    const t2 = startEngineFleet([primary('acc1')], deps)
    expect(started).toEqual(['acc1', 'acc1', 'acc2', 'acc1'])
    expect(muxOpen).toBe(1)
    t2()

    // Every started engine was stopped (no orphan), and every mux built was closed (no leaked SSE).
    expect(stopped).toEqual(['acc1', 'acc1', 'acc2', 'acc1'])
    expect(muxClosed).toBe(1)
  })
})

describe('startEngineFleet — per-account publication (M4.4 Etappe 4)', () => {
  /** Records `publish` in order, so both WHAT was published and WHEN can be asserted. */
  function recordingDeps(): {
    deps: FleetDeps
    published: [string, SyncEngine | null][]
    order: string[]
  } {
    const published: [string, SyncEngine | null][] = []
    const order: string[] = []
    const stubEngine = (id: string) =>
      ({
        start() {
          order.push(`start:${id}`)
        },
        stop: () => Promise.resolve(),
      }) as unknown as SyncEngine
    return {
      published,
      order,
      deps: {
        createEngine: (spec) => stubEngine(spec.account.id),
        createPushMux: (): PushMux => ({ handle: () => new FakePush(), closeAll() {} }),
        setActive: () => {},
        publish: (accountId, engine) => {
          published.push([accountId, engine])
          order.push(`${engine === null ? 'withdraw' : 'publish'}:${accountId}`)
        },
        register: () => {},
      },
    }
  }

  it('publishes EVERY account, the primary included', () => {
    const { deps, published } = recordingDeps()

    startEngineFleet([primary('acc1'), shared('acc2'), shared('acc3')], deps)

    expect(published.map(([id]) => id)).toEqual(['acc1', 'acc2', 'acc3'])
    // Each account gets its OWN engine object — the pairing the registry relies on.
    const engines = published.map(([, engine]) => engine)
    expect(new Set(engines).size).toBe(3)
    expect(engines.every((engine) => engine !== null)).toBe(true)
  })

  it('publishes an engine BEFORE starting it, so a click at first paint is not dropped', () => {
    const { deps, order } = recordingDeps()

    startEngineFleet([primary('acc1'), shared('acc2')], deps)

    expect(order).toEqual(['publish:acc1', 'start:acc1', 'publish:acc2', 'start:acc2'])
  })

  it('withdraws every handle on teardown, before anything is stopped', () => {
    const { deps, published } = recordingDeps()

    const teardown = startEngineFleet([primary('acc1'), shared('acc2')], deps)
    published.length = 0
    teardown()

    // An engine releasing its lock must no longer be reachable — a click landing in that window
    // would otherwise enqueue onto a dying engine.
    expect(published).toEqual([
      ['acc1', null],
      ['acc2', null],
    ])
  })

  it('publishes the lone primary in the single-account case too', () => {
    // The registry is then non-empty with exactly one entry, so `getEngineFor(primary)` is an exact
    // hit rather than the empty-registry fallback — and any OTHER account resolves to null.
    const { deps, published } = recordingDeps()

    startEngineFleet([primary('acc1')], deps)

    expect(published).toHaveLength(1)
    expect(published[0]?.[0]).toBe('acc1')
  })
})
