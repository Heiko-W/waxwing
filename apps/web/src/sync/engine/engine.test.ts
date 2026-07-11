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
import { putEmails } from '../repo'
import { email, freshDb } from '../test-utils'
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

  it('cancelSend returns false once the grace has elapsed / the row is gone', async () => {
    const engine = new SyncEngine(
      fixedClockDeps(fakePort({ emails: [], setEmails: emptySet }), new FakePush()),
    )
    engine.start()
    await waitFor(() => engine.getStatus().isLeader && engine.getStatus().phase === 'idle')
    await db.outbox.put({
      accountId: ACC,
      id: 'draft:d1',
      type: 'sendEmail',
      payload: intent,
      ifInState: null,
      status: 'pending',
      attempts: 0,
      createdAt: 1,
      lastError: null,
      notBefore: NOW - 1000, // grace already elapsed
    })
    expect(await engine.cancelSend('draft:d1')).toBe(false)
    expect(await db.outbox.get([ACC, 'draft:d1'])).toBeDefined() // untouched
    expect(await engine.cancelSend('nope')).toBe(false)
    await engine.stop()
  })
})
