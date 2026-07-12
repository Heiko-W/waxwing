import { type EmailCreate, JmapHttpError, JmapMethodError } from '@waxwing/jmap'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DraftRow, OutboxRow, ReplicaDb } from '../db'
import {
  emailsInMailbox,
  emailsWithKeyword,
  failedOutbox,
  pendingOutbox,
  putEmails,
  putMailboxes,
} from '../repo'
import { email, freshDb, mailbox } from '../test-utils'
import { STUCK_AFTER_ATTEMPTS } from './backoff'
import { enqueueAction, type OutboxIntent, replayOutbox } from './outbox'
import type { JmapPort, PortSetResult } from './types'

let db: ReplicaDb
const ACC = 'acc'

/** Deterministic backoff: jitter 0 ⇒ delay = window/2. */
const NO_JITTER = () => 0

beforeEach(() => {
  db = freshDb()
})

afterEach(async () => {
  await db.delete()
})

function unused(): never {
  throw new Error('port method not used in this test')
}

function fakePort(overrides: Partial<JmapPort>): JmapPort {
  const base: JmapPort = {
    accountId: ACC,
    mailboxChanges: unused,
    threadChanges: unused,
    emailChanges: unused,
    getMailboxes: unused,
    getIdentities: unused,
    getThreads: unused,
    getEmailEnvelopes: unused,
    getEmailBodies: unused,
    queryEmails: unused,
    queryEmailChanges: unused,
    setEmails: unused,
    setMailboxes: unused,
    submitEmail: unused,
    getSearchSnippets: unused,
  }
  return { ...base, ...overrides }
}

function setResult(over: Partial<PortSetResult> = {}): PortSetResult {
  return {
    oldState: null,
    newState: 's1',
    created: {},
    updated: [],
    destroyed: [],
    notCreated: {},
    notUpdated: {},
    notDestroyed: {},
    ...over,
  }
}

const row = (id: string): Promise<OutboxRow | undefined> => db.outbox.get([ACC, id])

describe('outbox — optimistic apply + enqueue', () => {
  it('applies setKeywords to the replica and enqueues a pending intent with its undo', async () => {
    await putEmails(db, ACC, [email('e1', { keywords: {} })])

    await enqueueAction(
      db,
      ACC,
      { kind: 'setKeywords', emailIds: ['e1'], keyword: '$seen', value: true },
      { id: 'i1', now: 1 },
    )

    expect((await db.emails.get([ACC, 'e1']))?.keywords).toEqual({ $seen: true })
    expect((await emailsWithKeyword(db, ACC, '$seen')).map((r) => r.id)).toEqual(['e1'])
    expect((await pendingOutbox(db, ACC)).map((r) => r.id)).toEqual(['i1'])
    // The undo is DATA on the row (not an in-memory closure) — it survives a reload / tab hand-over.
    expect((await row('i1'))?.undo).toEqual({ kind: 'keywords', keyword: '$seen', had: [] })
  })

  it('applies move across mailboxes and captures per-id membership deltas', async () => {
    await putEmails(db, ACC, [
      email('e1', { mailboxIds: { inbox: true } }),
      email('e2', { mailboxIds: { inbox: true, archive: true } }), // ALREADY in the target
    ])

    await enqueueAction(
      db,
      ACC,
      { kind: 'move', emailIds: ['e1', 'e2'], from: 'inbox', to: 'archive' },
      { id: 'i1', now: 1 },
    )

    expect((await db.emails.get([ACC, 'e1']))?.mailboxIds).toEqual({ archive: true })
    expect((await emailsInMailbox(db, ACC, 'archive')).map((r) => r.id).sort()).toEqual([
      'e1',
      'e2',
    ])
    expect(await emailsInMailbox(db, ACC, 'inbox')).toEqual([])
    expect((await row('i1'))?.undo).toEqual({
      kind: 'mailboxIds',
      from: 'inbox',
      to: 'archive',
      hadTo: ['e2'], // e2 must NOT be stripped from `archive` on a rollback
      hadFrom: ['e1', 'e2'],
    })
  })
})

