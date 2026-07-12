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
import type { DraftRow, ReplicaDb } from '../db'
import { getQueryCache, putEmails } from '../repo'
import { email, freshDb } from '../test-utils'
import type { BroadcastChannelLike } from './bus'
import { MAINTENANCE_INTERVAL_MS, SyncEngine, type SyncEngineDeps } from './engine'
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
    async getIdentities() {
      return {
        list: [
          {
            id: 'id-1',
            name: 'Me',
            email: `me@${'x.test'}`,
            replyTo: null,
            bcc: null,
            textSignature: '',
            htmlSignature: '',
            mayDelete: false,
          },
        ],
        notFound: [],
        state: 'idn-1',
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
    async submitEmail() {
      return emptySet()
    },
    async getSearchSnippets() {
      return { list: [], notFound: [] }
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
    config: { cacheDays: 30, maxStorageMB: 512 },
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
    expect(await db.identities.get([ACC, 'id-1'])).toBeDefined() // M2.5 one-shot Identity/get
    expect(getEngineStatus().lastSyncedAt).not.toBeNull()

    await engine.stop()
    expect(push.closed).toBe(true)
  })

  it('fetches identities once per session, not on every sync sweep (M2.5)', async () => {
    const base = fakePort({ emails: ['e1'], setEmails: emptySet })
    let identityCalls = 0
    const port: JmapPort = {
      ...base,
      getIdentities: async () => {
        identityCalls += 1
        return { list: [], notFound: [], state: 'idn-1' }
      },
    }
    const push = new FakePush()
    const engine = new SyncEngine(makeDeps(db, port, push))
    engine.start()
    await waitFor(() => engine.getStatus().phase === 'idle')
    const firstSync = getEngineStatus().lastSyncedAt

    push.fireStateChange() // a second sync pass
    await waitFor(() => getEngineStatus().lastSyncedAt !== firstSync)

    expect(identityCalls).toBe(1)
    await engine.stop()
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

  it('fetchBody fetches a message body into the replica, then LRU-touches on re-open (M1.8)', async () => {
    const structure = { partId: '1', blobId: 'b', size: 1 } as never
    const base = fakePort({ emails: [], setEmails: emptySet })
    let calls = 0
    const port: JmapPort = {
      ...base,
      getEmailBodies: async (ids) => {
        calls += 1
        return {
          list: ids.map((id) => ({
            id,
            bodyValues: { t: { value: 'hi', isEncodingProblem: false, isTruncated: false } },
            bodyStructure: structure,
            textBody: [structure],
            htmlBody: [],
            attachments: [],
            hasAttachment: false,
          })),
          notFound: [],
          state: 'b1',
        }
      },
    }
    const engine = new SyncEngine(makeDeps(db, port, new FakePush()))

    await engine.fetchBody('e1')
    expect((await db.emailBodies.get([ACC, 'e1']))?.bodyValues.t?.value).toBe('hi')
    expect(calls).toBe(1)

    // Re-open: cached → no re-fetch, only an LRU touch.
    await engine.fetchBody('e1')
    expect(calls).toBe(1)
  })

  it('fetchEnvelopes hydrates only the thread members missing from the replica (M1.8)', async () => {
    const base = fakePort({ emails: [], setEmails: emptySet })
    const requested: string[][] = []
    const port: JmapPort = {
      ...base,
      getEmailEnvelopes: async (ids) => {
        requested.push([...ids])
        return {
          list: ids.map((id) => ({
            id,
            blobId: `b-${id}`,
            threadId: 't1',
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
    }
    const engine = new SyncEngine(makeDeps(db, port, new FakePush()))

    await engine.fetchEnvelopes(['e1'])
    expect(await db.emails.get([ACC, 'e1'])).toBeDefined()
    expect(requested).toEqual([['e1']])

    // e1 is now cached → a second call fetches only the still-missing e2.
    await engine.fetchEnvelopes(['e1', 'e2'])
    expect(await db.emails.get([ACC, 'e2'])).toBeDefined()
    expect(requested).toEqual([['e1'], ['e2']])
  })
})

describe('SyncEngine — undo-send (M2.8)', () => {
  const NOW = 5000
  function fixedClockDeps(port: JmapPort, push: FakePush): SyncEngineDeps {
    const clock: EngineClock = { now: () => NOW, setTimeout: () => 0, clearTimeout: () => {} }
    return { ...makeDeps(db, port, push), clock }
  }
  function sendingDraft(): DraftRow {
    return {
      accountId: ACC,
      localId: 'd1',
      serverEmailId: null,
      status: 'sending',
      content: {
        to: [],
        cc: [],
        bcc: [],
        subject: 'Hi',
        body: '<p>x</p>',
        inReplyTo: null,
        references: null,
        fromIdentityId: 'id1',
        fromIdentityHint: null,
        attachments: [],
        sourceEmailId: null,
        sourceFlag: null,
      },
      createdAt: 0,
      updatedAt: 1,
      lastError: null,
      notBefore: null,
    } as DraftRow
  }
  const intent = {
    kind: 'sendEmail',
    localId: 'd1',
    emailCreationId: 'send-d1',
    submissionCreationId: 'sub-d1',
    priorServerId: null,
    email: { mailboxIds: { 'mb-d': true } },
    identityId: 'id1',
    envelope: { mailFrom: { email: 'me@x.test' }, rcptTo: [{ email: 'a@x.test' }] },
    onSuccessUpdateEmail: {},
    source: { emailId: 'src-9', keyword: '$answered' },
  } as unknown as Parameters<SyncEngine['dispatch']>[0]

  it('cancelSend within the grace deletes the queued send and rolls back the source flag', async () => {
    const port = fakePort({ emails: [], setEmails: emptySet })
    const engine = new SyncEngine(fixedClockDeps(port, new FakePush()))
    engine.start()
    await waitFor(() => engine.getStatus().isLeader && engine.getStatus().phase === 'idle')
    await putEmails(db, ACC, [email('src-9', { keywords: {} })])
    await db.drafts.put(sendingDraft())

    await engine.dispatch(intent, { id: 'draft:d1', notBefore: NOW + 15000 })
    await flush()
    expect((await db.emails.get([ACC, 'src-9']))?.keywords).toEqual({ $answered: true }) // optimistic
    expect((await db.outbox.get([ACC, 'draft:d1']))?.status).toBe('pending') // gated, not sent

    expect(await engine.cancelSend('draft:d1')).toBe(true)
    expect(await db.outbox.get([ACC, 'draft:d1'])).toBeUndefined()
    expect((await db.emails.get([ACC, 'src-9']))?.keywords).toEqual({}) // source flag rolled back
    expect((await db.drafts.get([ACC, 'd1']))?.status).toBe('pending') // draft editable again
    await engine.stop()
  })

  /**
   * M3.3 (Q5): the ONLY safety property is "the submission has not been dispatched" — which is
   * exactly `status === 'pending'`, enforced transactionally against replay's claim-to-`inflight`.
   * The old `notBefore` check added no safety and made an offline-queued or backed-off send
   * (whose grace elapsed long ago, but which provably has NOT been sent) uncancelable.
   */
  it('cancelSend still works after the grace has elapsed, while the row is pending', async () => {
    const engine = new SyncEngine(
      fixedClockDeps(fakePort({ emails: [], setEmails: emptySet }), new FakePush()),
    )
    engine.start()
    await waitFor(() => engine.getStatus().isLeader && engine.getStatus().phase === 'idle')
    await db.drafts.put(sendingDraft())
    await db.outbox.put({
      accountId: ACC,
      id: 'send:d1',
      type: 'sendEmail',
      payload: intent,
      ifInState: null,
      status: 'pending',
      attempts: 3,
      createdAt: 1,
      lastError: 'serverUnavailable',
      notBefore: NOW - 1000, // grace long elapsed
      nextAttemptAt: NOW + 60_000, // and backed off
      undo: { kind: 'none' },
      conflict: null,
      refreshes: 0,
    })

    expect(await engine.cancelSend('send:d1')).toBe(true)
    expect(await db.outbox.get([ACC, 'send:d1'])).toBeUndefined()
    expect((await db.drafts.get([ACC, 'd1']))?.status).toBe('pending') // editable again
    await engine.stop()
  })

  it('cancelSend returns false once the row is inflight (dispatched) or gone', async () => {
    const engine = new SyncEngine(
      fixedClockDeps(fakePort({ emails: [], setEmails: emptySet }), new FakePush()),
    )
    engine.start()
    await waitFor(() => engine.getStatus().isLeader && engine.getStatus().phase === 'idle')
    await db.outbox.put({
      accountId: ACC,
      id: 'send:d1',
      type: 'sendEmail',
      payload: intent,
      ifInState: null,
      status: 'inflight', // replay claimed it — the submission is in the air
      attempts: 0,
      createdAt: 1,
      lastError: null,
      notBefore: null,
    })
    expect(await engine.cancelSend('send:d1')).toBe(false)
    expect(await db.outbox.get([ACC, 'send:d1'])).toBeDefined() // untouched
    expect(await engine.cancelSend('nope')).toBe(false)
    await engine.stop()
  })
})

describe('SyncEngine — cache maintenance (M3.4)', () => {
  /** A lock that is never granted — a FOLLOWER tab (it rejects on abort, exactly like Web Locks). */
  const contendedLock: LockManagerLike = {
    request(_name, options) {
      return new Promise((_resolve, reject) => {
        const abort = () => reject(new DOMException('aborted', 'AbortError'))
        if (options.signal?.aborted) abort()
        else options.signal?.addEventListener('abort', abort)
      })
    },
  }

  /** A clock the test drives; the safety sweep never fires, so nothing runs behind our back. */
  function virtualClock(start = 1_000) {
    let now = start
    const clock: EngineClock = {
      now: () => now,
      setTimeout: () => 0,
      clearTimeout: () => {},
    }
    return {
      clock,
      advance(ms: number): void {
        now += ms
      },
    }
  }

  /** A body row with no envelope — an ORPHAN, which every pass drops unconditionally. */
  async function seedOrphan(id: string): Promise<void> {
    await db.emailBodies.put({
      accountId: ACC,
      id,
      bodyValues: {},
      bodyStructure: {} as never,
      textBody: [],
      htmlBody: [],
      attachments: [],
      hasAttachment: false,
      fetchedAt: 0,
      lastAccessedAt: 0,
      bytes: 1024,
      ablob: [],
    })
  }

  const orphanGone = async (id: string): Promise<boolean> =>
    (await db.emailBodies.get([ACC, id])) === undefined

  function maintenanceDeps(
    time: ReturnType<typeof virtualClock>,
    push: FakePush,
    over: Partial<SyncEngineDeps> = {},
  ): SyncEngineDeps {
    const port = fakePort({ emails: [], setEmails: emptySet })
    return {
      ...makeDeps(db, port, push),
      clock: time.clock,
      estimate: async () => null,
      ...over,
    }
  }

  it('runs ONCE after the first leader sync, then honours the interval gate', async () => {
    const time = virtualClock()
    const push = new FakePush()
    const engine = new SyncEngine(maintenanceDeps(time, push))
    await seedOrphan('first')

    engine.start()
    await waitFor(() => engine.getStatus().phase === 'idle')
    await waitFor(() => orphanGone('first')) // the first pass after taking leadership always runs

    // A second sync a minute later must NOT evict again — cache policy is not a per-sweep job.
    await seedOrphan('second')
    time.advance(60_000)
    push.fireStateChange()
    await waitFor(() => engine.getStatus().phase === 'idle')
    await flush()
    expect(await orphanGone('second')).toBe(false)

    // …but once the interval has elapsed, the next sync does run one.
    time.advance(MAINTENANCE_INTERVAL_MS)
    push.fireStateChange()
    await waitFor(() => orphanGone('second'))

    await engine.stop()
  })

  it('a FOLLOWER never runs a periodic pass (single-writer discipline)', async () => {
    const time = virtualClock()
    const engine = new SyncEngine(maintenanceDeps(time, new FakePush(), { locks: contendedLock }))
    await seedOrphan('untouched')

    engine.start()
    await flush()
    expect(engine.getStatus().isLeader).toBe(false)
    expect(await engine.runMaintenance()).toBeNull() // refused: this tab holds no lock
    expect(await orphanGone('untouched')).toBe(false)

    // A USER-forced pass is still allowed on any tab: the deletes are idempotent and transactional,
    // and a tab that just hit a full disk must be able to do something about it.
    const result = await engine.runMaintenance({ force: true })
    expect(result?.evicted.bodyIds).toEqual(['untouched'])
    expect(await orphanGone('untouched')).toBe(true)

    await engine.stop()
  })

  it('a forced pass bypasses the interval gate', async () => {
    const time = virtualClock()
    const engine = new SyncEngine(maintenanceDeps(time, new FakePush()))
    engine.start()
    await waitFor(() => engine.getStatus().phase === 'idle')

    await seedOrphan('now-please')
    expect(await engine.runMaintenance()).toBeNull() // gated — the initial pass just ran
    expect(await orphanGone('now-please')).toBe(false)

    const forced = await engine.runMaintenance({ force: true })
    expect(forced?.evicted.bodyIds).toEqual(['now-please'])

    await engine.stop()
  })

  it('stop() awaits an in-flight pass, so a wipe cannot race it into a closed database', async () => {
    const time = virtualClock()
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    // The gate only closes AFTER the engine has settled, so the initial leader pass is not blocked.
    let blocking = false
    let passFinished = false
    const engine = new SyncEngine(
      maintenanceDeps(time, new FakePush(), {
        estimate: async () => {
          if (blocking) await gate
          return null
        },
      }),
    )
    engine.start()
    await waitFor(() => engine.getStatus().phase === 'idle')

    blocking = true
    const pass = engine.runMaintenance({ force: true }).then(() => {
      passFinished = true
    })
    await flush()

    let finishedBeforeStopResolved = false
    const stopping = engine.stop().then(() => {
      finishedBeforeStopResolved = passFinished
    })

    release()
    await pass
    await stopping
    // stop() cannot resolve while a pass is still deleting rows — otherwise the sign-out path's
    // wipeReplica() would delete the database out from under it (DatabaseClosedError).
    expect(finishedBeforeStopResolved).toBe(true)
  })
})

describe('SyncEngine — search (M3.1)', () => {
  it('watchQuery backfills a search window into queryCache; unwatchQuery drops the watch', async () => {
    const port = fakePort({ emails: ['e1', 'e2'], setEmails: emptySet })
    const engine = new SyncEngine(makeDeps(db, port, new FakePush()))
    engine.start()
    await waitFor(() => engine.getStatus().isLeader && engine.getStatus().phase === 'idle')

    const spec = {
      filter: { text: 'hello' },
      sort: [{ property: 'receivedAt', isAscending: false }],
      collapseThreads: true,
    }
    const key = engine.watchQuery(spec)
    expect(engine.watchQuery(spec)).toBe(key) // idempotent — same canonical key
    await waitFor(async () => (await getQueryCache(db, ACC, key)) !== undefined)
    expect((await getQueryCache(db, ACC, key))?.ids).toEqual(['e1', 'e2'])
    // The window row is written BEFORE its envelopes (M3.4: it is what makes those ids un-prunable),
    // so its presence no longer means the backfill is finished. Wait for the envelopes themselves, or
    // the test tears the database down underneath a backfill that is still running.
    await waitFor(async () => (await db.emails.where('accountId').equals(ACC).count()) === 2)

    engine.unwatchQuery(key) // no throw; the search window is no longer kept fresh
    await engine.stop()
  })
})

describe('SyncEngine — queue accounting + dead letters (M3.3)', () => {
  /** A port whose `Email/set` rejects every object with the given SetError type. */
  function rejectingPort(type: string): JmapPort & { setEmailsCalls: unknown[] } {
    const base = fakePort({ emails: [], setEmails: emptySet })
    return {
      ...base,
      async setEmails(args) {
        base.setEmailsCalls.push(args)
        const update = (args as { update?: Record<string, unknown> }).update ?? {}
        const notUpdated: Record<string, { type: string }> = {}
        for (const id of Object.keys(update)) notUpdated[id] = { type }
        return { ...emptySet(), notUpdated }
      },
    }
  }

  async function leaderWith(port: JmapPort): Promise<SyncEngine> {
    const engine = new SyncEngine(makeDeps(db, port, new FakePush()))
    engine.start()
    await waitFor(() => engine.getStatus().isLeader && engine.getStatus().phase === 'idle')
    return engine
  }

  it('counts pending vs failed separately — a dead letter never inflates pendingActions (D4)', async () => {
    await putEmails(db, ACC, [email('e1', { keywords: {} })])
    const engine = await leaderWith(rejectingPort('forbidden'))

    await engine.dispatch(
      { kind: 'setKeywords', emailIds: ['e1'], keyword: '$seen', value: true },
      { id: 'i1' },
    )
    await waitFor(() => engine.getStatus().failedActions === 1)

    expect(engine.getStatus().pendingActions).toBe(0) // the dead letter is NOT "pending"
    expect(engine.getStatus().stuckActions).toBe(0)
    expect((await db.emails.get([ACC, 'e1']))?.keywords).toEqual({}) // rolled back from the row's undo
    await engine.stop()
  })

  it('retryFailed re-applies the optimistic change, arms a fresh undo and requeues', async () => {
    await putEmails(db, ACC, [email('e1', { keywords: {} })])
    let reject = true
    const base = fakePort({ emails: [], setEmails: emptySet })
    const port: JmapPort = {
      ...base,
      async setEmails() {
        if (reject) return { ...emptySet(), notUpdated: { e1: { type: 'forbidden' } } }
        return { ...emptySet(), updated: ['e1'] }
      },
    }
    const engine = await leaderWith(port)
    await engine.dispatch(
      { kind: 'setKeywords', emailIds: ['e1'], keyword: '$seen', value: true },
      { id: 'i1' },
    )
    await waitFor(() => engine.getStatus().failedActions === 1)

    reject = false
    expect(await engine.retryFailed('i1')).toBe(true)
    await waitFor(async () => (await db.outbox.count()) === 0)
    expect((await db.emails.get([ACC, 'e1']))?.keywords).toEqual({ $seen: true }) // re-applied + confirmed
    expect(engine.getStatus().failedActions).toBe(0)
    await engine.stop()
  })

  /**
   * `retryFailed` re-applies the optimistic change INSIDE an `rw` transaction, and a destroy's
   * optimistic apply is `deleteEmails` — which (M3.4) also cascades to `emailBodies`. Dexie requires a
   * sub-transaction's tables to be a SUBSET of its parent's, so the parent must name `emailBodies` too
   * or every retried destroy throws.
   */
  it('retryFailed works for a destroy, whose optimistic apply cascades into emailBodies (M3.4)', async () => {
    await putEmails(db, ACC, [email('e1', { keywords: {} })])
    await db.emailBodies.put({
      accountId: ACC,
      id: 'e1',
      bodyValues: {},
      bodyStructure: {} as never,
      textBody: [],
      htmlBody: [],
      attachments: [],
      hasAttachment: false,
      fetchedAt: 1,
      lastAccessedAt: 1,
      bytes: 2048,
      ablob: [],
    })
    let reject = true
    const base = fakePort({ emails: [], setEmails: emptySet })
    const port: JmapPort = {
      ...base,
      async setEmails() {
        if (reject) return { ...emptySet(), notDestroyed: { e1: { type: 'forbidden' } } }
        return { ...emptySet(), destroyed: ['e1'] }
      },
    }
    const engine = await leaderWith(port)
    await engine.dispatch({ kind: 'destroyEmails', emailIds: ['e1'] }, { id: 'i1' })
    await waitFor(() => engine.getStatus().failedActions === 1)
    expect(await db.emails.get([ACC, 'e1'])).toBeDefined() // rolled back (re-fetched)

    reject = false
    expect(await engine.retryFailed('i1')).toBe(true)
    await waitFor(async () => (await db.outbox.count()) === 0)
    expect(await db.emails.get([ACC, 'e1'])).toBeUndefined()
    expect(await db.emailBodies.get([ACC, 'e1'])).toBeUndefined() // and its body went with it
    await engine.stop()
  })

  it('retryFailed BAILS while the rollback is still owed (else the change is applied twice)', async () => {
    await putEmails(db, ACC, [email('e1', { keywords: {} })])
    const engine = await leaderWith(rejectingPort('forbidden'))
    await engine.dispatch(
      { kind: 'setKeywords', emailIds: ['e1'], keyword: '$seen', value: true },
      { id: 'i1' },
    )
    await waitFor(() => engine.getStatus().failedActions === 1)
    // Force the "rollback still owed" state (a re-fetch that could not reach the server).
    await db.outbox.update([ACC, 'i1'], { undo: { kind: 'keywords', keyword: '$seen', had: [] } })

    expect(await engine.retryFailed('i1')).toBe(false)
    expect((await db.outbox.get([ACC, 'i1']))?.status).toBe('error') // untouched
    await engine.stop()
  })

  it('never retries a rejected send (EmailSubmission is not idempotent)', async () => {
    const engine = await leaderWith(fakePort({ emails: [], setEmails: emptySet }))
    await db.outbox.put({
      accountId: ACC,
      id: 'send:d1',
      type: 'sendEmail',
      payload: { kind: 'sendEmail', localId: 'd1', source: null },
      ifInState: null,
      status: 'error',
      attempts: 1,
      createdAt: 1,
      lastError: 'forbiddenToSend',
      notBefore: null,
      undo: null,
      conflict: {
        code: 'sendRejected',
        errorType: 'forbiddenToSend',
        detail: null,
        ids: [],
        at: 1,
      },
    })

    expect(await engine.retryFailed('send:d1')).toBe(false)
    expect(await db.outbox.get([ACC, 'send:d1'])).toBeDefined()
    await engine.stop()
  })

  it('discardFailed / discardAllFailed drop dead letters once their rollback has run', async () => {
    await putEmails(db, ACC, [email('e1', { keywords: {} }), email('e2', { keywords: {} })])
    const engine = await leaderWith(rejectingPort('forbidden'))
    await engine.dispatch(
      { kind: 'setKeywords', emailIds: ['e1'], keyword: '$seen', value: true },
      { id: 'i1' },
    )
    await engine.dispatch(
      { kind: 'setKeywords', emailIds: ['e2'], keyword: '$seen', value: true },
      { id: 'i2' },
    )
    await waitFor(() => engine.getStatus().failedActions === 2)

    expect(await engine.discardFailed('i1')).toBe(true)
    expect(engine.getStatus().failedActions).toBe(1)
    await engine.discardAllFailed()
    expect(engine.getStatus().failedActions).toBe(0)
    expect(await db.outbox.count()).toBe(0)
    await engine.stop()
  })

  it('a transient delta failure does not starve the outbox (the replay still runs)', async () => {
    await putEmails(db, ACC, [email('e1', { keywords: {} })])
    const base = fakePort({ emails: [], setEmails: emptySet })
    let deltaFails = true
    let sets = 0
    const port: JmapPort = {
      ...base,
      async getMailboxes(ids) {
        if (deltaFails) throw new TypeError('fetch failed')
        return base.getMailboxes(ids)
      },
      async setEmails() {
        sets += 1
        return { ...emptySet(), updated: ['e1'] }
      },
    }
    const engine = new SyncEngine(makeDeps(db, port, new FakePush()))
    engine.start()
    await waitFor(() => engine.getStatus().phase === 'error') // the delta failed…

    await engine.dispatch(
      { kind: 'setKeywords', emailIds: ['e1'], keyword: '$seen', value: true },
      { id: 'i1' },
    )
    // …but the action still replays: the outbox is not held hostage by a broken delta.
    await waitFor(async () => (await db.outbox.count()) === 0)
    expect(sets).toBe(1)
    deltaFails = false
    await engine.stop()
  })
})
