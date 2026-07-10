import { JmapMethodError } from '@waxwing/jmap'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ReplicaDb } from '../db'
import { emailsInMailbox, emailsWithKeyword, pendingOutbox, putEmails } from '../repo'
import { email, freshDb } from '../test-utils'
import { enqueueAction, type Rollback, replayOutbox } from './outbox'
import type { JmapPort, PortSetResult } from './types'

let db: ReplicaDb
const ACC = 'acc'

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
    getThreads: unused,
    getEmailEnvelopes: unused,
    queryEmails: unused,
    queryEmailChanges: unused,
    setEmails: unused,
    setMailboxes: unused,
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

describe('outbox — optimistic apply + enqueue', () => {
  it('applies setKeywords to the replica and enqueues a pending intent', async () => {
    await putEmails(db, ACC, [email('e1', { keywords: {} })])

    await enqueueAction(
      db,
      ACC,
      { kind: 'setKeywords', emailIds: ['e1'], keyword: '$seen', value: true },
      { id: 'i1', now: 1 },
    )

    expect((await db.emails.get([ACC, 'e1']))?.keywords).toEqual({ $seen: true })
    expect((await emailsWithKeyword(db, ACC, '$seen')).map((row) => row.id)).toEqual(['e1'])
    expect((await pendingOutbox(db, ACC)).map((row) => row.id)).toEqual(['i1'])
  })

  it('applies move across mailboxes and updates the membership index', async () => {
    await putEmails(db, ACC, [email('e1', { mailboxIds: { inbox: true } })])

    await enqueueAction(
      db,
      ACC,
      { kind: 'move', emailIds: ['e1'], from: 'inbox', to: 'archive' },
      { id: 'i1', now: 1 },
    )

    expect((await db.emails.get([ACC, 'e1']))?.mailboxIds).toEqual({ archive: true })
    expect((await emailsInMailbox(db, ACC, 'archive')).map((row) => row.id)).toEqual(['e1'])
    expect(await emailsInMailbox(db, ACC, 'inbox')).toEqual([])
  })
})

describe('outbox — replay resilience (M1.3 review)', () => {
  it('a method-level rejection on one intent does not wedge the FIFO tail', async () => {
    await putEmails(db, ACC, [email('e1', { keywords: {} }), email('e2', { keywords: {} })])
    const rollbacks = new Map<string, Rollback>()
    for (const [id, ids] of [
      ['i1', ['e1']],
      ['i2', ['e2']],
    ] as const) {
      const { rollback } = await enqueueAction(
        db,
        ACC,
        { kind: 'setKeywords', emailIds: [...ids], keyword: '$seen', value: true },
        { id, now: id === 'i1' ? 1 : 2 },
      )
      rollbacks.set(id, rollback)
    }
    const port = fakePort({
      setEmails: async (args) => {
        const update = (args as { update?: Record<string, unknown> }).update ?? {}
        if ('e1' in update) throw new JmapMethodError({ type: 'invalidArguments' }, 'c1')
        return setResult({ updated: ['e2'] })
      },
    })

    const summary = await replayOutbox(port, db, ACC, { rollbacks })

    expect(summary).toEqual({ replayed: 1, failed: 1 })
    expect((await db.outbox.get([ACC, 'i1']))?.status).toBe('error') // dead-letter
    expect(await db.outbox.get([ACC, 'i2'])).toBeUndefined() // replayed despite i1 failing
    expect((await db.emails.get([ACC, 'e1']))?.keywords).toEqual({}) // rolled back
    expect((await db.emails.get([ACC, 'e2']))?.keywords).toEqual({ $seen: true }) // kept

    // A second sweep must NOT re-process the terminal error row.
    const again = await replayOutbox(port, db, ACC, { rollbacks })
    expect(again).toEqual({ replayed: 0, failed: 0 })
    expect((await db.outbox.get([ACC, 'i1']))?.status).toBe('error')
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
    })
    const port = fakePort({ setEmails: async () => setResult({ updated: ['e1'] }) })

    const summary = await replayOutbox(port, db, ACC)

    expect(summary.replayed).toBe(1)
    expect(await db.outbox.get([ACC, 'i1'])).toBeUndefined()
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

    await replayOutbox(port, db, ACC)

    expect((await db.emails.get([ACC, 'e1']))?.mailboxIds).toEqual({ 'srv-9': true })
    expect((await emailsInMailbox(db, ACC, 'srv-9')).map((row) => row.id)).toEqual(['e1'])
    expect(await db.mailboxes.get([ACC, 'srv-9'])).toBeDefined()
    expect(await db.mailboxes.get([ACC, 'tmp'])).toBeUndefined()
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

    const summary = await replayOutbox(port, db, ACC)

    expect(summary).toEqual({ replayed: 1, failed: 0 })
    expect(await db.outbox.count()).toBe(0)
    expect((await db.emails.get([ACC, 'e1']))?.keywords).toEqual({ $seen: true })
  })

  it('rolls back and marks error on a per-object rejection', async () => {
    await putEmails(db, ACC, [email('e1', { keywords: {} })])
    const { rollback } = await enqueueAction(
      db,
      ACC,
      { kind: 'setKeywords', emailIds: ['e1'], keyword: '$seen', value: true },
      { id: 'i1', now: 1 },
    )
    const rollbacks = new Map<string, Rollback>([['i1', rollback]])
    const port = fakePort({
      setEmails: async () => setResult({ notUpdated: { e1: { type: 'stateMismatch' } } }),
    })

    const summary = await replayOutbox(port, db, ACC, { rollbacks })

    expect(summary).toEqual({ replayed: 0, failed: 1 })
    expect((await db.emails.get([ACC, 'e1']))?.keywords).toEqual({})
    const row = await db.outbox.get([ACC, 'i1'])
    expect(row?.status).toBe('error')
    expect(row?.lastError).toBe('stateMismatch')
  })

  it('keeps the row pending and the optimistic state on a transport error', async () => {
    await putEmails(db, ACC, [email('e1', { keywords: {} })])
    const { rollback } = await enqueueAction(
      db,
      ACC,
      { kind: 'setKeywords', emailIds: ['e1'], keyword: '$seen', value: true },
      { id: 'i1', now: 1 },
    )
    const rollbacks = new Map<string, Rollback>([['i1', rollback]])
    const port = fakePort({
      setEmails: async () => {
        throw new Error('offline')
      },
    })

    const summary = await replayOutbox(port, db, ACC, { rollbacks })

    expect(summary).toEqual({ replayed: 0, failed: 0 })
    const row = await db.outbox.get([ACC, 'i1'])
    expect(row?.status).toBe('pending')
    expect(row?.attempts).toBe(1)
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

    await replayOutbox(port, db, ACC)

    expect(await db.mailboxes.get([ACC, 'tmp1'])).toBeUndefined()
    expect((await db.mailboxes.get([ACC, 'MB99']))?.name).toBe('Receipts')
  })
})