describe('outbox — persisted undo (M3.3, defect D6)', () => {
  it('rolls back from the PERSISTED undo with no in-memory closures (a reload/other tab)', async () => {
    await putEmails(db, ACC, [
      email('e1', { keywords: { $flagged: true }, mailboxIds: { inbox: true } }),
    ])
    await enqueueAction(
      db,
      ACC,
      { kind: 'move', emailIds: ['e1'], from: 'inbox', to: 'archive' },
      { id: 'i1', now: 1 },
    )
    // Simulate the process restart: nothing in memory survives — only the replica rows.
    const port = fakePort({
      setEmails: async () => setResult({ notUpdated: { e1: { type: 'notFound' } } }),
    })

    const summary = await replayOutbox(port, db, ACC, { random: NO_JITTER })

    expect(summary.failed).toBe(1)
    const restored = await db.emails.get([ACC, 'e1'])
    expect(restored?.mailboxIds).toEqual({ inbox: true }) // exactly the prior membership
    expect(restored?.keywords).toEqual({ $flagged: true }) // untouched
    const dead = await row('i1')
    expect(dead?.status).toBe('error')
    expect(dead?.conflict?.code).toBe('messageGone')
    expect(dead?.undo).toBeNull() // applied ⇒ no longer owed
  })

  it('keeps the undo OWED when it cannot run, and drains it on the next pass', async () => {
    await putEmails(db, ACC, [email('e1'), email('e2')])
    await enqueueAction(
      db,
      ACC,
      { kind: 'destroyEmails', emailIds: ['e1', 'e2'] },
      {
        id: 'i1',
        now: 1,
      },
    )
    expect(await db.emails.get([ACC, 'e1'])).toBeUndefined() // optimistically destroyed

    let refetch = 0
    const port = fakePort({
      setEmails: async () =>
        setResult({ notDestroyed: { e1: { type: 'forbidden' }, e2: { type: 'forbidden' } } }),
      getEmailEnvelopes: async (ids) => {
        refetch += 1
        if (refetch === 1) throw new TypeError('fetch failed') // offline mid-rollback
        return { list: ids.map((id) => email(id)), notFound: [], state: 's' }
      },
    })

    await replayOutbox(port, db, ACC, { random: NO_JITTER })
    const owed = await row('i1')
    expect(owed?.status).toBe('error')
    expect(owed?.undo).toEqual({ kind: 'refetchEmails' }) // STILL OWED — never silently dropped
    expect(await db.emails.get([ACC, 'e1'])).toBeUndefined()
    // The dead letter is still listed, so the stale local state is visible, not silent.
    expect((await failedOutbox(db, ACC)).map((r) => r.id)).toEqual(['i1'])

    await replayOutbox(port, db, ACC, { random: NO_JITTER })
    expect(await db.emails.get([ACC, 'e1'])).toBeDefined() // drained on the next pass
    expect(await db.emails.get([ACC, 'e2'])).toBeDefined()
    expect((await row('i1'))?.undo).toBeNull()
  })
})

describe('outbox — per-object rejections (M3.3, defects D1/D2)', () => {
  it('a MIXED rejection backs the whole row off — it must never silently DROP the transient objects', async () => {
    const ids = ['e1', 'e2', 'e3']
    await putEmails(
      db,
      ACC,
      ids.map((id) => email(id, { keywords: {} })),
    )
    await enqueueAction(
      db,
      ACC,
      { kind: 'setKeywords', emailIds: ids, keyword: '$seen', value: true },
      { id: 'i1', now: 1 },
    )
    const port = fakePort({
      // e1 is rate-limited (TRANSIENT), e2 is forbidden (PERMANENT), e3 succeeds.
      setEmails: async () =>
        setResult({
          updated: ['e3'],
          notUpdated: { e1: { type: 'rateLimit' }, e2: { type: 'forbidden' } },
        }),
    })

    await replayOutbox(port, db, ACC, { now: 1, random: NO_JITTER })

    // Dead-lettering on the strength of e2 would drop e1 on the floor: never retried, never undone,
    // never recorded in `conflict.ids` — its optimistic $seen would stay in the replica while the
    // server never saw it. The transient failure must win: back the whole (idempotent) row off.
    const r = await row('i1')
    expect(r?.status).toBe('pending')
    expect(r?.conflict ?? null).toBeNull()
    expect(r?.nextAttemptAt ?? 0).toBeGreaterThan(1)
    expect((await db.emails.get([ACC, 'e1']))?.keywords.$seen).toBe(true) // nothing rolled back
    expect((await db.emails.get([ACC, 'e2']))?.keywords.$seen).toBe(true)
  })

  it('a partial destroy rejection restores ONLY the failed ids (not the whole batch)', async () => {
    const ids = ['e1', 'e2', 'e3', 'e4', 'e5']
    await putEmails(
      db,
      ACC,
      ids.map((id) => email(id)),
    )
    await enqueueAction(db, ACC, { kind: 'destroyEmails', emailIds: ids }, { id: 'i1', now: 1 })

    let requested: string[] = []
    const port = fakePort({
      setEmails: async () =>
        setResult({
          destroyed: ['e1', 'e2', 'e3'],
          notDestroyed: { e4: { type: 'forbidden' }, e5: { type: 'forbidden' } },
        }),
      getEmailEnvelopes: async (want) => {
        requested = [...want]
        return { list: want.map((id) => email(id)), notFound: [], state: 's' }
      },
    })

    await replayOutbox(port, db, ACC, { random: NO_JITTER })

    expect(requested).toEqual(['e4', 'e5']) // only the FAILED ids are re-fetched
    expect(await db.emails.get([ACC, 'e1'])).toBeUndefined() // the 3 successes stay deleted
    expect(await db.emails.get([ACC, 'e3'])).toBeUndefined()
    expect(await db.emails.get([ACC, 'e4'])).toBeDefined() // the 2 failures come back
    expect(await db.emails.get([ACC, 'e5'])).toBeDefined()
    const dead = await row('i1')
    expect(dead?.status).toBe('error')
    expect(dead?.conflict?.ids).toEqual(['e4', 'e5'])
  })

  it('notFound on a destroy is SUCCESS ("already gone"), never a resurrection', async () => {
    await putEmails(db, ACC, [email('e1'), email('e2')])
    await enqueueAction(
      db,
      ACC,
      { kind: 'destroyEmails', emailIds: ['e1', 'e2'] },
      {
        id: 'i1',
        now: 1,
      },
    )
    const port = fakePort({
      setEmails: async () =>
        setResult({ notDestroyed: { e1: { type: 'notFound' }, e2: { type: 'notFound' } } }),
      getEmailEnvelopes: unused, // a rollback here would be the bug
    })

    const summary = await replayOutbox(port, db, ACC, { random: NO_JITTER })

    expect(summary).toMatchObject({ replayed: 1, failed: 0 })
    expect(await row('i1')).toBeUndefined() // dropped as a success
    expect(await db.emails.get([ACC, 'e1'])).toBeUndefined() // NOT resurrected
  })

  it('a mixed partial rejection keeps the succeeded ids applied and undoes only the failures', async () => {
    await putEmails(db, ACC, [
      email('e1', { keywords: {} }),
      email('e2', { keywords: {} }),
      email('e3', { keywords: { $seen: true } }),
    ])
    await enqueueAction(
      db,
      ACC,
      { kind: 'setKeywords', emailIds: ['e1', 'e2', 'e3'], keyword: '$seen', value: true },
      { id: 'i1', now: 1 },
    )
    const port = fakePort({
      setEmails: async () =>
        setResult({ updated: ['e1'], notUpdated: { e2: { type: 'notFound' } } }),
    })

    await replayOutbox(port, db, ACC, { random: NO_JITTER })

    expect((await db.emails.get([ACC, 'e1']))?.keywords).toEqual({ $seen: true }) // kept
    expect((await db.emails.get([ACC, 'e2']))?.keywords).toEqual({}) // undone
    expect((await db.emails.get([ACC, 'e3']))?.keywords).toEqual({ $seen: true }) // never touched
  })
})

