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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DraftRow, ReplicaDb } from '../db'
import { getQueryCache, putEmailBody, putEmails } from '../repo'
import { email, freshDb } from '../test-utils'
import type { BroadcastChannelLike } from './bus'
import {
  isDocumentForeground,
  MAINTENANCE_INTERVAL_MS,
  SyncEngine,
  type SyncEngineDeps,
} from './engine'
import type { LockManagerLike } from './leader'
import { getEngineStatus, setEngineStatus } from './status'
import {
  CannotCalculateChangesError,
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
  /**
   * The options the engine asked `createPush` for. Recorded because the fake used to discard its
   * arguments entirely, which is why nothing on the app side could observe *which* transports the
   * engine requests — the blindness that let decision D2 (SSE-first) sit unimplemented.
   */
  createOptions: Parameters<SyncEngineDeps['createPush']>[1] | undefined
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
    // Contacts (M4.2): safe no-op defaults — runDeltaBlock now pulls address books + cards on every
    // pass, but no engine test here watches a contact query, so an empty replica is the whole story.
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
    createPush: (_session, options) => {
      push.createOptions = options
      return push
    },
    isOnline: () => true,
    onOnlineChange: () => () => {},
    // The cross-tab foreground probe (M3.6). A connected fake bus answers synchronously, so this
    // deadline only ever elapses in the "nobody is there" case — keep it short so the suite is not
    // pacing itself against a 100 ms production timeout.
    foregroundAckMs: 10,
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

  /**
   * A server that lost its history — restored from a backup, reset, or replaced — answers
   * `Foo/changes` with `cannotCalculateChanges` (RFC 8620 §5.2), because the client's cached
   * `sinceState` names a point it no longer has. This is exactly what happens when the dev fixture is
   * recreated under a live session, and it happened to the owner during the B29 hand-check.
   *
   * The query path already recovered (`delta.ts#reconcileQuery`); the TYPE-changes path did not, so
   * one such error stranded the whole app on a red "sync problem" a reload could not clear — the bad
   * state is in IndexedDB. This asserts the engine now resets its states and resyncs in the same
   * pass, landing on `idle`. Deleting the recovery in `runSyncPass` turns it red with `phase: error`.
   */
  it('recovers from cannotCalculateChanges by resetting state and resyncing (not a stuck error)', async () => {
    let failNextEmailChanges = false
    const base = fakePort({ emails: ['e1', 'e2'], setEmails: emptySet })
    const port: JmapPort = {
      ...base,
      async emailChanges(state) {
        if (failNextEmailChanges) {
          failNextEmailChanges = false
          throw new CannotCalculateChangesError()
        }
        return base.emailChanges(state)
      },
    }
    const push = new FakePush()
    const engine = new SyncEngine(makeDeps(db, port, push))
    engine.start()
    await waitFor(() => engine.getStatus().phase === 'idle' && engine.getStatus().isLeader)
    const firstSync = getEngineStatus().lastSyncedAt

    // The server's history is gone: the next `Email/changes` cannot be calculated.
    failNextEmailChanges = true
    push.fireStateChange()

    // It must reach `idle` again — a full resync — NOT settle on `error`.
    await waitFor(() => getEngineStatus().lastSyncedAt !== firstSync)
    expect(getEngineStatus().phase).toBe('idle')
    expect(getEngineStatus().error).toBeNull()
    // The replica is intact: the mailbox and its emails are still there after the resync.
    expect(await db.mailboxes.get([ACC, 'inbox'])).toBeDefined()
    expect(await db.emails.get([ACC, 'e1'])).toBeDefined()
    await engine.stop()
  })

  /**
   * The recovery is bounded by construction, and this pins WHY. The resync resets the type states to
   * null, and every full-pull path (`getMailboxes(null)`, `queryEmails`) calls `Foo/get`/`Foo/query`,
   * NEVER `Foo/changes` — so even a server that fails EVERY `emailChanges` recovers to `idle` rather
   * than looping or erroring. It just pays a full resync on each pass, which is the RFC-sanctioned
   * fallback for a server that cannot compute a delta.
   */
  it('a server that always fails emailChanges recovers to idle, never loops or errors', async () => {
    const base = fakePort({ emails: ['e1'], setEmails: emptySet })
    const port: JmapPort = {
      ...base,
      async emailChanges() {
        throw new CannotCalculateChangesError()
      },
    }
    const push = new FakePush()
    const engine = new SyncEngine(makeDeps(db, port, push))
    engine.start()
    await waitFor(() => engine.getStatus().phase === 'idle')
    const firstSync = getEngineStatus().lastSyncedAt

    // A second pass now hits emailChanges (state was seeded on the first) and must recover, not error.
    push.fireStateChange()
    await waitFor(() => getEngineStatus().lastSyncedAt !== firstSync)
    expect(getEngineStatus().phase).toBe('idle')
    expect(getEngineStatus().error).toBeNull()
    expect(await db.emails.get([ACC, 'e1'])).toBeDefined()
    await engine.stop()
  })

  it('opens push SSE-first: it requests only ["sse","polling"], never the WebSocket (D2)', async () => {
    // Decision D2 (ratified at G1) and ADR-005: a browser cannot authenticate the RFC 8887
    // WebSocket against Stalwart — it cannot set the `Authorization` header on the upgrade — so
    // the engine must exclude it from the transport set rather than merely deprioritise it.
    // Nothing asserted this before, which is exactly how the ratified decision drifted out of the
    // code for a milestone: deleting the argument from openPush() reproduces gap B4 verbatim, and
    // this is the only test in the repo that notices.
    const port = fakePort({ emails: ['e1'], setEmails: emptySet })
    const push = new FakePush()
    const engine = new SyncEngine(makeDeps(db, port, push))
    engine.start()
    await waitFor(() => engine.getStatus().phase === 'idle')

    expect(push.createOptions?.transports).toEqual(['sse', 'polling'])
    expect(push.createOptions?.transports).not.toContain('websocket')
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

  /**
   * M3.8: archiving OFFLINE must show an effect. The list renders the cached `queryCache` window, and
   * the optimistic apply used to patch only `emails.mailboxIds` — so the archived row kept rendering
   * in the Inbox until the SERVER's push echoed the move back. Offline that never comes (and online,
   * an archive dispatched before the push channel connects never gets echoed either), so the row sat
   * there indefinitely. `dispatch` deliberately triggers a REPLAY-ONLY pass (no delta round-trip),
   * and that design stays: a DEPARTURE is fixed by the optimistic apply itself, offline and for free.
   * (An ARRIVAL cannot be — see the sibling test below.)
   */
  it('an offline move leaves the list window without the message, the intent still pending (M3.8)', async () => {
    const port = fakePort({ emails: ['e1', 'e2'], setEmails: emptySet })
    const push = new FakePush()
    const engine = new SyncEngine({ ...makeDeps(db, port, push), isOnline: () => false })
    engine.start()
    await waitFor(() => engine.getStatus().isLeader && engine.getStatus().phase === 'idle')

    const inboxWindow = async () =>
      (await db.queryCache.where('accountId').equals(ACC).toArray())[0]
    expect((await inboxWindow())?.ids).toEqual(['e1', 'e2'])

    await engine.dispatch(
      { kind: 'move', emailIds: ['e1'], from: 'inbox', to: 'archive' },
      {
        id: 'i1',
      },
    )

    // The window the list renders — not just the envelope — no longer holds the archived message.
    expect((await inboxWindow())?.ids).toEqual(['e2'])
    expect((await inboxWindow())?.total).toBe(1)
    expect((await db.emails.get([ACC, 'e1']))?.mailboxIds).toEqual({ archive: true })
    // …and nothing was sent: offline, the intent is durably queued and still pending.
    expect(port.setEmailsCalls).toEqual([])
    expect((await db.outbox.get([ACC, 'i1']))?.status).toBe('pending')
    expect(engine.getStatus().pendingActions).toBe(1)

    await engine.stop()
  })

  /**
   * M3.9, the other half of the M3.8 fix: a move INTO a watched window must become visible without
   * waiting for the server's push echo.
   *
   * An arrival always voids the window's baseline, and the RE-QUERY is what puts the message where the
   * server says it goes. Nothing in the replay path did that, so the re-query rode on the push echo,
   * and before the push channel connects (the first ~second after a boot) on the 60 s sweep. Undo an
   * archive in that gap and the button looks dead for a minute while the server has long since put the
   * mail back. Reproduced live 3/3 against the fixture before this test existed.
   *
   * M3.10 (gap B2) added a local splice on top, so this test can no longer wait on "the row showed
   * up" — the apply already put it there. It waits on the BASELINE coming back instead, and the
   * ordering assertion is now doing double duty: the two envelopes have the same `receivedAt`, our
   * tie-break appended, the server disagrees, and the re-query must win. That is the convergence
   * contract, observed end to end rather than argued.
   *
   * Note there is NO push event here and NO `engine.sync()` — that is the whole point.
   */
  it('a move INTO a watched window re-queries it without a push echo (M3.9)', async () => {
    // The server's truth: e1 sits in Archive, only e2 is in the Inbox.
    const server = { emails: ['e2'] }
    const port = fakePort({
      emails: server.emails,
      // Replaying the move is what makes the server agree that e1 is back in the Inbox.
      setEmails: () => {
        server.emails.unshift('e1')
        return emptySet()
      },
    })
    const push = new FakePush()
    const engine = new SyncEngine(makeDeps(db, port, push))
    engine.start()
    await waitFor(() => engine.getStatus().isLeader && engine.getStatus().phase === 'idle')

    const inboxWindow = async () =>
      (await db.queryCache.where('accountId').equals(ACC).toArray())[0]
    expect((await inboxWindow())?.ids).toEqual(['e2'])

    // e1 exists locally, in Archive — as it would right after an archive + its optimistic prune.
    await putEmails(db, ACC, [email('e1', { mailboxIds: { archive: true } })])

    // The Undo: the inverse move, archive → inbox.
    await engine.dispatch(
      { kind: 'move', emailIds: ['e1'], from: 'archive', to: 'inbox' },
      { id: 'undo-1' },
    )

    // The local splice is immediate but guesses `['e2','e1']` on the tie; the re-query is what makes
    // the order the server's. Waiting on the baseline is waiting on exactly that.
    expect((await inboxWindow())?.ids).toEqual(['e2', 'e1'])
    await waitFor(async () => (await inboxWindow())?.queryState !== null)
    expect((await inboxWindow())?.ids).toEqual(['e1', 'e2'])
    // Re-queried, so the baseline is honest again rather than left null forever.
    expect((await inboxWindow())?.queryState).toBe('q-1')
    expect(push.opened).toBe(true) // the channel exists; it just never delivered anything

    await engine.stop()
  })

  /**
   * M3.10 (gap B2), THE defect: undo an archive while OFFLINE.
   *
   * The test above needs the network for its repair, and offline there is none — `runReplay` puts the
   * whole replay + `reconcileWatched` block behind `isOnline()`. So a message moved INTO a visible
   * window only voided the baseline and then waited for a re-query that would not come until
   * reconnect. The envelope was right, the outbox row was right, and the list was empty: Undo did
   * exactly what it promised and looked broken for the rest of the offline session.
   *
   * Nothing here may touch the port at all. That is the assertion that makes the test about B2 rather
   * than about the reconcile.
   */
  it('an offline move INTO a watched window puts the row in the list, with no server (M3.10)', async () => {
    const base = fakePort({ emails: ['e2', 'e3'], setEmails: emptySet })
    let queries = 0
    let online = true
    const port: JmapPort = {
      ...base,
      async queryEmails(args) {
        queries += 1
        return base.queryEmails(args)
      },
    }
    const engine = new SyncEngine({ ...makeDeps(db, port, new FakePush()), isOnline: () => online })
    engine.start()
    await waitFor(() => engine.getStatus().isLeader && engine.getStatus().phase === 'idle')

    const inboxWindow = async () =>
      (await db.queryCache.where('accountId').equals(ACC).toArray())[0]
    expect((await inboxWindow())?.ids).toEqual(['e2', 'e3'])
    // The fake port dates every envelope alike; give the two rows an order of their own so the
    // assertion below is about the PLACEMENT and not about a tie-break.
    await putEmails(db, ACC, [
      email('e2', { mailboxIds: { inbox: true }, receivedAt: '2026-07-05T00:00:00Z' }),
      email('e3', { mailboxIds: { inbox: true }, receivedAt: '2026-07-02T00:00:00Z' }),
    ])

    // Now go offline, and archive `e2` — the optimistic prune (M3.8) already worked offline.
    online = false
    await engine.dispatch(
      { kind: 'move', emailIds: ['e2'], from: 'inbox', to: 'archive' },
      { id: 'a' },
    )
    expect((await inboxWindow())?.ids).toEqual(['e3'])

    const queriesBefore = queries
    // …and Undo it. The inverse move's destination is the window the row was archived out of.
    await engine.dispatch(
      { kind: 'move', emailIds: ['e2'], from: 'archive', to: 'inbox' },
      { id: 'b' },
    )

    // Back in the list, in the same frame, at the index its own envelope proves.
    expect((await inboxWindow())?.ids).toEqual(['e2', 'e3'])
    expect((await inboxWindow())?.queryState).toBeNull() // …and still marked for the eventual re-query
    expect(queries).toBe(queriesBefore) // NOTHING was asked of the server
    expect(base.setEmailsCalls).toEqual([])
    expect(engine.getStatus().pendingActions).toBe(2)

    await engine.stop()
  })

  /**
   * The online repair is DOUBLE-gated and this is what that costs: `runReplay` only reconciles once
   * the outbox has DRAINED (a re-query cannot reflect an intent we have not sent — see the trap test
   * below). So during a triage burst a locally placed row keeps OUR index across several passes, not
   * one. That is acceptable — it is coherent, and the alternative is not showing the row at all — but
   * it must be true that it stays coherent, not that it flickers or duplicates.
   */
  it('a locally placed row stays coherent through a burst, until the queue drains (M3.10)', async () => {
    const server = ['e3']
    let released: (() => void) | undefined
    const base = fakePort({ emails: server, setEmails: emptySet })
    const port: JmapPort = {
      ...base,
      async setEmails(args) {
        // Hold the FIRST replay open so the second dispatch lands with work still queued.
        if (released === undefined) {
          await new Promise<void>((resolve) => {
            released = resolve
          })
        }
        const update = (args as { update?: Record<string, unknown> }).update ?? {}
        for (const id of Object.keys(update)) if (!server.includes(id)) server.unshift(id)
        return emptySet()
      },
    }
    const engine = new SyncEngine(makeDeps(db, port, new FakePush()))
    engine.start()
    await waitFor(() => engine.getStatus().isLeader && engine.getStatus().phase === 'idle')

    const inboxWindow = async () =>
      (await db.queryCache.where('accountId').equals(ACC).toArray())[0]
    expect((await inboxWindow())?.ids).toEqual(['e3'])

    await putEmails(db, ACC, [
      email('e1', { mailboxIds: { archive: true }, receivedAt: '2026-07-03T00:00:00Z' }),
      email('e2', { mailboxIds: { archive: true }, receivedAt: '2026-07-02T00:00:00Z' }),
    ])
    await engine.dispatch(
      { kind: 'move', emailIds: ['e1'], from: 'archive', to: 'inbox' },
      { id: 'a' },
    )
    await waitFor(() => released !== undefined) // pass 1 is blocked inside setEmails
    await engine.dispatch(
      { kind: 'move', emailIds: ['e2'], from: 'archive', to: 'inbox' },
      { id: 'b' },
    )

    // Two arrivals, both placed, in date order — with a pass still mid-flight and a row still queued.
    expect((await inboxWindow())?.ids).toEqual(['e1', 'e2', 'e3'])
    expect((await inboxWindow())?.queryState).toBeNull()
    released?.()

    await waitFor(async () => (await db.outbox.where('accountId').equals(ACC).count()) === 0)
    await waitFor(async () => (await inboxWindow())?.queryState !== null)
    // Only now does the server get a say — and it agrees, with no id twice.
    expect((await inboxWindow())?.ids).toEqual(['e2', 'e1', 'e3'])

    await engine.stop()
  })

  /**
   * M3.10 (gap B1), the cross-module half: the keyword apply only VOIDS the windows a message may have
   * newly entered, so the fix leans entirely on `reconcileWatched(false, true)` picking those up. That
   * selection keys on `queryState === null` ALONE — it never inspects the intent — so a `setKeywords`
   * gets M3.9's immediate re-query for free, with no change in this file. This test is what makes that
   * claim falsifiable: special-case the reconcile on intent kind and it goes red.
   *
   * Again: NO push event and NO `engine.sync()`.
   */
  it('a keyword change into a watched window re-queries it without a push echo (M3.10)', async () => {
    // The server's truth for `?q=is:read`: only e2 is read so far.
    const server = { emails: ['e2'] }
    const port = fakePort({
      emails: server.emails,
      // Replaying the mark-read is what makes the server agree that e1 is read too.
      setEmails: () => {
        server.emails.unshift('e1')
        return emptySet()
      },
    })
    const engine = new SyncEngine(makeDeps(db, port, new FakePush()))
    engine.start()
    await waitFor(() => engine.getStatus().isLeader && engine.getStatus().phase === 'idle')

    const spec = {
      filter: { hasKeyword: '$seen' },
      sort: [{ property: 'receivedAt', isAscending: false }],
      collapseThreads: true,
    }
    const key = engine.watchQuery(spec)
    await waitFor(async () => (await getQueryCache(db, ACC, key))?.ids.length === 1)
    const inboxKey = (await db.queryCache.where('accountId').equals(ACC).toArray()).find(
      (row) => row.key !== key,
    )?.key

    await putEmails(db, ACC, [email('e1', { keywords: {} })])
    await engine.dispatch(
      { kind: 'setKeywords', emailIds: ['e1'], keyword: '$seen', value: true },
      { id: 'i1' },
    )

    await waitFor(async () => (await getQueryCache(db, ACC, key))?.ids.length === 2)
    expect((await getQueryCache(db, ACC, key))?.ids).toEqual(['e1', 'e2'])
    expect((await getQueryCache(db, ACC, key))?.queryState).toBe('q-1') // baseline honest again
    // …and ONLY the voided window: the folder window neither filters nor sorts on `$seen`, so the
    // apply left it alone and the reconcile skipped it.
    // (Its ids, not its queryState: this port answers `q-1` to every query, so only the CONTENT can
    // tell a window that was never re-queried from one that was.)
    expect(inboxKey).toBeDefined()
    expect((await getQueryCache(db, ACC, inboxKey ?? ''))?.ids).toEqual(['e2'])

    await engine.stop()
  })

  /**
   * The trap inside the fix above, found by the M3.8 keyboard E2E (`j o e u x #` — archive one
   * message, trash another a moment later).
   *
   * A re-query answers with the SERVER's list, which cannot possibly reflect an intent still sitting
   * in our outbox. If a second dispatch voids the window while the first pass is mid-flight, that
   * pass re-queries, gets a list that still contains the message the user just trashed, refills the
   * window with it — and restores `queryState`. The pass that finally sends the trash then skips the
   * window as "not voided", and the row stays on screen indefinitely. So: never reconcile with work
   * still queued.
   */
  it('never re-queries a window while an intent is still unsent (M3.9)', async () => {
    // The server's list, mutated only when a set is actually replayed.
    const server = ['e1', 'e2']
    let queries = 0
    let inFlightSet: (() => void) | undefined
    const base = fakePort({ emails: server, setEmails: emptySet })
    const port: JmapPort = {
      ...base,
      async queryEmails() {
        queries += 1
        return {
          ids: [...server],
          queryState: `q-${queries}`,
          canCalculateChanges: true,
          position: 0,
          total: server.length,
        }
      },
      async setEmails(args) {
        // Hold the FIRST set open so the second dispatch lands while this pass is mid-flight —
        // the exact interleaving the E2E hit by hand.
        if (inFlightSet === undefined) {
          await new Promise<void>((resolve) => {
            inFlightSet = resolve
          })
        }
        const update = (args as { update?: Record<string, unknown> }).update ?? {}
        for (const id of Object.keys(update)) {
          const at = server.indexOf(id)
          if (at !== -1) server.splice(at, 1)
        }
        return emptySet()
      },
    }
    const engine = new SyncEngine(makeDeps(db, port, new FakePush()))
    engine.start()
    await waitFor(() => engine.getStatus().isLeader && engine.getStatus().phase === 'idle')

    const inboxWindow = async () =>
      (await db.queryCache.where('accountId').equals(ACC).toArray())[0]
    expect((await inboxWindow())?.ids).toEqual(['e1', 'e2'])

    await engine.dispatch(
      { kind: 'move', emailIds: ['e1'], from: 'inbox', to: 'archive' },
      { id: 'a' },
    )
    await waitFor(() => inFlightSet !== undefined) // pass 1 is now blocked inside setEmails
    // …and now the user trashes e2, voiding the window a second time.
    await engine.dispatch(
      { kind: 'move', emailIds: ['e2'], from: 'inbox', to: 'trash' },
      { id: 'b' },
    )
    expect((await inboxWindow())?.ids).toEqual([]) // both pruned optimistically
    inFlightSet?.()

    await waitFor(async () => (await db.outbox.where('accountId').equals(ACC).count()) === 0)
    await waitFor(async () => (await inboxWindow())?.queryState !== null)
    // The window must NOT have been refilled from a server list that predated the trash.
    expect((await inboxWindow())?.ids).toEqual([])

    await engine.stop()
  })

  /**
   * M3.10, gap B7 — the ORDERING hazard, which no other test can see.
   *
   * `syncMailboxes` runs as the FIRST statement of a sync pass, before the replay, and it writes the
   * server's ABSOLUTE `unreadEmails`. So a pass firing while an intent is still unsent can overwrite
   * the optimistic badge with the server's PRE-mutation number, and it stays reverted until the
   * intent lands. It needs a CONCURRENT server-side change to that same mailbox — which is not
   * exotic: new mail arriving in the Inbox is exactly that, and the Inbox is where marking-read
   * happens.
   *
   * THE FIXTURE IS THE TEST. `mailboxChanges` must report the mailbox as CHANGED as well as
   * `getMailboxes` returning the stale count: with an empty `changed` list `patchMailboxes` is never
   * called at all, the badge holds for a reason that has nothing to do with the fix, and deleting
   * the re-apply step leaves this green.
   *
   * THE ROW IS HELD UNSENT BY `notBefore`, not by a failing `setEmails`. It used to be the latter,
   * and that was a defect in this test: a THROWN `setEmails` dispatches the row, and the transient
   * branch then returns it to `pending`. So the only row this test ever fed to the re-apply was one
   * whose request had already gone out — exactly the case the re-apply must now REFUSE (see the
   * companion test below). A future `notBefore` keeps the row provably un-dispatched
   * (`attempts === 0`), which is the case this test is actually about.
   */
  it('an UNSENT mark-read survives a pass that rewrites the mailbox — and is never counted twice', async () => {
    const base = fakePort({ emails: ['e1'], setEmails: emptySet })
    let changedProps: string[] | null = null // null ⇒ the server reports no mailbox change at all
    let state = 0
    const port: JmapPort = {
      ...base,
      async mailboxChanges() {
        if (changedProps === null) return emptyChanges(`mbx-${state}`)
        state += 1
        return {
          newState: `mbx-${state}`,
          hasMoreChanges: false,
          created: [],
          updated: ['inbox'],
          destroyed: [],
          updatedProperties: changedProps,
        }
      },
      async getMailboxes(ids) {
        const got = await base.getMailboxes(ids)
        // The server still reports the PRE-mutation count: it has not seen our mark-read.
        return { ...got, list: got.list.map((box) => ({ ...box, unreadEmails: 3 })) }
      },
      async setEmails() {
        // The `notBefore` gate below must keep replay from ever reaching this. If it fires, the row
        // has been dispatched and this test is no longer testing what it claims to.
        throw new Error('replay must not dispatch a row held by notBefore')
      },
    }
    const push = new FakePush()
    const engine = new SyncEngine(makeDeps(db, port, push))
    engine.start()
    await waitFor(() => engine.getStatus().isLeader && engine.getStatus().phase === 'idle')

    const unread = async () => (await db.mailboxes.get([ACC, 'inbox']))?.unreadEmails
    expect(await unread()).toBe(3)

    await engine.dispatch(
      { kind: 'setKeywords', emailIds: ['e1'], keyword: '$seen', value: true },
      { id: 'i1', notBefore: 10_000_000 }, // far past the test clock — never claimed, never sent
    )
    expect(await unread()).toBe(2) // the optimistic badge
    const queued = await db.outbox.get([ACC, 'i1'])
    expect(queued?.status).toBe('pending')
    expect(queued?.attempts).toBe(0) // PROVABLY un-dispatched — the whole precondition

    const pass = async () => {
      const before = getEngineStatus().lastSyncedAt
      push.fireStateChange()
      await waitFor(() => getEngineStatus().lastSyncedAt !== before)
    }

    // 1. The collision: the server reports the Inbox changed (new mail) and hands back its
    //    pre-mutation `unreadEmails`. Without the re-apply the badge silently reverts to 3.
    changedProps = ['totalEmails', 'unreadEmails']
    await pass()
    expect(await unread()).toBe(2)
    expect((await db.outbox.get([ACC, 'i1']))?.status).toBe('pending') // still unsent

    // 2. A pass that changed NOTHING must not re-apply the delta on top of the patch already in the
    //    row — that would be a double-count, and unlike staleness a double-count never corrects.
    changedProps = null
    await pass()
    await pass()
    expect(await unread()).toBe(2)

    // 3. A rename touches the mailbox but NOT its counts: same argument, per field.
    changedProps = ['name']
    await pass()
    expect(await unread()).toBe(2)

    await engine.stop()
  })

  /**
   * The other half of the same design, end to end, and the case the original B7 test accidentally
   * inverted: a row whose request DID go out and came back as a thrown error is returned to
   * `pending` by the transient branch, and its ±1 may ALREADY be in the server's number. Re-applying
   * it there is a double-count, and a double-count does not self-correct — the mailbox is only
   * re-reported when it changes again. So the re-apply must fail CLOSED and leave the server's word
   * standing, accepting a badge that reverts until the intent lands.
   */
  it('does NOT re-apply a mark-read whose request already went out and threw', async () => {
    const base = fakePort({ emails: ['e1'], setEmails: emptySet })
    let changedProps: string[] | null = null
    let state = 0
    const port: JmapPort = {
      ...base,
      async mailboxChanges() {
        if (changedProps === null) return emptyChanges(`mbx-${state}`)
        state += 1
        return {
          newState: `mbx-${state}`,
          hasMoreChanges: false,
          created: [],
          updated: ['inbox'],
          destroyed: [],
          updatedProperties: changedProps,
        }
      },
      async getMailboxes(ids) {
        const got = await base.getMailboxes(ids)
        return { ...got, list: got.list.map((box) => ({ ...box, unreadEmails: 3 })) }
      },
      async setEmails() {
        // A THROWN error says nothing about whether the server processed the request — the response
        // may simply have been lost. The transient branch puts the row back to `pending`.
        throw new TypeError('fetch failed')
      },
    }
    const push = new FakePush()
    const engine = new SyncEngine(makeDeps(db, port, push))
    engine.start()
    await waitFor(() => engine.getStatus().isLeader && engine.getStatus().phase === 'idle')

    const unread = async () => (await db.mailboxes.get([ACC, 'inbox']))?.unreadEmails
    await engine.dispatch(
      { kind: 'setKeywords', emailIds: ['e1'], keyword: '$seen', value: true },
      { id: 'i1' },
    )
    expect(await unread()).toBe(2) // the optimistic badge, applied as always

    // The dispatch-triggered replay throws and launders the row back to `pending` — but with
    // `attempts` incremented, which is what marks it as having been dispatched.
    await waitFor(async () => ((await db.outbox.get([ACC, 'i1']))?.attempts ?? 0) > 0)
    const laundered = await db.outbox.get([ACC, 'i1'])
    expect(laundered?.status).toBe('pending') // `pending` ≠ "never dispatched"

    const before = getEngineStatus().lastSyncedAt
    changedProps = ['totalEmails', 'unreadEmails']
    push.fireStateChange()
    await waitFor(() => getEngineStatus().lastSyncedAt !== before)

    // The server's absolute number stands. Skipping is the SAFE error: it self-corrects the moment
    // the intent lands, whereas a 3 → 2 → 1 double-count would not.
    expect(await unread()).toBe(3)
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

  it('fetchBody writes authResults on every body, so a cached row is never mistaken for legacy (M3.9)', async () => {
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
            bodyValues: {},
            bodyStructure: structure,
            textBody: [structure],
            htmlBody: [],
            attachments: [],
            hasAttachment: false,
            // A message with no Authentication-Results header: the port still says so, with [].
            authResults: [],
          })),
          notFound: [],
          state: 'b1',
        }
      },
    }
    const engine = new SyncEngine(makeDeps(db, port, new FakePush()))

    await engine.fetchBody('e1')
    expect((await db.emailBodies.get([ACC, 'e1']))?.authResults).toEqual([])
    // `[]` is NOT `undefined`: a message that genuinely carries no such header must not re-fetch on
    // every single open.
    await engine.fetchBody('e1')
    expect(calls).toBe(1)
  })

  it('fetchBody re-fetches a body row written before M3.9 rather than waiting for eviction', async () => {
    // The trap this guards: a reader who had already opened a message would NEVER see the new header
    // details, because the early return only checked for the row's existence.
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
            bodyValues: {},
            bodyStructure: structure,
            textBody: [structure],
            htmlBody: [],
            attachments: [],
            hasAttachment: false,
            authResults: ['mx.test; spf=pass'],
          })),
          notFound: [],
          state: 'b1',
        }
      },
    }
    const engine = new SyncEngine(makeDeps(db, port, new FakePush()))

    // A row exactly as a pre-M3.9 build wrote it: no `authResults` key at all. The cast is the
    // point — `putEmailBody` now REQUIRES the field precisely so no new writer can produce this
    // shape by accident, so the one test that needs it must ask for it out loud.
    await putEmailBody(db, {
      accountId: ACC,
      id: 'e1',
      bodyValues: {},
      bodyStructure: structure,
      textBody: [structure],
      htmlBody: [],
      attachments: [],
      hasAttachment: false,
      fetchedAt: 1,
      lastAccessedAt: 1,
    } as unknown as Parameters<typeof putEmailBody>[1])

    await engine.fetchBody('e1')
    expect(calls).toBe(1)
    expect((await db.emailBodies.get([ACC, 'e1']))?.authResults).toEqual(['mx.test; spf=pass'])
    // And now it is current — the next open is a plain LRU touch.
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

  it('fetchContactCards hydrates a card no watched query covers (F3)', async () => {
    // The detail pane's own supply line. Until it existed, a contact card could only enter the
    // replica through a watched `ContactCard/query` — the list pane's — so a phone deep link, which
    // mounts the detail with no list beside it, had no way to obtain the card it was asked to show.
    const base = fakePort({ emails: [], setEmails: emptySet })
    const requested: string[][] = []
    const port: JmapPort = {
      ...base,
      getContactCards: async (ids) => {
        requested.push([...ids])
        return {
          list: ids.map((id) => ({ '@type': 'Card', version: '1.0', uid: `uid-${id}`, id })),
          notFound: [],
          state: 'cc-1',
        } as unknown as Awaited<ReturnType<JmapPort['getContactCards']>>
      },
    }
    const engine = new SyncEngine(makeDeps(db, port, new FakePush()))

    await engine.fetchContactCards(['k1'])
    expect(await db.contactCards.get([ACC, 'k1'])).toBeDefined()
    expect(requested).toEqual([['k1']])

    // Already in the replica → the card the reader opened from the list costs no round-trip.
    await engine.fetchContactCards(['k1', 'k2'])
    expect(await db.contactCards.get([ACC, 'k2'])).toBeDefined()
    expect(requested).toEqual([['k1'], ['k2']])
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

/**
 * M3.6 — the guards around the notifier. Each of these is a bug that would otherwise ship, and every
 * one of them is invisible in a happy-path demo: they only bite on a sign-in, a hand-over, a flaky
 * network, or a second tab.
 */
describe('SyncEngine — new-mail notifications (M3.6)', () => {
  /** A port whose Email/changes reports `created` on every pass AFTER the first. */
  function notifyingPort(): JmapPort {
    const base = fakePort({ emails: ['e1'], setEmails: emptySet })
    let pass = 0
    return {
      ...base,
      async emailChanges(s) {
        pass += 1
        // Note that the FIRST pass already reports a created id. `ensureInboxWindow` → `backfillMailbox`
        // seeds the Email sync state before `syncEmails` runs, so `syncEmails` does NOT return early on
        // pass 1 — it returns a created id like any other pass. That is precisely why the storm guard
        // has to be a real guard rather than an accident of the first pass being empty.
        return {
          newState: `${s}-${pass}`,
          hasMoreChanges: false,
          created: [`new-${pass}`],
          updated: [],
          destroyed: [],
        }
      },
      async getEmailEnvelopes(ids) {
        return { list: ids.map((id) => email(id)), notFound: [], state: 'e' }
      },
    }
  }

  interface NotifyCall {
    ids: string[]
    ctx: { now: number; sinceMs: number }
  }

  function notifySpy() {
    const calls: NotifyCall[] = []
    const notify = async (created: readonly { id: string }[], ctx: NotifyCall['ctx']) => {
      calls.push({ ids: created.map((e) => e.id), ctx })
    }
    return { calls, notify }
  }

  /** Drive one more sync pass and wait for it to land. */
  async function anotherPass(push: FakePush): Promise<void> {
    const before = getEngineStatus().lastSyncedAt
    push.fireStateChange()
    await waitFor(() => getEngineStatus().lastSyncedAt !== before)
  }

  it('never notifies on the FIRST pass of a leadership session — the catch-up storm guard', async () => {
    // Sign-in, a fresh tab, a re-election, a laptop waking after eight hours: that first delta may add
    // hundreds of ids, every one of them "new" to this replica. Silencing it structurally beats trying
    // to date-filter our way out afterwards.
    const push = new FakePush()
    const { calls, notify } = notifySpy()
    const engine = new SyncEngine({
      ...makeDeps(db, notifyingPort(), push),
      notify,
      isForeground: () => false,
    })

    engine.start()
    await waitFor(() => engine.getStatus().phase === 'idle')

    expect(calls).toEqual([])
    await engine.stop()
  })

  it('notifies on a LATER pass, with only the created ids', async () => {
    const push = new FakePush()
    const { calls, notify } = notifySpy()
    const engine = new SyncEngine({
      ...makeDeps(db, notifyingPort(), push),
      notify,
      isForeground: () => false,
    })

    engine.start()
    await waitFor(() => engine.getStatus().phase === 'idle')
    await anotherPass(push)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.ids).toEqual(['new-2'])
    await engine.stop()
  })

  it('never notifies while THIS tab is in the foreground', async () => {
    // No banner for a message the user is watching land.
    const push = new FakePush()
    const { calls, notify } = notifySpy()
    const engine = new SyncEngine({
      ...makeDeps(db, notifyingPort(), push),
      notify,
      isForeground: () => true,
    })

    engine.start()
    await waitFor(() => engine.getStatus().phase === 'idle')
    await anotherPass(push)

    expect(calls).toEqual([])
    await engine.stop()
  })

  it('a tab that never wins the lock never notifies — leader-only, structurally', async () => {
    // Otherwise every open tab raises its own banner for the same message.
    // The lock is held by some other tab and never granted to us — but it still honours the abort
    // signal, exactly as `navigator.locks` does, so `stop()` can complete.
    const neverLeader: LockManagerLike = {
      request(_name, options) {
        return new Promise((_resolve, reject) => {
          const abort = () => reject(new DOMException('aborted', 'AbortError'))
          if (options.signal?.aborted) return abort()
          options.signal?.addEventListener('abort', abort)
        })
      },
    }
    const push = new FakePush()
    const { calls, notify } = notifySpy()
    const engine = new SyncEngine({
      ...makeDeps(db, notifyingPort(), push),
      locks: neverLeader,
      notify,
      isForeground: () => false,
    })

    engine.start()
    await flush()
    await flush()

    expect(engine.getStatus().isLeader).toBe(false)
    expect(calls).toEqual([])
    await engine.stop()
  })

  it('a FAILED pass does not spend the catch-up exemption', async () => {
    // An offline first pass must not burn the "first pass is silent" allowance on nothing — otherwise
    // the real catch-up, once the network returns, buzzes at the user for every mail of the night.
    let failing = true
    const base = notifyingPort()
    const port: JmapPort = {
      ...base,
      async emailChanges(s) {
        if (failing) throw new Error('offline')
        return base.emailChanges(s)
      },
    }
    const push = new FakePush()
    const { calls, notify } = notifySpy()
    const engine = new SyncEngine({
      ...makeDeps(db, port, push),
      notify,
      isForeground: () => false,
    })

    engine.start()
    await waitFor(() => engine.getStatus().phase === 'error')
    expect(calls).toEqual([])

    // The network is back. This pass is the catch-up — still silent.
    failing = false
    push.fireStateChange()
    await waitFor(() => engine.getStatus().phase === 'idle')
    expect(calls).toEqual([])

    // Only now do notifications begin.
    await anotherPass(push)
    expect(calls).toHaveLength(1)
    await engine.stop()
  })

  /*
   * B45 — a notification a FAILED pass skipped is delivered by the retry, not by the next push.
   *
   * `notify.spec.ts` polled 30 s for a new-mail banner and saw none, ~3 minutes into a run against a
   * live Stalwart. The mechanism is visible in `runSyncPass`: a delta error takes the early `return`
   * ABOVE `raiseNewMailNotifications`, so the pass that would have raised the banner raises nothing.
   * Until B47 the next attempt came only with the fixed 60 s safety sweep, and a 30 s poll cannot win
   * that. Nothing was lost — but nothing was announced either, for up to a minute.
   *
   * This is what turns "B45 is plausibly covered by B47" into something checked. It drives the retry
   * by hand rather than firing another push: a push would prove only that a SECOND delivery notifies,
   * which was never in doubt, and is precisely the confusion the original report could not resolve.
   */
  it('delivers on its own retry the notification a failed pass skipped (B45)', async () => {
    let failing = false
    const base = notifyingPort()
    const port: JmapPort = {
      ...base,
      async emailChanges(state) {
        if (failing) throw new Error('the server pushed back')
        return base.emailChanges(state)
      },
    }
    const push = new FakePush()
    const { calls, notify } = notifySpy()
    // Timers the test fires by hand, so the retry happens when this test says so and not on a clock.
    let nextTimer = 1
    const pending: { id: number; fn: () => void; delay: number }[] = []
    let now = 1000
    const engine = new SyncEngine({
      ...makeDeps(db, port, push),
      notify,
      isForeground: () => false,
      clock: {
        now: () => now++,
        setTimeout: (fn, delay) => {
          const id = nextTimer++
          pending.push({ id, fn, delay })
          return id
        },
        clearTimeout: (id) => {
          const at = pending.findIndex((timer) => timer.id === id)
          if (at >= 0) pending.splice(at, 1)
        },
      },
    })

    engine.start()
    await waitFor(() => engine.getStatus().phase === 'idle')
    // Past the first-pass storm guard: notifications are armed from here.
    await anotherPass(push)
    const armed = calls.length

    // A delivery arrives and the pass that should announce it fails.
    failing = true
    push.fireStateChange()
    await waitFor(() => engine.getStatus().phase === 'error')
    expect(calls.length, 'a failed pass must not announce anything').toBe(armed)

    // No further push — only the retry the failed pass scheduled for itself.
    failing = false
    const retry = pending.find((timer) => timer.delay < 60_000)
    expect(retry, 'the failed pass scheduled no retry to deliver on').toBeDefined()
    if (retry) {
      pending.splice(pending.indexOf(retry), 1)
      retry.fn()
    }

    await waitFor(() => engine.getStatus().phase === 'idle')
    expect(calls.length, 'the retry did not deliver the missed notification').toBeGreaterThan(armed)
    await engine.stop()
  })

  it('a notifier that THROWS does not fail the sync pass', async () => {
    const push = new FakePush()
    const engine = new SyncEngine({
      ...makeDeps(db, notifyingPort(), push),
      notify: async () => {
        throw new TypeError('the notification centre is on fire')
      },
      isForeground: () => false,
    })

    engine.start()
    await waitFor(() => engine.getStatus().phase === 'idle')
    await anotherPass(push)

    expect(engine.getStatus().phase).toBe('idle')
    expect(engine.getStatus().error).toBeNull()
    await engine.stop()
  })

  it('stamps the floor ONCE at leadership and never advances it', async () => {
    // The earlier version of this test asserted `sinceMs > 0` and `now >= sinceMs` — both trivially
    // true of the incrementing fake clock, wherever the stamp happened to live. Moving the stamp into
    // `runSyncPass` (i.e. re-flooring on every pass, which destroys the guard outright) left it green.
    // The property is that the floor is IDENTICAL across passes; assert exactly that.
    const push = new FakePush()
    const { calls, notify } = notifySpy()
    const engine = new SyncEngine({
      ...makeDeps(db, notifyingPort(), push),
      notify,
      isForeground: () => false,
    })

    engine.start()
    await waitFor(() => engine.getStatus().phase === 'idle')
    await anotherPass(push)
    await anotherPass(push)

    expect(calls).toHaveLength(2)
    expect(calls[0]?.ctx.sinceMs).toBe(calls[1]?.ctx.sinceMs)
    // …and `now` did move on, so the equality above is a real invariant and not a frozen clock.
    expect(calls[1]?.ctx.now).toBeGreaterThan(calls[0]?.ctx.now ?? 0)
    await engine.stop()
  })

  it('clamps the floor onto the SERVER clock — a client running fast still notifies', async () => {
    // The floor is stamped from the CLIENT clock and compared against the SERVER's `receivedAt`. A
    // machine 30 minutes fast would put the floor half an hour into the server's future, and then
    // NOTHING would ever clear it: no notifications, no error, no diagnostic, for half an hour. The
    // replica's newest `receivedAt` is a timestamp in the server's own units, so the floor is clamped
    // down onto it.
    const serverNewest = Date.parse('2026-07-13T12:00:00Z')
    const clientNow = serverNewest + 30 * 60_000 // this machine is half an hour fast
    await putEmails(db, ACC, [
      { ...email('anchor'), receivedAt: new Date(serverNewest).toISOString() },
    ])

    const push = new FakePush()
    const { calls, notify } = notifySpy()
    let t = clientNow
    const engine = new SyncEngine({
      ...makeDeps(db, notifyingPort(), push),
      clock: { now: () => t++, setTimeout: () => 0, clearTimeout: () => {} },
      notify,
      isForeground: () => false,
    })

    engine.start()
    await waitFor(() => engine.getStatus().phase === 'idle')
    await anotherPass(push)

    // Unclamped this would be `clientNow`, and no server-stamped mail could ever be "strictly newer".
    expect(calls[0]?.ctx.sinceMs).toBe(serverNewest)
    await engine.stop()
  })

  it('does not notify when leadership is lost DURING the pass', async () => {
    // `runSyncPass` awaits half a dozen round-trips; a sign-out flips `isLeader` under it. Without the
    // re-check AFTER those awaits, the departing tab still banners. Deleting that one line left every
    // other test in this file green — it had no coverage at all.
    const push = new FakePush()
    const { calls, notify } = notifySpy()
    let parking = false
    let release: (() => void) | undefined
    const base = notifyingPort()
    const port: JmapPort = {
      ...base,
      async getEmailEnvelopes(ids) {
        // Only park once the initial sync is behind us — `backfill` calls this too, and parking there
        // would simply stall the first pass.
        if (parking && release === undefined) {
          await new Promise<void>((resolve) => {
            release = resolve
          })
        }
        return base.getEmailEnvelopes(ids)
      },
    }
    const engine = new SyncEngine({
      ...makeDeps(db, port, push),
      notify,
      isForeground: () => false,
    })

    engine.start()
    await waitFor(() => engine.getStatus().phase === 'idle')

    parking = true
    push.fireStateChange() // this pass would notify — it parks mid-flight instead
    await waitFor(() => release !== undefined)

    const stopped = engine.stop() // aborts, drops leadership, then awaits the in-flight pass
    release?.() // let the parked pass run on; it must now find itself demoted
    await stopped

    expect(calls).toEqual([])
  })

  it('without a notifier, nothing anywhere breaks', async () => {
    const push = new FakePush()
    const engine = new SyncEngine(makeDeps(db, notifyingPort(), push))
    engine.start()
    await waitFor(() => engine.getStatus().phase === 'idle')
    push.fireStateChange()
    await waitFor(() => engine.getStatus().phase === 'idle')
    expect(engine.getStatus().error).toBeNull()
    await engine.stop()
  })

  // --- the CROSS-TAB foreground probe -----------------------------------------------------------
  //
  // Leadership is per-ORIGIN and sticky — the first tab to take the Web Lock keeps it — but "is the
  // user looking at us?" is per-TAB. Open a second tab and work in it, and the leader is a hidden tab
  // that would happily banner mail the user is watching arrive right in front of them. So the leader
  // asks over the bus, and any tab that is itself foreground answers.

  /** A real cross-tab bus: every channel it hands out sees the others' posts, but never its own. */
  function connectedBuses(): () => BroadcastChannelLike {
    const channels: BroadcastChannelLike[] = []
    return () => {
      const self: BroadcastChannelLike = {
        postMessage(message) {
          for (const other of channels) {
            if (other !== self) other.onmessage?.({ data: message })
          }
        },
        close() {},
        onmessage: null,
      }
      channels.push(self)
      return self
    }
  }

  it('a HIDDEN leader stays silent when ANOTHER tab is in the foreground', async () => {
    const createBus = connectedBuses()
    const push = new FakePush()
    const { calls, notify } = notifySpy()

    const leader = new SyncEngine({
      ...makeDeps(db, notifyingPort(), push),
      createBus,
      notify,
      isForeground: () => false, // hidden
    })
    // The tab the user is actually looking at. It never wins the lock, so it never syncs — but it does
    // answer the probe, which is the whole reason it exists here.
    const follower = new SyncEngine({
      ...makeDeps(db, notifyingPort(), new FakePush()),
      createBus,
      locks: {
        request(_name, options) {
          return new Promise((_resolve, reject) => {
            const abort = () => reject(new DOMException('aborted', 'AbortError'))
            if (options.signal?.aborted) return abort()
            options.signal?.addEventListener('abort', abort)
          })
        },
      },
      isForeground: () => true, // focused
    })

    follower.start()
    leader.start()
    await waitFor(() => leader.getStatus().phase === 'idle')
    await anotherPass(push)

    expect(calls).toEqual([])
    await leader.stop()
    await follower.stop()
  })

  it('…but banners when NO tab answers — silence is the "no"', async () => {
    // The same wiring, minus the focused tab. A crashed or closed tab simply does not reply, which is
    // exactly why this is a query and not a heartbeat: there is no stale liveness state to get wrong.
    const createBus = connectedBuses()
    const push = new FakePush()
    const { calls, notify } = notifySpy()

    const leader = new SyncEngine({
      ...makeDeps(db, notifyingPort(), push),
      createBus,
      notify,
      isForeground: () => false,
    })

    leader.start()
    await waitFor(() => leader.getStatus().phase === 'idle')
    await anotherPass(push)

    expect(calls).toHaveLength(1)
    await leader.stop()
  })

  describe('isDocumentForeground — the production wiring', () => {
    // Every test above INJECTS isForeground, so the real predicate had no coverage at all: dropping
    // `&& document.hasFocus()` from it left the whole suite green.
    afterEach(() => {
      vi.restoreAllMocks()
    })

    const withDocument = (visibility: DocumentVisibilityState, focused: boolean) => {
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(visibility)
      vi.spyOn(document, 'hasFocus').mockReturnValue(focused)
    }

    it('is true only when the tab is visible AND focused', () => {
      withDocument('visible', true)
      expect(isDocumentForeground()).toBe(true)
    })

    it('is FALSE for a visible-but-unfocused window — one sitting behind another application', () => {
      // The whole reason `hasFocus()` is there. A buried window still reports `visible`, and calling it
      // "foreground" would suppress the one signal that tells the user mail arrived.
      withDocument('visible', false)
      expect(isDocumentForeground()).toBe(false)
    })

    it('is false for a hidden tab', () => {
      withDocument('hidden', true)
      expect(isDocumentForeground()).toBe(false)
    })
  })
})

/*
 * B47 — a failed sync pass retries on its own, instead of waiting for the safety sweep.
 *
 * The flake that led here was `narrow.spec.ts` timing out after 30 s with skeleton rows on screen
 * and "Sync problem — retrying" in the status region, ~4 minutes into a run that had been driving
 * Docker and a live Stalwart. The layout was right and the envelopes had simply never arrived.
 *
 * The cause is not the fixture being slow. It is that until this block existed, NOTHING retried a
 * failed pass: `runSyncPass` set `phase: 'error'` and returned, and the next attempt came whenever
 * the fixed 60 s safety sweep next happened to land — a mean of 30 s and a worst case of 60 for a
 * transient failure the server may have told us to retry in one. The status line said "retrying"
 * and nothing was. The write path has honoured `Retry-After` with a backoff since M3.3; the read
 * path had no equivalent.
 *
 * These tests drive the clock, so nothing here depends on wall time.
 */
describe('sync retry after a failed pass (B47)', () => {
  interface Scheduled {
    id: number
    fn: () => void
    delay: number
  }

  /** A clock whose timers the test fires by hand — the safety sweep never runs unless asked. */
  function recordingClock() {
    let now = 1000
    let nextId = 1
    const timers: Scheduled[] = []
    const clock: EngineClock = {
      now: () => now++,
      setTimeout: (fn, delay) => {
        const id = nextId++
        timers.push({ id, fn, delay })
        return id
      },
      clearTimeout: (id) => {
        const at = timers.findIndex((timer) => timer.id === id)
        if (at >= 0) timers.splice(at, 1)
      },
    }
    return {
      clock,
      timers,
      /** Timers scheduled sooner than the safety sweep — i.e. the retries this block is about. */
      retries: (): Scheduled[] => timers.filter((timer) => timer.delay < 60_000),
      fire(timer: Scheduled): void {
        const at = timers.findIndex((entry) => entry.id === timer.id)
        if (at >= 0) timers.splice(at, 1)
        timer.fn()
      },
    }
  }

  /** A port whose delta round-trip fails until `failing` is cleared. */
  function flakyPort(failure: () => unknown) {
    let failing = true
    const base = fakePort({ emails: ['e1'], setEmails: emptySet })
    const port: JmapPort = {
      ...base,
      async emailChanges(state) {
        if (failing) throw failure()
        return base.emailChanges(state)
      },
    }
    return {
      port,
      heal: () => {
        failing = false
      },
    }
  }

  it('schedules a retry far sooner than the safety sweep, and recovers on it', async () => {
    const time = recordingClock()
    const { port, heal } = flakyPort(() => new Error('boom'))
    const push = new FakePush()
    const engine = new SyncEngine({ ...makeDeps(db, port, push), clock: time.clock })
    engine.start()
    await waitFor(() => engine.getStatus().phase === 'error')

    // The defect in one assertion: before this fix the only pending timer was the 60 s sweep.
    const [retry] = time.retries()
    expect(retry, 'a failed pass scheduled no retry of its own').toBeDefined()
    // Half-jitter over a 2 s window: [1000, 2000).
    expect(retry?.delay).toBeGreaterThanOrEqual(1_000)
    expect(retry?.delay).toBeLessThan(2_000)

    heal()
    if (retry) time.fire(retry)
    await waitFor(() => engine.getStatus().phase === 'idle')
    await engine.stop()
  })

  it('honours a server-supplied Retry-After instead of guessing earlier', async () => {
    const time = recordingClock()
    const { port } = flakyPort(() => new JmapHttpError(429, 'Too Many Requests', undefined, 7_000))
    const push = new FakePush()
    const engine = new SyncEngine({ ...makeDeps(db, port, push), clock: time.clock })
    engine.start()
    await waitFor(() => engine.getStatus().phase === 'error')

    // Not the curve's 1–2 s: the server said seven seconds, and guessing earlier is how a
    // throttled client stays throttled.
    expect(time.retries().map((timer) => timer.delay)).toContain(7_000)
    await engine.stop()
  })

  it('grows the delay while failures continue, and forgets them after a success', async () => {
    const time = recordingClock()
    const { port, heal } = flakyPort(() => new Error('boom'))
    const push = new FakePush()
    const engine = new SyncEngine({ ...makeDeps(db, port, push), clock: time.clock })
    engine.start()
    await waitFor(() => engine.getStatus().phase === 'error')

    const first = time.retries()[0]
    expect(first).toBeDefined()
    if (first) time.fire(first)
    await waitFor(() => time.retries().length > 0)
    const second = time.retries()[0]
    expect(second?.delay ?? 0).toBeGreaterThanOrEqual(2_000) // second window is 4 s → [2000, 4000)

    // A success resets the counter, so the NEXT failure starts at the short end again rather than
    // inheriting a backoff from an outage the reader has long since forgotten about.
    heal()
    if (second) time.fire(second)
    await waitFor(() => engine.getStatus().phase === 'idle')
    expect(time.retries(), 'a successful pass left a retry armed').toHaveLength(0)
    await engine.stop()
  })

  it('does not back off while offline — reconnecting schedules its own pass', async () => {
    const time = recordingClock()
    const { port } = flakyPort(() => new Error('offline'))
    const push = new FakePush()
    const engine = new SyncEngine({
      ...makeDeps(db, port, push),
      clock: time.clock,
      isOnline: () => false,
    })
    engine.start()
    await waitFor(() => engine.getStatus().phase === 'offline')

    // Counting an offline failure would push the first retry AFTER reconnect out to the far end of
    // the curve, which is the opposite of what a returning connection wants.
    expect(time.retries()).toHaveLength(0)
    await engine.stop()
  })
})
