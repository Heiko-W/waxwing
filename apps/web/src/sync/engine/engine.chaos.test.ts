/**
 * The M3.3 chaos suite — HERMETIC (no Playwright, no Docker). Everything the engine touches is
 * injected, so an unreliable network and a concurrently-mutating server are simulated
 * DETERMINISTICALLY: a virtual clock the test advances, an online flag the test toggles, a fake
 * server whose state the test edits between calls, and `random: () => 0` so every backoff is exact.
 *
 * The property under test is FR-OFF-03's hard guarantee: **no queued action is ever lost, and no
 * rejected action ever leaves the replica silently wrong.** (The live counterpart — the same
 * scenarios against the Stalwart fixture — is M3.10.)
 */

import type {
  Id,
  PushChannel,
  PushErrorListener,
  PushStatus,
  Session,
  StateChangeListener,
  StatusListener,
  Unsubscribe,
} from '@waxwing/jmap'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ReplicaDb } from '../db'
import { failedOutbox, putEmails } from '../repo'
import { email, freshDb } from '../test-utils'
import type { BroadcastChannelLike, EngineBusMessage } from './bus'
import { SyncEngine, type SyncEngineDeps } from './engine'
import type { LockManagerLike } from './leader'
import { setEngineStatus } from './status'
import {
  type ChangesResult,
  type EngineClock,
  INITIAL_ENGINE_STATUS,
  type JmapPort,
  type PortSetError,
  type PortSetResult,
} from './types'

const ACC = 'acc'
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/** Let every queued microtask/promise chain in the engine settle against the current fake state. */
async function settle(times = 12): Promise<void> {
  for (let i = 0; i < times; i += 1) await flush()
}

async function waitFor(predicate: () => boolean | Promise<boolean>, tries = 200): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (await predicate()) return
    await flush()
  }
  throw new Error('waitFor timed out')
}

// ---------------------------------------------------------------------------------------------
// Fakes.
// ---------------------------------------------------------------------------------------------