describe('outbox — transient failures never destroy an action (M3.3, defect D3)', () => {
  it('survives 10 consecutive transport failures: still pending, state intact, backing off', async () => {
    await putEmails(db, ACC, [email('e1', { keywords: {} })])
    await enqueueAction(
      db,
      ACC,
      { kind: 'setKeywords', emailIds: ['e1'], keyword: '$seen', value: true },
      { id: 'i1', now: 0 },
    )
    const port = fakePort({
      setEmails: async () => {
        throw new TypeError('fetch failed')
      },
    })

    let summary = { stuck: 0 }
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      // `now` must clear the growing backoff gate, else the row would be (correctly) skipped.
      summary = await replayOutbox(port, db, ACC, { now: attempt * 1_000_000, random: NO_JITTER })
    }

    const still = await row('i1')
    expect(still?.status).toBe('pending') // NOT dead-lettered — the old code destroyed it at 5
    expect(still?.attempts).toBe(10)
    expect(still?.undo).toBeDefined()
    expect((await db.emails.get([ACC, 'e1']))?.keywords).toEqual({ $seen: true }) // NOT rolled back
    expect(await failedOutbox(db, ACC)).toEqual([])
    expect(summary.stuck).toBe(1) // reported as stuck, never discarded
    expect(still?.attempts).toBeGreaterThanOrEqual(STUCK_AFTER_ATTEMPTS)
  })

  it('gates a backed-off row until nextAttemptAt, then fires exactly at it', async () => {
    await putEmails(db, ACC, [email('e1', { keywords: {} })])
    await enqueueAction(
      db,
      ACC,
      { kind: 'setKeywords', emailIds: ['e1'], keyword: '$seen', value: true },
      { id: 'i1', now: 0 },
    )
    let calls = 0
    let fail = true
    const port = fakePort({
      setEmails: async () => {
        calls += 1
        if (fail) throw new TypeError('fetch failed')
        return setResult({ updated: ['e1'] })
      },
    })

    await replayOutbox(port, db, ACC, { now: 0, random: NO_JITTER })
    const backedOff = await row('i1')
    expect(calls).toBe(1)
    expect(backedOff?.nextAttemptAt).toBe(1000) // base 2000 ms, half-jitter at jitter=0

    fail = false
    await replayOutbox(port, db, ACC, { now: 999, random: NO_JITTER })
    expect(calls).toBe(1) // still gated

    await replayOutbox(port, db, ACC, { now: 1000, random: NO_JITTER })
    expect(calls).toBe(2)
    expect(await row('i1')).toBeUndefined()
  })

  it('an offline pass touches nothing at all', async () => {
    await putEmails(db, ACC, [email('e1', { keywords: {} })])
    await enqueueAction(
      db,
      ACC,
      { kind: 'setKeywords', emailIds: ['e1'], keyword: '$seen', value: true },
      { id: 'i1', now: 0 },
    )
    const port = fakePort({ setEmails: unused })

    const summary = await replayOutbox(port, db, ACC, { online: false, random: NO_JITTER })

    expect(summary).toEqual({ replayed: 0, failed: 0, stuck: 0, conflicted: 0 })
    const idle = await row('i1')
    expect(idle?.status).toBe('pending')
    expect(idle?.attempts).toBe(0) // an outage costs the queue NOTHING
  })

  it('a rateLimit SetError backs the row off instead of dead-lettering it', async () => {
    await putEmails(db, ACC, [email('e1', { keywords: {} })])
    await enqueueAction(
      db,
      ACC,
      { kind: 'setKeywords', emailIds: ['e1'], keyword: '$seen', value: true },
      { id: 'i1', now: 0 },
    )
    const port = fakePort({
      setEmails: async () => setResult({ notUpdated: { e1: { type: 'rateLimit' } } }),
    })

    await replayOutbox(port, db, ACC, { now: 0, random: NO_JITTER })

    const backedOff = await row('i1')
    expect(backedOff?.status).toBe('pending')
    expect(backedOff?.nextAttemptAt).toBe(1000)
    expect((await db.emails.get([ACC, 'e1']))?.keywords).toEqual({ $seen: true }) // NOT rolled back
  })
})

