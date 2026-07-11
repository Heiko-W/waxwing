import { type EmailCreate, JmapMethodError } from '@waxwing/jmap'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DraftRow, ReplicaDb } from '../db'
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
      notBefore: null,
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

    const summary = await replayOutbox(port, db, ACC)

    expect(args).toEqual({ create: { 'draft-d1': emailCreate }, ifInState: null })
    expect(summary.replayed).toBe(1)
    const row = await db.drafts.get([ACC, 'd1'])
    expect(row?.serverEmailId).toBe('srv-1')
    expect(row?.status).toBe('synced')
    expect(await db.outbox.get([ACC, 'draft:d1'])).toBeUndefined()
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

    await replayOutbox(port, db, ACC)

    expect(args?.create).toEqual({ 'draft-d1': emailCreate })
    expect(args?.destroy).toEqual(['srv-1'])
    expect((await db.drafts.get([ACC, 'd1']))?.serverEmailId).toBe('srv-2')
  })

  it('marks the draft row error when the create is rejected', async () => {
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

    const summary = await replayOutbox(port, db, ACC)

    expect(summary.failed).toBe(1)
    const row = await db.drafts.get([ACC, 'd1'])
    expect(row?.status).toBe('error')
    expect(row?.lastError).toBe('invalidProperties')
    expect((await db.outbox.get([ACC, 'draft:d1']))?.status).toBe('error')
  })

  it('discards a draft by destroying its server Email', async () => {
    let args: SetArgs | undefined
    const port = fakePort({
      setEmails: async (a) => {
        args = a
        return setResult({ destroyed: ['srv-1'] })
      },
    })
    await enqueueAction(
      db,
      ACC,
      { kind: 'discardDraft', localId: 'd1', serverEmailId: 'srv-1' },
      { id: 'draft:d1', now: 1 },
    )

    const summary = await replayOutbox(port, db, ACC)

    expect(args).toEqual({ destroy: ['srv-1'], ifInState: null })
    expect(summary.replayed).toBe(1)
    expect(await db.outbox.get([ACC, 'draft:d1'])).toBeUndefined()
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
    await enqueueAction(db, ACC, sendIntent(), { id: 'draft:d1', now: 1 })
    expect((await db.emails.get([ACC, 'src-9']))?.keywords).toEqual({ $answered: true }) // optimistic

    const summary = await replayOutbox(port, db, ACC, { now: 1 })

    expect(summary.replayed).toBe(1)
    expect(args?.sourceUpdate).toEqual({ id: 'src-9', patch: { 'keywords/$answered': true } })
    expect(await db.drafts.get([ACC, 'd1'])).toBeUndefined() // reconcileSend dropped it
    expect(await db.outbox.get([ACC, 'draft:d1'])).toBeUndefined()
    expect((await db.emails.get([ACC, 'src-9']))?.keywords).toEqual({ $answered: true }) // kept
  })

  it('rejected send: rolls back the source flag, marks the drafts row error', async () => {
    await putEmails(db, ACC, [email('src-9', { keywords: {} })])
    await db.drafts.put(draftRow())
    const { rollback } = await enqueueAction(db, ACC, sendIntent(), { id: 'draft:d1', now: 1 })
    const rollbacks = new Map<string, Rollback>([['draft:d1', rollback]])
    const port = fakePort({
      submitEmail: async () => setResult({ notCreated: { 'sub-d1': { type: 'forbiddenToSend' } } }),
    })

    const summary = await replayOutbox(port, db, ACC, { rollbacks, now: 1 })

    expect(summary.failed).toBe(1)
    expect((await db.emails.get([ACC, 'src-9']))?.keywords).toEqual({}) // source flag rolled back
    const row = await db.drafts.get([ACC, 'd1'])
    expect(row?.status).toBe('error')
    expect(row?.lastError).toBe('forbiddenToSend')
    expect((await db.outbox.get([ACC, 'draft:d1']))?.status).toBe('error')
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
      id: 'draft:d1',
      now: 1,
      notBefore: 1000,
    })

    let summary = await replayOutbox(port, db, ACC, { now: 500 })
    expect(called).toBe(false)
    expect(summary.replayed).toBe(0)
    expect((await db.outbox.get([ACC, 'draft:d1']))?.status).toBe('pending')

    summary = await replayOutbox(port, db, ACC, { now: 1000 })
    expect(called).toBe(true)
    expect(summary.replayed).toBe(1)
  })

  it('never auto-resends a send stranded inflight (EmailSubmission is not idempotent)', async () => {
    await db.drafts.put(draftRow())
    await db.outbox.put({
      accountId: ACC,
      id: 'draft:d1',
      type: 'sendEmail',
      payload: sendIntent({ source: null }),
      ifInState: null,
      status: 'inflight',
      attempts: 0,
      createdAt: 1,
      lastError: null,
      notBefore: null,
    })
    let called = false
    const port = fakePort({
      submitEmail: async () => {
        called = true
        return setResult({ created: { 'sub-d1': { id: 's' } } })
      },
    })

    await replayOutbox(port, db, ACC, { now: 5 })

    expect(called).toBe(false) // not re-sent
    expect((await db.outbox.get([ACC, 'draft:d1']))?.status).toBe('error')
    expect((await db.drafts.get([ACC, 'd1']))?.status).toBe('error')
  })
})