const immediateLock: LockManagerLike = {
  request(_name, options, callback) {
    if (options.signal?.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'))
    return callback(undefined)
  },
}

/** A lock that is never granted (a FOLLOWER tab); it rejects on abort, exactly like Web Locks. */
const contendedLock: LockManagerLike = {
  request(_name, options) {
    return new Promise((_resolve, reject) => {
      const abort = () => reject(new DOMException('aborted', 'AbortError'))
      if (options.signal?.aborted) abort()
      else options.signal?.addEventListener('abort', abort)
    })
  },
}

/** A BroadcastChannel hub that delivers to every OTHER channel — never to the sender (as per spec). */
function busHub() {
  const channels = new Set<{ onmessage: ((event: { data: unknown }) => void) | null }>()
  return {
    create(): BroadcastChannelLike {
      const channel: BroadcastChannelLike = {
        onmessage: null,
        postMessage(message: unknown) {
          for (const other of channels) {
            if (other !== channel) other.onmessage?.({ data: message })
          }
        },
        close() {
          channels.delete(channel)
        },
      }
      channels.add(channel)
      return channel
    },
  }
}

class FakePush implements PushChannel {
  readonly transport = 'sse' as const
  status: PushStatus = 'closed'
  open(): void {
    this.status = 'open'
  }
  close(): void {
    this.status = 'closed'
  }
  subscribe(_listener: StateChangeListener): Unsubscribe {
    return () => {}
  }
  onStatus(_listener: StatusListener): Unsubscribe {
    return () => {}
  }
  onError(_listener: PushErrorListener): Unsubscribe {
    return () => {}
  }
}

/** A clock the test drives: `advance(ms)` moves time AND fires every timer that came due. */
function virtualClock(start = 1_000) {
  let now = start
  let nextId = 1
  const timers = new Map<number, { at: number; run: () => void }>()
  const clock: EngineClock = {
    now: () => now,
    setTimeout: (handler, ms) => {
      const id = nextId++
      timers.set(id, { at: now + Math.max(0, ms), run: handler })
      return id
    },
    clearTimeout: (id) => {
      timers.delete(id)
    },
  }
  return {
    clock,
    get now() {
      return now
    },
    async advance(ms: number): Promise<void> {
      now += ms
      for (const [id, timer] of [...timers.entries()]) {
        if (timer.at > now) continue
        timers.delete(id)
        timer.run()
      }
      await settle()
    },
  }
}

/** The line: on/off under test control, with the engine's `onOnlineChange` listeners attached. */
function network() {
  let up = true
  const listeners = new Set<(online: boolean) => void>()
  return {
    isOnline: () => up,
    onOnlineChange: (listener: (online: boolean) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set(next: boolean): void {
      up = next
      for (const listener of listeners) listener(next)
    },
  }
}

interface ServerEmail {
  id: Id
  mailboxIds: Record<Id, true>
  keywords: Record<string, true>
}

/**
 * A minimal in-memory JMAP server the test can mutate BETWEEN engine calls (that is the "concurrent
 * modification" half of the chaos): destroy a message, delete a mailbox, and the next replay of a
 * queued intent gets the real `notFound` / `invalidProperties` the server would send.
 */
class FakeServer {
  readonly emails = new Map<Id, ServerEmail>()
  readonly mailboxes = new Set<Id>(['inbox', 'archive'])
  /** Every `set` the server actually accepted, keyed by intent — the "exactly once" ledger. */
  readonly applied: string[] = []
  /** Full DELTA passes (a `Mailbox` pull or its `changes` delta) — a replay-only pass adds none. */
  deltaCalls = 0
  /** EmailSubmission creation ids the server ACCEPTED — the "delivered exactly once" ledger. */
  readonly submissions: string[] = []
  /**
   * Arm a LOST RESPONSE on the next call to this method: the side effect is applied and the call
   * THEN throws. This is the ambiguity that makes retrying a non-idempotent operation dangerous —
   * and it is precisely what `guard()` can never produce, because that checks online-ness BEFORE
   * running the side effect. Without this mode a double-send could regress unnoticed.
   */
  loseResponseOn: 'setEmails' | 'submitEmail' | null = null

  /** Run `value` (already applied), then throw if a lost response is armed for `method`. */
  private afterApply<T>(method: 'setEmails' | 'submitEmail', value: T): T {
    if (this.loseResponseOn !== method) return value
    this.loseResponseOn = null
    throw new TypeError('fetch failed') // the server DID process it; only the response is gone
  }

  private submit(args: Parameters<JmapPort['submitEmail']>[0]): PortSetResult {
    this.submissions.push(args.submissionCreationId)
    return {
      ...this.emptySet(),
      created: { [args.submissionCreationId]: { id: `srv-${this.submissions.length}` } },
    }
  }

  constructor(ids: Id[]) {
    for (const id of ids) {
      this.emails.set(id, { id, mailboxIds: { inbox: true }, keywords: {} })
    }
  }

  private emptySet(): PortSetResult {
    return {
      oldState: null,
      newState: 's',
      created: {},
      updated: [],
      destroyed: [],
      notCreated: {},
      notUpdated: {},
      notDestroyed: {},
    }
  }

  setEmails(args: Parameters<JmapPort['setEmails']>[0]): PortSetResult {
    const updated: Id[] = []
    const destroyed: Id[] = []
    const notUpdated: Record<Id, PortSetError> = {}
    const notDestroyed: Record<Id, PortSetError> = {}

    for (const [id, patch] of Object.entries(args.update ?? {})) {
      const record = this.emails.get(id)
      if (record === undefined) {
        notUpdated[id] = { type: 'notFound' }
        continue
      }
      let rejected = false
      for (const [path, value] of Object.entries(patch)) {
        const [group, key] = path.split('/')
        if (key === undefined) continue
        if (group === 'keywords') {
          if (value === null) delete record.keywords[key]
          else record.keywords[key] = true
        } else if (group === 'mailboxIds') {
          if (value === null) {
            delete record.mailboxIds[key]
          } else if (!this.mailboxes.has(key)) {
            rejected = true // the target folder was deleted out from under the queued move
          } else {
            record.mailboxIds[key] = true
          }
        }
      }
      if (rejected) notUpdated[id] = { type: 'invalidProperties', description: 'mailboxIds' }
      else {
        updated.push(id)
        this.applied.push(`update:${id}`)
      }
    }

    for (const id of args.destroy ?? []) {
      if (!this.emails.delete(id)) {
        notDestroyed[id] = { type: 'notFound' }
        continue
      }
      destroyed.push(id)
      this.applied.push(`destroy:${id}`)
    }
    return { ...this.emptySet(), updated, destroyed, notUpdated, notDestroyed }
  }

  /** The port the engine talks to. Every method throws while the line is down. */
  port(isOnline: () => boolean): JmapPort {
    const offline = (): never => {
      throw new TypeError('fetch failed')
    }
    const changes = (state: string): ChangesResult => ({
      newState: state,
      hasMoreChanges: false,
      created: [],
      updated: [],
      destroyed: [],
    })
    const guard = <T>(fn: () => T): T => (isOnline() ? fn() : offline())

    return {
      accountId: ACC,
      mailboxChanges: async (state) =>
        guard(() => {
          this.deltaCalls += 1
          return changes(state)
        }),
      threadChanges: async (state) => guard(() => changes(state)),
      emailChanges: async (state) => guard(() => changes(state)),
      getMailboxes: async () =>
        guard(() => {
          this.deltaCalls += 1
          return {
            list: [...this.mailboxes].map((id) => ({
              id,
              name: id,
              parentId: null,
              role: id === 'inbox' ? 'inbox' : null,
              sortOrder: 0,
              totalEmails: 0,
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
            })),
            notFound: [],
            state: `mbx-${this.mailboxes.size}`,
          }
        }),
      getIdentities: async () => guard(() => ({ list: [], notFound: [], state: 'idn' })),
      getThreads: async (ids) =>
        guard(() => ({
          list: ids.map((id) => ({ id, emailIds: [id] })),
          notFound: [],
          state: 'thr',
        })),
      getEmailEnvelopes: async (ids) =>
        guard(() => {
          const found = ids.filter((id) => this.emails.has(id))
          return {
            list: found.map((id) => {
              const record = this.emails.get(id) as ServerEmail
              return email(id, { mailboxIds: record.mailboxIds, keywords: record.keywords })
            }),
            notFound: ids.filter((id) => !this.emails.has(id)),
            state: 'eml',
          }
        }),
      getEmailBodies: async () => guard(() => ({ list: [], notFound: [], state: 'eml' })),
      queryEmails: async () =>
        guard(() => ({
          ids: [...this.emails.keys()],
          queryState: 'q',
          canCalculateChanges: true,
          position: 0,
          total: this.emails.size,
        })),
      queryEmailChanges: async () =>
        guard(() => ({ oldQueryState: 'q', newQueryState: 'q', removed: [], added: [] })),
      getSearchSnippets: async () => guard(() => ({ list: [], notFound: [] })),
      setEmails: async (args) => guard(() => this.afterApply('setEmails', this.setEmails(args))),
      setMailboxes: async () => guard(() => this.emptySet()),
      submitEmail: async (args) => guard(() => this.afterApply('submitEmail', this.submit(args))),
    }
  }
}

interface Harness {
  engine: SyncEngine
  server: FakeServer
  net: ReturnType<typeof network>
  time: ReturnType<typeof virtualClock>
  deps: SyncEngineDeps
}

let db: ReplicaDb

function makeHarness(
  ids: Id[],
  options: { hub?: ReturnType<typeof busHub>; maxObjectsInSet?: number } = {},
): Harness {
  const hub = options.hub ?? busHub()
  const server = new FakeServer(ids)
  const net = network()
  const time = virtualClock()
  const core =
    options.maxObjectsInSet === undefined
      ? {}
      : { 'urn:ietf:params:jmap:core': { maxObjectsInSet: options.maxObjectsInSet } }
  const deps: SyncEngineDeps = {
    db,
    port: server.port(net.isOnline),
    // The cleanup chunk size = the server's advertised `maxObjectsInSet` (fallback 500).
    session: { capabilities: core } as unknown as Session,
    auth: { scheme: 'bearer', authorization: () => 'x' },
    config: { cacheDays: 30, maxStorageMB: 512 },
    clock: time.clock,
    locks: immediateLock,
    createBus: () => hub.create(),
    createPush: () => new FakePush(),
    isOnline: net.isOnline,
    onOnlineChange: net.onOnlineChange,
    safetyIntervalMs: 1_000_000_000, // the sweep must never fire behind the test's back
    random: () => 0, // exact, reproducible backoff
  }
  return { engine: new SyncEngine(deps), server, net, time, deps }
}

beforeEach(() => {
  db = freshDb()
  setEngineStatus(INITIAL_ENGINE_STATUS)
})

afterEach(async () => {
  await db.delete()
})

describe('chaos — zero lost actions under a flapping connection (FR-OFF-03)', () => {
  it('every queued action reaches the server EXACTLY once, none is rolled back or discarded', async () => {
    const ids = Array.from({ length: 20 }, (_, index) => `e${index}`)
    await putEmails(
      db,
      ACC,
      ids.map((id) => email(id, { keywords: {} })),
    )
    const { engine, server, net, time } = makeHarness(ids)
    engine.start()
    await waitFor(() => engine.getStatus().isLeader)
    await settle()

    // Dispatch 20 actions while flapping the line 30×. Half land offline, half mid-pass.
    for (const [index, id] of ids.entries()) {
      net.set(index % 2 === 0)
      await engine.dispatch(
        { kind: 'setKeywords', emailIds: [id], keyword: '$seen', value: true },
        { id: `i-${id}` },
      )
      await settle(2)
      net.set(!(index % 3 === 0))
      await settle(2)
    }

    // The line comes back for good; drain the queue (each pass clears one backoff step).
    net.set(true)
    for (let round = 0; round < 40 && (await db.outbox.count()) > 0; round += 1) {
      await time.advance(600_000) // past any backoff gate + the reconnect debounce
      await settle()
    }

    expect(await db.outbox.count()).toBe(0) // nothing left queued
    expect(await failedOutbox(db, ACC)).toEqual([]) // and nothing dead-lettered
    // Exactly once, for every one of the 20 — no drops, no double-applies.
    const updates = server.applied.filter((entry) => entry.startsWith('update:'))
    expect(updates.length).toBe(20)
    expect(new Set(updates).size).toBe(20)
    // The replica converged on the server's state.
    for (const id of ids) {
      expect(server.emails.get(id)?.keywords.$seen).toBe(true)
      expect((await db.emails.get([ACC, id]))?.keywords.$seen).toBe(true)
    }
    await engine.stop()
  })
})

describe('chaos — concurrent server modification', () => {
  it('the target folder is deleted while a move is queued ⇒ undone + surfaced as folderGone', async () => {
    await putEmails(db, ACC, [email('e1', { mailboxIds: { inbox: true } })])
    const { engine, server, net, time } = makeHarness(['e1'])
    engine.start()
    await waitFor(() => engine.getStatus().isLeader)

    net.set(false)
    await engine.dispatch(
      { kind: 'move', emailIds: ['e1'], from: 'inbox', to: 'archive' },
      { id: 'i1' },
    )
    // Optimistically moved, and nothing has been attempted while offline.
    expect((await db.emails.get([ACC, 'e1']))?.mailboxIds).toEqual({ archive: true })
    expect(engine.getStatus().pendingActions).toBe(1)

    // ANOTHER CLIENT deletes the target folder while we are offline.
    server.mailboxes.delete('archive')

    net.set(true)
    await time.advance(1_000) // past the reconnect debounce
    await waitFor(() => engine.getStatus().failedActions === 1)

    // Never silent: the message is back where it was AND the problem is listed for the user.
    expect((await db.emails.get([ACC, 'e1']))?.mailboxIds).toEqual({ inbox: true })
    const [dead] = await failedOutbox(db, ACC)
    expect(dead?.conflict?.code).toBe('folderGone')
    expect(dead?.undo).toBeNull() // the rollback ran
    expect(engine.getStatus().pendingActions).toBe(0)
    await engine.stop()
  })

  it('the message is destroyed while a flag change is queued ⇒ messageGone', async () => {
    await putEmails(db, ACC, [email('e1', { keywords: {} })])
    const { engine, server, net, time } = makeHarness(['e1'])
    engine.start()
    await waitFor(() => engine.getStatus().isLeader)

    net.set(false)
    await engine.dispatch(
      { kind: 'setKeywords', emailIds: ['e1'], keyword: '$flagged', value: true },
      { id: 'i1' },
    )
    server.emails.delete('e1') // another client deleted it

    net.set(true)
    await time.advance(1_000)
    await waitFor(() => engine.getStatus().failedActions === 1)

    const [dead] = await failedOutbox(db, ACC)
    expect(dead?.conflict?.code).toBe('messageGone')
    expect((await db.emails.get([ACC, 'e1']))?.keywords).toEqual({}) // optimistic flag undone
    await engine.stop()
  })
})

describe('chaos — reconnect storms + burst dispatch coalesce', () => {
  it('30 `online` events inside the debounce window cause exactly ONE delta pass', async () => {
    const { engine, server, net, time } = makeHarness(['e1'])
    engine.start()
    await waitFor(() => engine.getStatus().isLeader)
    await settle()
    const before = server.deltaCalls

    for (let i = 0; i < 30; i += 1) {
      net.set(false)
      net.set(true)
      await settle(1)
    }
    expect(server.deltaCalls).toBe(before) // nothing fires until the line settles
    await time.advance(750)
    await settle()

    expect(server.deltaCalls).toBe(before + 1)
    await engine.stop()
  })

  /**
   * The M3.2 cleanup burst: one durable outbox intent per `maxObjectsInSet` chunk. Scaled down
   * (120 ids at a 50-object cap ⇒ the same 3 chunks) purely so fake-indexeddb stays fast; the code
   * path — chunking, the coalesced replay, the delta-pass count — is identical at any size.
   */
  it('a chunked cleanup burst replays as 3 intents in ONE pass, with NO extra delta passes', async () => {
    const ids = Array.from({ length: 120 }, (_, index) => `c${index}`)
    await putEmails(
      db,
      ACC,
      ids.map((id) => email(id)),
    )
    const { engine, server } = makeHarness(ids, { maxObjectsInSet: 50 })
    engine.start()
    await waitFor(() => engine.getStatus().isLeader)
    await settle()
    const deltaBefore = server.deltaCalls

    const { scheduled } = await engine.emptyMailbox('inbox')
    expect(scheduled).toBe(120)
    await waitFor(async () => (await db.outbox.count()) === 0, 400)

    // Three durable chunks — and dispatching them did NOT trigger three full delta round-trips:
    // flushing a LOCAL queue is a REPLAY, not a sync (M3.3, Q6).
    expect(server.applied.filter((entry) => entry.startsWith('destroy:')).length).toBe(120)
    expect(server.deltaCalls).toBe(deltaBefore)
    expect(server.emails.size).toBe(0)
    await engine.stop()
  })
})

describe('chaos — durability across a restart', () => {
  it('a NEW engine on the same replica rolls back from the PERSISTED undo (D6)', async () => {
    await putEmails(db, ACC, [email('e1', { keywords: {} })])
    const first = makeHarness(['e1'])
    first.engine.start()
    await waitFor(() => first.engine.getStatus().isLeader)

    first.net.set(false)
    await first.engine.dispatch(
      { kind: 'setKeywords', emailIds: ['e1'], keyword: '$seen', value: true },
      { id: 'i1' },
    )
    expect((await db.emails.get([ACC, 'e1']))?.keywords).toEqual({ $seen: true })
    await first.engine.stop() // the tab dies — every in-memory rollback closure dies with it

    // A brand-new engine (a reload, or another tab taking the lock) picks the row up…
    const second = makeHarness(['e1'])
    second.server.emails.delete('e1') // …and the server has since destroyed the message
    second.engine.start()
    await waitFor(() => second.engine.getStatus().failedActions === 1)

    expect((await db.emails.get([ACC, 'e1']))?.keywords).toEqual({}) // rolled back from the ROW
    const [dead] = await failedOutbox(db, ACC)
    expect(dead?.conflict?.code).toBe('messageGone')
    await second.engine.stop()
  })
})

describe('chaos — offline send', () => {
  const sendIntent = {
    kind: 'sendEmail',
    localId: 'd1',
    emailCreationId: 'send-d1',
    submissionCreationId: 'sub-d1',
    priorServerId: null,
    email: { mailboxIds: { 'mb-d': true } },
    identityId: 'id1',
    envelope: { mailFrom: { email: 'me@x.test' }, rcptTo: [{ email: 'a@x.test' }] },
    onSuccessUpdateEmail: {},
    source: null,
  } as unknown as Parameters<SyncEngine['dispatch']>[0]

  it('stays cancelable while pending — long past its undo grace — but never once inflight', async () => {
    const { engine, net, time } = makeHarness([])
    engine.start()
    await waitFor(() => engine.getStatus().isLeader)
    await db.drafts.put({
      accountId: ACC,
      localId: 'd1',
      serverEmailId: null,
      status: 'sending',
      content: {
        to: [],
        cc: [],
        bcc: [],
        subject: 'Hi',
        body: '',
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
    })

    net.set(false)
    await engine.dispatch(sendIntent, { id: 'send:d1', notBefore: time.now + 10_000 })
    await time.advance(60_000) // the grace elapses while we are still offline
    expect((await db.outbox.get([ACC, 'send:d1']))?.status).toBe('pending') // queued, NOT sent

    expect(await engine.cancelSend('send:d1')).toBe(true)
    expect(await db.outbox.get([ACC, 'send:d1'])).toBeUndefined()
    expect((await db.drafts.get([ACC, 'd1']))?.status).toBe('pending') // editable again

    // A send already claimed by replay (inflight ⇒ in the air) can never be canceled.
    await db.outbox.put({
      accountId: ACC,
      id: 'send:d2',
      type: 'sendEmail',
      payload: sendIntent,
      ifInState: null,
      status: 'inflight',
      attempts: 0,
      createdAt: 1,
      lastError: null,
      notBefore: null,
    })
    expect(await engine.cancelSend('send:d2')).toBe(false)
    await engine.stop()
  })

  it('a send whose RESPONSE is lost is NEVER re-sent — submitEmail runs exactly once', async () => {
    const { engine, server, time } = makeHarness([])
    engine.start()
    await waitFor(() => engine.getStatus().isLeader)
    await db.drafts.put({
      accountId: ACC,
      localId: 'd1',
      serverEmailId: null,
      status: 'sending',
      content: {
        to: [],
        cc: [],
        bcc: [],
        subject: 'Hi',
        body: '',
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
    })

    // The server ACCEPTS the submission — the mail is on its way — and only THEN is the response
    // lost. From the client's side that is indistinguishable from "it never arrived", which is
    // exactly why an EmailSubmission must never be auto-retried.
    server.loseResponseOn = 'submitEmail'
    await engine.dispatch(sendIntent, { id: 'send:d1' })
    await waitFor(async () => (await db.outbox.get([ACC, 'send:d1']))?.status === 'error')

    // Far past every backoff window: a retry here would deliver the message a SECOND time.
    await time.advance(10 * 60_000)

    expect(server.submissions).toEqual(['sub-d1']) // delivered exactly ONCE
    const dead = await db.outbox.get([ACC, 'send:d1'])
    expect(dead?.status).toBe('error')
    expect(dead?.conflict?.code).toBe('sendInterrupted')
    // The user is asked to check Sent before resending — the app never silently re-sends.
    expect((await db.drafts.get([ACC, 'd1']))?.status).toBe('error')
    await engine.stop()
  })
})

describe('chaos — follower wake (D7)', () => {
  it("a follower's dispatch wakes the leader's replay instead of waiting for a sweep", async () => {
    await putEmails(db, ACC, [email('e1', { keywords: {} })])
    const hub = busHub()
    const leader = makeHarness(['e1'], { hub })
    leader.engine.start()
    await waitFor(() => leader.engine.getStatus().isLeader)
    await settle()

    // A second tab that never wins the lock: it shares the replica + the bus, but cannot replay.
    const followerDeps: SyncEngineDeps = { ...leader.deps, locks: contendedLock }
    const follower = new SyncEngine(followerDeps)
    follower.start()
    await settle()
    expect(follower.getStatus().isLeader).toBe(false)

    await follower.dispatch(
      { kind: 'setKeywords', emailIds: ['e1'], keyword: '$seen', value: true },
      { id: 'i1' },
    )

    // No sweep, no push, no timer advance — the leader replays because the follower woke it.
    await waitFor(async () => (await db.outbox.count()) === 0)
    expect(leader.server.applied).toEqual(['update:e1'])
    await follower.stop()
    await leader.engine.stop()
  })

  it('the bus forwards both message types and never echoes to the sender', () => {
    const hub = busHub()
    const a = hub.create()
    const b = hub.create()
    const seenByA: unknown[] = []
    const seenByB: EngineBusMessage[] = []
    a.onmessage = (event) => seenByA.push(event.data)
    b.onmessage = (event) => seenByB.push(event.data as EngineBusMessage)

    a.postMessage({ type: 'wake', reason: 'outbox' } satisfies EngineBusMessage)

    expect(seenByA).toEqual([]) // BroadcastChannel never delivers to the sender
    expect(seenByB).toEqual([{ type: 'wake', reason: 'outbox' }])
  })
})