describe('outbox — stateMismatch auto-resolve (M3.3)', () => {
  const guarded = { kind: 'renameMailbox', id: 'mb1', name: 'New name' } as const

  beforeEach(async () => {
    await putMailboxes(db, ACC, [mailbox('mb1', { name: 'Old name' })])
  })

  it('re-syncs to a fresh state and re-executes once, then succeeds', async () => {
    await enqueueAction(db, ACC, guarded, { id: 'i1', now: 0, ifInState: 'stale' })
    const seen: (string | null)[] = []
    let first = true
    const port = fakePort({
      setMailboxes: async (args) => {
        seen.push(args.ifInState ?? null)
        if (first) {
          first = false
          throw new JmapMethodError({ type: 'stateMismatch' }, 'c1')
        }
        return setResult({ updated: ['mb1'] })
      },
    })
    let refreshed = 0

    await replayOutbox(port, db, ACC, {
      random: NO_JITTER,
      refreshState: async () => {
        refreshed += 1
        return 'fresh'
      },
    })

    expect(refreshed).toBe(1)
    expect(seen).toEqual(['stale', 'fresh'])
    expect(await row('i1')).toBeUndefined()
    expect((await db.mailboxes.get([ACC, 'mb1']))?.name).toBe('New name')
  })

  it('gives up after exactly MAX_REFRESHES and dead-letters as a stateConflict', async () => {
    await enqueueAction(db, ACC, guarded, { id: 'i1', now: 0, ifInState: 'stale' })
    const port = fakePort({
      setMailboxes: async () => {
        throw new JmapMethodError({ type: 'stateMismatch' }, 'c1')
      },
    })
    let refreshed = 0

    await replayOutbox(port, db, ACC, {
      random: NO_JITTER,
      refreshState: async () => {
        refreshed += 1
        return `s${refreshed}`
      },
    })

    expect(refreshed).toBe(3)
    const dead = await row('i1')
    expect(dead?.status).toBe('error')
    expect(dead?.conflict?.code).toBe('stateConflict')
    expect(dead?.refreshes).toBe(3)
    expect((await db.mailboxes.get([ACC, 'mb1']))?.name).toBe('Old name') // rolled back
  })
})

