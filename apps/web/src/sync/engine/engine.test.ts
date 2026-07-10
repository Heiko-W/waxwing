import {
  JmapHttpError,
  type PushChannel,
  type PushErrorListener,
  type PushStatus,
  type Session,
  type StateChange,
  type StateChangeListener,
  type StatusListener,
  type Unsubscribe,
} from '@waxwing/jmap'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ReplicaDb } from '../db'
import { freshDb } from '../test-utils'
import type { BroadcastChannelLike } from './bus'
import { SyncEngine, type SyncEngineDeps } from './engine'
import type { LockManagerLike } from './leader'
import { getEngineStatus, setEngineStatus } from './status'
import {
  type ChangesResult,
  type EngineClock,
  INITIAL_ENGINE_STATUS,
  type JmapPort,
  type PortSetResult,
} from './types'

const ACC = 'acc'

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
async function waitFor(predicate: () => boolean | Promise<boolean>, tries = 50): Promise<void> {
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

/** An immediate-grant single-tab lock (the test tab is always the leader). */
const immediateLock: LockManagerLike = {
  request(_name, options, callback) {
    if (options.signal?.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'))
    return callback(undefined)
  },
}

const noopBus = (): BroadcastChannelLike => ({ postMessage() {}, close() {}, onmessage: null })

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
    this.stateCb?.({ '@type': 'StateChange', changed: { [ACC]: {} } } as StateChange)
  }
}

interface PortScript {
  emails: string[]
  setEmails: (args: unknown) => PortSetResult
}

function fakePort(script: PortScript): JmapPort & { setEmailsCalls: unknown[] } {
  const setEmailsCalls: unknown[] = []
  return {
    accountId: ACC,
    setEmailsCalls,
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
            totalEmails: script.emails.length,
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
            },
            isSubscribed: true,
          },
        ],
        notFound: [],
        state: 'mbx-1',
      }
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
          subject: id,
          preview: '',
          hasAttachment: false,
        })),
        notFound: [],
        state: 'eml-1',
      }
    },
    async queryEmails() {
      return {
        ids: script.emails,
        queryState: 'q-1',
        canCalculateChanges: true,
        position: 0,
        total: script.emails.length,
      }
    },
    async queryEmailChanges() {
      return { oldQueryState: 'q-1', newQueryState: 'q-1', removed: [], added: [] }
    },
    async setEmails(args) {
      setEmailsCalls.push(args)
      return script.setEmails(args)
    },
    async setMailboxes() {
      return emptySet()
    },
  }
}

function makeDeps(db: ReplicaDb, port: JmapPort, push: FakePush): SyncEngineDeps {
  let t = 1000
  const clock: EngineClock = {
    now: () => t++,
    setTimeout: () => 0, // safety sweep captured but never fires in tests
    clearTimeout: () => {},
  }
  return {
    db,
    port,
    session: {} as Session,
    auth: { scheme: 'bearer', authorization: () => 'x' },
    config: { cacheDays: 30 },
    clock,
    locks: immediateLock,
    createBus: noopBus,
    createPush: () => push,
    isOnline: () => true,
    onOnlineChange: () => () => {},
  }
}

let db: ReplicaDb

beforeEach(() => {
  db = freshDb()
  setEngineStatus(INITIAL_ENGINE_STATUS)
})

afterEach(async () => {
  await db.delete()
})

describe('SyncEngine', () => {
  it('becomes leader and runs an initial sync into the replica', async () => {
    const port = fakePort({ emails: ['e1', 'e2'], setEmails: emptySet })
    const push = new FakePush()
    const engine = new SyncEngine(makeDeps(db, port, push))

    engine.start()
    await waitFor(() => engine.getStatus().phase === 'idle' && engine.getStatus().isLeader)

    expect(push.opened).toBe(true)
    expect(await db.mailboxes.get([ACC, 'inbox'])).toBeDefined()
    expect(await db.emails.get([ACC, 'e1'])).toBeDefined()
    expect((await db.emails.count()) >= 2).toBe(true)
    expect(getEngineStatus().lastSyncedAt).not.toBeNull()

    await engine.stop()
    expect(push.closed).toBe(true)
  })

  it('re-syncs when push delivers a StateChange', async () => {
    const port = fakePort({ emails: ['e1'], setEmails: emptySet })
    const push = new FakePush()
    const engine = new SyncEngine(makeDeps(db, port, push))
    engine.start()
    await waitFor(() => engine.getStatus().phase === 'idle')
    const firstSync = getEngineStatus().lastSyncedAt

    push.fireStateChange()
    await waitFor(() => getEngineStatus().lastSyncedAt !== firstSync)

    expect(getEngineStatus().lastSyncedAt).not.toBe(firstSync)
    await engine.stop()
  })

  it('optimistically applies a dispatched action and replays it', async () => {
    const port = fakePort({ emails: ['e1'], setEmails: emptySet })
    const push = new FakePush()
    const engine = new SyncEngine(makeDeps(db, port, push))
    engine.start()
    await waitFor(() => engine.getStatus().phase === 'idle')

    await engine.dispatch(
      { kind: 'setKeywords', emailIds: ['e1'], keyword: '$seen', value: true },
      {
        id: 'intent-1',
      },
    )

    // Optimistic: the email now carries $seen.
    const optimistic = await db.emails.get([ACC, 'e1'])
    expect(optimistic?.keywords.$seen).toBe(true)

    // Replay confirms and clears the outbox.
    await waitFor(async () => (await db.outbox.count()) === 0)
    expect(port.setEmailsCalls.length).toBeGreaterThan(0)

    await engine.stop()
  })

  it('routes a background 401 to the re-auth funnel instead of a stuck error (M1.3 review)', async () => {
    const base = fakePort({ emails: [], setEmails: emptySet })
    const port: JmapPort = {
      ...base,
      getMailboxes: async () => {
        throw new JmapHttpError(401, '')
      },
    }
    const push = new FakePush()
    let expired = 0
    const engine = new SyncEngine({
      ...makeDeps(db, port, push),
      onAuthExpired: () => (expired += 1),
    })

    engine.start()
    await waitFor(() => expired > 0)

    expect(getEngineStatus().phase).not.toBe('error')
    await engine.stop()
  })
})