describe('outbox — replay resilience', () => {
  it('a method-level rejection on one intent does not wedge the FIFO tail', async () => {
    await putEmails(db, ACC, [email('e1', { keywords: {} }), email('e2', { keywords: {} })])
    for (const [id, ids] of [
      ['i1', ['e1']],
      ['i2', ['e2']],
    ] as const) {
      await enqueueAction(
        db,
        ACC,
        { kind: 'setKeywords', emailIds: [...ids], keyword: '$seen', value: true },
        { id, now: id === 'i1' ? 1 : 2 },
      )
    }
    const port = fakePort({
      setEmails: async (args) => {
        const update = (args as { update?: Record<string, unknown> }).update ?? {}
        if ('e1' in update) throw new JmapMethodError({ type: 'invalidArguments' }, 'c1')
        return setResult({ updated: ['e2'] })
      },
    })

    const summary = await replayOutbox(port, db, ACC, { random: NO_JITTER })

    expect(summary).toMatchObject({ replayed: 1, failed: 1 })
    expect((await row('i1'))?.status).toBe('error') // dead-letter
    expect((await row('i1'))?.conflict?.code).toBe('invalid')
    expect(await row('i2')).toBeUndefined() // replayed despite i1 failing
    expect((await db.emails.get([ACC, 'e1']))?.keywords).toEqual({}) // rolled back
    expect((await db.emails.get([ACC, 'e2']))?.keywords).toEqual({ $seen: true }) // kept

    // A second sweep must NOT re-process the terminal error row.
    const again = await replayOutbox(port, db, ACC, { random: NO_JITTER })
    expect(again).toMatchObject({ replayed: 0, failed: 0 })
    expect((await row('i1'))?.status).toBe('error')
  })

  it('leaves the row pending and re-throws on auth expiry (the session, not the action, is wrong)', async () => {
    await putEmails(db, ACC, [email('e1', { keywords: {} })])
    await enqueueAction(
      db,
      ACC,
      { kind: 'setKeywords', emailIds: ['e1'], keyword: '$seen', value: true },
      { id: 'i1', now: 1 },
    )
    const port = fakePort({
      setEmails: async () => {
        throw new JmapHttpError(401, '')
      },
    })

    await expect(replayOutbox(port, db, ACC, { random: NO_JITTER })).rejects.toBeInstanceOf(
      JmapHttpError,
    )
    const still = await row('i1')
    expect(still?.status).toBe('pending')
    expect(still?.attempts).toBe(0)
    expect((await db.emails.get([ACC, 'e1']))?.keywords).toEqual({ $seen: true })
  })

  it('recovers an intent stranded `inflight` by an interrupted leader', async () => {
    await putEmails(db, ACC, [email('e1', { keywords: {} })])
    await db.outbox.put({
      accountId: ACC,
      id: 'i1',
      type: 'setKeywords',
      payload: { kind: 'setKeywords', emailIds: ['e1'], keyword: '$seen', value: true },
      ifInState: null,
      status: 'inflight',
      attempts: 0,
      createdAt: 1,
      lastError: null,
      notBefore: null,
    })
    const port = fakePort({ setEmails: async () => setResult({ updated: ['e1'] }) })

    const summary = await replayOutbox(port, db, ACC, { random: NO_JITTER })

    expect(summary.replayed).toBe(1)
    expect(await row('i1')).toBeUndefined()
  })

  it('rewrites dependent references when a mailbox create is confirmed', async () => {
    // An email optimistically filed into the not-yet-created folder (temp id 'tmp').
    await putEmails(db, ACC, [email('e1', { mailboxIds: { tmp: true } })])
    await enqueueAction(
      db,
      ACC,
      { kind: 'createMailbox', creationId: 'tmp', props: { name: 'New', parentId: null } },
      { id: 'i1', now: 1 },
    )
    const port = fakePort({
      setMailboxes: async () => setResult({ created: { tmp: { id: 'srv-9' } } }),
    })

    await replayOutbox(port, db, ACC, { random: NO_JITTER })

    expect((await db.emails.get([ACC, 'e1']))?.mailboxIds).toEqual({ 'srv-9': true })
    expect((await emailsInMailbox(db, ACC, 'srv-9')).map((r) => r.id)).toEqual(['e1'])
    expect(await db.mailboxes.get([ACC, 'srv-9'])).toBeDefined()
    expect(await db.mailboxes.get([ACC, 'tmp'])).toBeUndefined()
  })

  it('rewrites a queued rename/delete/move of a folder created in the same session (D5)', async () => {
    // Create a folder offline, then rename it, then move it, then delete it — all before any replay.
    await enqueueAction(
      db,
      ACC,
      { kind: 'createMailbox', creationId: 'tmp', props: { name: 'New', parentId: null } },
      { id: 'i1', now: 1 },
    )
    await enqueueAction(
      db,
      ACC,
      { kind: 'renameMailbox', id: 'tmp', name: 'Renamed' },
      {
        id: 'i2',
        now: 2,
      },
    )
    await enqueueAction(
      db,
      ACC,
      { kind: 'moveMailbox', id: 'tmp', parentId: null },
      {
        id: 'i3',
        now: 3,
      },
    )
    await enqueueAction(db, ACC, { kind: 'deleteMailbox', id: 'tmp' }, { id: 'i4', now: 4 })

    const port = fakePort({
      setMailboxes: async (args) => {
        // The create replays first (FIFO); the rest must target the SERVER id by then.
        if (args.create) return setResult({ created: { tmp: { id: 'srv-9' } } })
        throw new TypeError('fetch failed') // stop the pass so we can inspect the rewrites
      },
    })

    await replayOutbox(port, db, ACC, { random: NO_JITTER })

    const targets = ['i2', 'i3', 'i4'].map(async (id) => {
      const queued = await row(id)
      return (queued?.payload as Extract<OutboxIntent, { kind: 'deleteMailbox' }>).id
    })
    expect(await Promise.all(targets)).toEqual(['srv-9', 'srv-9', 'srv-9'])
  })
})

describe('outbox — replay', () => {
  it('drops the row on a confirmed write and keeps the optimistic state', async () => {
    await putEmails(db, ACC, [email('e1', { keywords: {} })])
    await enqueueAction(
      db,
      ACC,
      { kind: 'setKeywords', emailIds: ['e1'], keyword: '$seen', value: true },
      { id: 'i1', now: 1 },
    )
    const port = fakePort({ setEmails: async () => setResult({ updated: ['e1'] }) })

    const summary = await replayOutbox(port, db, ACC, { random: NO_JITTER })

    expect(summary).toMatchObject({ replayed: 1, failed: 0 })
    expect(await db.outbox.count()).toBe(0)
    expect((await db.emails.get([ACC, 'e1']))?.keywords).toEqual({ $seen: true })
  })

  it('rolls back and marks error on an unrecognized per-object rejection', async () => {
    await putEmails(db, ACC, [email('e1', { keywords: {} })])
    await enqueueAction(
      db,
      ACC,
      { kind: 'setKeywords', emailIds: ['e1'], keyword: '$seen', value: true },
      { id: 'i1', now: 1 },
    )
    const port = fakePort({
      setEmails: async () => setResult({ notUpdated: { e1: { type: 'wat' } } }),
    })

    const summary = await replayOutbox(port, db, ACC, { random: NO_JITTER })

    expect(summary).toMatchObject({ replayed: 0, failed: 1 })
    expect((await db.emails.get([ACC, 'e1']))?.keywords).toEqual({})
    const dead = await row('i1')
    expect(dead?.status).toBe('error')
    expect(dead?.lastError).toBe('wat')
    expect(dead?.conflict?.code).toBe('serverRejected')
  })

  it('keeps the row pending and the optimistic state on a transport error', async () => {
    await putEmails(db, ACC, [email('e1', { keywords: {} })])
    await enqueueAction(
      db,
      ACC,
      { kind: 'setKeywords', emailIds: ['e1'], keyword: '$seen', value: true },
      { id: 'i1', now: 1 },
    )
    const port = fakePort({
      setEmails: async () => {
        throw new Error('offline')
      },
    })

    const summary = await replayOutbox(port, db, ACC, { random: NO_JITTER })

    expect(summary).toMatchObject({ replayed: 0, failed: 0 })
    const still = await row('i1')
    expect(still?.status).toBe('pending')
    expect(still?.attempts).toBe(1)
    expect((await db.emails.get([ACC, 'e1']))?.keywords).toEqual({ $seen: true })
  })

  it('reconciles the server id on a confirmed mailbox create', async () => {
    await enqueueAction(
      db,
      ACC,
      { kind: 'createMailbox', creationId: 'tmp1', props: { name: 'Receipts', parentId: null } },
      { id: 'i1', now: 1 },
    )
    expect(await db.mailboxes.get([ACC, 'tmp1'])).toBeDefined()
    const port = fakePort({
      setMailboxes: async () => setResult({ created: { tmp1: { id: 'MB99' } } }),
    })

    await replayOutbox(port, db, ACC, { random: NO_JITTER })

    expect(await db.mailboxes.get([ACC, 'tmp1'])).toBeUndefined()
    expect((await db.mailboxes.get([ACC, 'MB99']))?.name).toBe('Receipts')
  })
})

describe('outbox — drafts (M2.6)', () => {
  type SetArgs = Parameters<JmapPort['setEmails']>[0]

  const emailCreate: EmailCreate = {
    mailboxIds: { 'mb-d': true },
    keywords: { $draft: true, $seen: true },
    subject: 'Hi',
    from: null,
    to: [],
    cc: [],
    bcc: [],
    inReplyTo: null,
    references: null,
    htmlBody: [{ partId: 'html', type: 'text/html' }],
    bodyValues: { html: { value: '<p>x</p>', isEncodingProblem: false, isTruncated: false } },
  }

  function draftRow(over: Partial<DraftRow> = {}): DraftRow {
    return {
      accountId: ACC,
      localId: 'd1',
      serverEmailId: null,
      status: 'pending',
      content: {
        to: [],
        cc: [],
        bcc: [],
        subject: 'Hi',
        body: '<p>x</p>',
        inReplyTo: null,
        references: null,
        fromIdentityId: null,
        fromIdentityHint: null,
        attachments: [],
        sourceEmailId: null,
        sourceFlag: null,
      },
      createdAt: 0,
      updatedAt: 1,
      lastError: null,
      ...over,
    }
  }

  it('creates a new draft Email (no destroy) and stamps the server id on the local row', async () => {
    await db.drafts.put(draftRow())
    let args: SetArgs | undefined
    const port = fakePort({
      setEmails: async (a) => {
        args = a
        return setResult({ created: { 'draft-d1': { id: 'srv-1' } } })
      },
    })
    await enqueueAction(
      db,
      ACC,
      {
        kind: 'saveDraft',
        localId: 'd1',
        creationId: 'draft-d1',
        priorServerId: null,
        email: emailCreate,
      },
      { id: 'draft:d1', now: 1 },
    )

    const summary = await replayOutbox(port, db, ACC, { random: NO_JITTER })

    expect(args).toEqual({ create: { 'draft-d1': emailCreate }, ifInState: null })
    expect(summary.replayed).toBe(1)
    const saved = await db.drafts.get([ACC, 'd1'])
    expect(saved?.serverEmailId).toBe('srv-1')
    expect(saved?.status).toBe('synced')
    expect(await row('draft:d1')).toBeUndefined()
  })

  it('destroys the prior server draft when saving over an existing one (create-before-destroy)', async () => {
    await db.drafts.put(draftRow({ serverEmailId: 'srv-1', status: 'synced' }))
    let args: SetArgs | undefined
    const port = fakePort({
      setEmails: async (a) => {
        args = a
        return setResult({ created: { 'draft-d1': { id: 'srv-2' } }, destroyed: ['srv-1'] })
      },
    })
    await enqueueAction(
      db,
      ACC,
      {
        kind: 'saveDraft',
        localId: 'd1',
        creationId: 'draft-d1',
        priorServerId: 'srv-1',
        email: emailCreate,
      },
      { id: 'draft:d1', now: 1 },
    )

    await replayOutbox(port, db, ACC, { random: NO_JITTER })

    expect(args?.create).toEqual({ 'draft-d1': emailCreate })
    expect(args?.destroy).toEqual(['srv-1'])
    expect((await db.drafts.get([ACC, 'd1']))?.serverEmailId).toBe('srv-2')
  })

  it('marks the draft row error with the SetError type when the create is rejected', async () => {
    await db.drafts.put(draftRow())
    const port = fakePort({
      setEmails: async () =>
        setResult({ notCreated: { 'draft-d1': { type: 'invalidProperties' } } }),
    })
    await enqueueAction(
      db,
      ACC,
      {
        kind: 'saveDraft',
        localId: 'd1',
        creationId: 'draft-d1',
        priorServerId: null,
        email: emailCreate,
      },
      { id: 'draft:d1', now: 1 },
    )

    const summary = await replayOutbox(port, db, ACC, { random: NO_JITTER })

    expect(summary.failed).toBe(1)
    const errored = await db.drafts.get([ACC, 'd1'])
    expect(errored?.status).toBe('error')
    expect(errored?.lastError).toBe('invalidProperties')
    expect((await row('draft:d1'))?.status).toBe('error')
  })

  it('discards a draft by destroying its server Email; a gone id is still a success', async () => {
    let args: SetArgs | undefined
    const port = fakePort({
      setEmails: async (a) => {
        args = a
        return setResult({ notDestroyed: { 'srv-1': { type: 'notFound' } } })
      },
    })
    await enqueueAction(
      db,
      ACC,
      { kind: 'discardDraft', localId: 'd1', serverEmailId: 'srv-1' },
      { id: 'draft:d1', now: 1 },
    )

    const summary = await replayOutbox(port, db, ACC, { random: NO_JITTER })

    expect(args).toEqual({ destroy: ['srv-1'], ifInState: null })
    expect(summary.replayed).toBe(1) // already gone ⇒ satisfied
    expect(await row('draft:d1')).toBeUndefined()
  })
})

describe('outbox — sendEmail (M2.8)', () => {
  const emailCreate: EmailCreate = {
    mailboxIds: { 'mb-d': true },
    keywords: { $draft: true, $seen: true },
    subject: 'Hi',
    from: null,
    to: [{ name: null, email: 'a@x.test' }],
    cc: [],
    bcc: [],
    inReplyTo: null,
    references: null,
    htmlBody: [{ partId: 'html', type: 'text/html' }],
    bodyValues: { html: { value: '<p>x</p>', isEncodingProblem: false, isTruncated: false } },
  }

  function draftRow(over: Partial<DraftRow> = {}): DraftRow {
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
      ...over,
    }
  }

  const sendIntent = (over: Record<string, unknown> = {}) =>
    ({
      kind: 'sendEmail',
      localId: 'd1',
      emailCreationId: 'send-d1',
      submissionCreationId: 'sub-d1',
      priorServerId: null,
      email: emailCreate,
      identityId: 'id1',
      envelope: { mailFrom: { email: 'me@x.test' }, rcptTo: [{ email: 'a@x.test' }] },
      onSuccessUpdateEmail: {
        'mailboxIds/mb-d': null,
        'mailboxIds/mb-s': true,
        'keywords/$draft': null,
        'keywords/$seen': true,
      },
      source: { emailId: 'src-9', keyword: '$answered' },
      ...over,
    }) as Parameters<typeof enqueueAction>[2]

  it('confirmed send: flags the source, deletes the drafts row, drops the outbox row', async () => {
    await putEmails(db, ACC, [email('src-9', { keywords: {} })])
    await db.drafts.put(draftRow())
    let args: Parameters<JmapPort['submitEmail']>[0] | undefined
    const port = fakePort({
      submitEmail: async (a) => {
        args = a
        return setResult({ created: { 'sub-d1': { id: 'srv-sub' } } })
      },
    })
    await enqueueAction(db, ACC, sendIntent(), { id: 'send:d1', now: 1 })
    expect((await db.emails.get([ACC, 'src-9']))?.keywords).toEqual({ $answered: true }) // optimistic

    const summary = await replayOutbox(port, db, ACC, { now: 1, random: NO_JITTER })

    expect(summary.replayed).toBe(1)
    expect(args?.sourceUpdate).toEqual({ id: 'src-9', patch: { 'keywords/$answered': true } })
    expect(await db.drafts.get([ACC, 'd1'])).toBeUndefined() // reconcileSend dropped it
    expect(await row('send:d1')).toBeUndefined()
    expect((await db.emails.get([ACC, 'src-9']))?.keywords).toEqual({ $answered: true }) // kept
  })

  it('rejected send: rolls back the source flag, marks the drafts row error', async () => {
    await putEmails(db, ACC, [email('src-9', { keywords: {} })])
    await db.drafts.put(draftRow())
    await enqueueAction(db, ACC, sendIntent(), { id: 'send:d1', now: 1 })
    const port = fakePort({
      submitEmail: async () => setResult({ notCreated: { 'sub-d1': { type: 'forbiddenToSend' } } }),
    })

    const summary = await replayOutbox(port, db, ACC, { now: 1, random: NO_JITTER })

    expect(summary.failed).toBe(1)
    expect((await db.emails.get([ACC, 'src-9']))?.keywords).toEqual({}) // source flag rolled back
    const errored = await db.drafts.get([ACC, 'd1'])
    expect(errored?.status).toBe('error')
    expect(errored?.lastError).toBe('forbiddenToSend')
    expect(errored?.errorKind).toBe('send') // send failures are surfaced live; save failures are not
    const dead = await row('send:d1')
    expect(dead?.status).toBe('error')
    expect(dead?.conflict?.code).toBe('sendRejected')
  })

  it('rejected send: adopts the sibling Email/set-created draft id so a resave does not duplicate', async () => {
    await db.drafts.put(draftRow({ serverEmailId: 'old-draft' }))
    const port = fakePort({
      submitEmail: async () =>
        setResult({
          notCreated: { 'sub-d1': { type: 'overQuota' } },
          emailCreated: { id: 'new-draft' },
        }),
    })
    await enqueueAction(db, ACC, sendIntent({ source: null }), { id: 'send:d1', now: 1 })

    await replayOutbox(port, db, ACC, { now: 1, random: NO_JITTER })

    // The submission failed but its Email/set create committed a NEW draft (the prior was destroyed);
    // the row must point at that fresh id, else the reopened draft's next save destroys a gone id.
    const errored = await db.drafts.get([ACC, 'd1'])
    expect(errored?.serverEmailId).toBe('new-draft')
    expect(errored?.status).toBe('error')
    expect(errored?.errorKind).toBe('send')
  })

  it('does not replay before the undo-send grace (notBefore) elapses', async () => {
    await db.drafts.put(draftRow())
    let called = false
    const port = fakePort({
      submitEmail: async () => {
        called = true
        return setResult({ created: { 'sub-d1': { id: 's' } } })
      },
    })
    await enqueueAction(db, ACC, sendIntent({ source: null }), {
      id: 'send:d1',
      now: 1,
      notBefore: 1000,
    })

    let summary = await replayOutbox(port, db, ACC, { now: 500, random: NO_JITTER })
    expect(called).toBe(false)
    expect(summary.replayed).toBe(0)
    expect((await row('send:d1'))?.status).toBe('pending')

    summary = await replayOutbox(port, db, ACC, { now: 1000, random: NO_JITTER })
    expect(called).toBe(true)
    expect(summary.replayed).toBe(1)
  })

  it('never auto-resends a send stranded inflight; it dead-letters with the sendInterrupted CODE', async () => {
    await putEmails(db, ACC, [email('src-9', { keywords: {} })])
    await db.drafts.put(draftRow())
    await db.outbox.put({
      accountId: ACC,
      id: 'send:d1',
      type: 'sendEmail',
      payload: sendIntent(),
      ifInState: null,
      status: 'inflight',
      attempts: 0,
      createdAt: 1,
      lastError: null,
      notBefore: null,
      // The undo survived the crash with the row (M3.3) — the source flag rolls back on recovery.
      undo: { kind: 'keywords', keyword: '$answered', had: [] },
      conflict: null,
      nextAttemptAt: null,
      refreshes: 0,
    })
    await putEmails(db, ACC, [email('src-9', { keywords: { $answered: true } })]) // optimistic state
    let called = false
    const port = fakePort({
      submitEmail: async () => {
        called = true
        return setResult({ created: { 'sub-d1': { id: 's' } } })
      },
    })

    await replayOutbox(port, db, ACC, { now: 5, random: NO_JITTER })

    expect(called).toBe(false) // not re-sent
    const dead = await row('send:d1')
    expect(dead?.status).toBe('error')
    expect(dead?.conflict?.code).toBe('sendInterrupted')
    // A stable CODE, never prose — `use-send-error-notifier` maps it to an i18n key (defect D8).
    expect(dead?.lastError).toBe('sendInterrupted')
    expect((await db.drafts.get([ACC, 'd1']))?.status).toBe('error')
    expect((await db.drafts.get([ACC, 'd1']))?.lastError).toBe('sendInterrupted')
    expect((await db.emails.get([ACC, 'src-9']))?.keywords).toEqual({}) // undo drained
  })

  it('NEVER auto-retries a send whose request THREW — an unknown outcome must not double-send', async () => {
    await putEmails(db, ACC, [email('src-9', { keywords: {} })])
    await db.drafts.put(draftRow())
    await enqueueAction(db, ACC, sendIntent(), { id: 'send:d1', now: 1 })
    let calls = 0
    const port = fakePort({
      submitEmail: async () => {
        calls += 1
        // The request may have been PROCESSED and only the response lost — the outcome is unknown.
        throw new TypeError('fetch failed')
      },
    })

    await replayOutbox(port, db, ACC, { now: 5, random: NO_JITTER })

    // For any idempotent intent a thrown error backs off and stays `pending`. An EmailSubmission is
    // NOT idempotent, so retrying could deliver the message twice: it must dead-letter instead.
    const dead = await row('send:d1')
    expect(dead?.status).toBe('error')
    expect(dead?.conflict?.code).toBe('sendInterrupted')
    expect(dead?.nextAttemptAt ?? null).toBeNull() // NOT armed for a retry

    // Even far past any backoff window, a later pass must not hit the server again.
    await replayOutbox(port, db, ACC, { now: 1_000_000, random: NO_JITTER })
    expect(calls).toBe(1)

    expect((await db.drafts.get([ACC, 'd1']))?.status).toBe('error') // draft reopens for the user
    expect((await db.emails.get([ACC, 'src-9']))?.keywords).toEqual({}) // source flag rolled back
  })
})
