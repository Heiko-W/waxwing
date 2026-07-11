import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ReplicaDb } from './db'
import {
  emailIdsInMailbox,
  emailsByIds,
  emailsInThread,
  emailsWithKeyword,
  enqueue,
  getEmailBody,
  getPref,
  getQueryCache,
  getSyncState,
  getThread,
  lruBodies,
  mailboxByRole,
  mailboxesForAccount,
  pendingOutbox,
  putEmailBody,
  putEmails,
  putMailboxes,
  putQueryCache,
  putThreads,
  setPref,
  setSyncState,
} from './repo'
import { email, freshDb, mailbox, thread } from './test-utils'

let db: ReplicaDb
const ACC = 'acc'

beforeEach(() => {
  db = freshDb()
})

afterEach(async () => {
  await db.delete()
})

describe('folder tree queries (M1.5)', () => {
  beforeEach(async () => {
    await putMailboxes(db, ACC, [
      mailbox('inbox', { role: 'inbox', sortOrder: 0 }),
      mailbox('zeta', { sortOrder: 5, name: 'Zeta' }),
      mailbox('alpha', { sortOrder: 5, name: 'Alpha' }),
    ])
  })

  it('returns all mailboxes ordered by sortOrder then name', async () => {
    const rows = await mailboxesForAccount(db, ACC)
    expect(rows.map((row) => row.id)).toEqual(['inbox', 'alpha', 'zeta'])
  })

  it('looks up a role mailbox by index', async () => {
    expect((await mailboxByRole(db, ACC, 'inbox'))?.id).toBe('inbox')
    expect(await mailboxByRole(db, ACC, 'archive')).toBeUndefined()
  })
})

describe('message-list queries (M1.6)', () => {
  beforeEach(async () => {
    await putEmails(db, ACC, [
      email('e1', { mailboxIds: { inbox: true }, threadId: 'tX' }),
      email('e2', { mailboxIds: { inbox: true }, threadId: 'tX' }),
      email('e3', { mailboxIds: { archive: true }, threadId: 'tY' }),
    ])
  })

  it('hydrates an ordered window, preserving order and marking gaps', async () => {
    const rows = await emailsByIds(db, ACC, ['e2', 'missing', 'e1'])
    expect(rows.map((row) => row?.id)).toEqual(['e2', undefined, 'e1'])
  })

  it('returns the full id-set for select-all-in-folder', async () => {
    const ids = await emailIdsInMailbox(db, ACC, 'inbox')
    expect(ids.sort()).toEqual(['e1', 'e2'])
  })

  it('groups emails by thread', async () => {
    const rows = await emailsInThread(db, ACC, 'tX')
    expect(rows.map((row) => row.id).sort()).toEqual(['e1', 'e2'])
  })
})

describe('keyword membership (flagged / labels — FR-LST, M3.2)', () => {
  it('returns account-scoped emails carrying a keyword', async () => {
    await putEmails(db, ACC, [
      email('f1', { keywords: { $flagged: true } }),
      email('f2', { keywords: {} }),
    ])
    // A same-id flagged email in another account must NOT leak into ACC's results.
    await putEmails(db, 'other', [email('f1', { keywords: { $flagged: true } })])

    const flagged = await emailsWithKeyword(db, ACC, '$flagged')

    expect(flagged.map((row) => row.id)).toEqual(['f1'])
    expect(flagged.every((row) => row.accountId === ACC)).toBe(true)
  })
})

describe('email bodies + LRU (M1.8 / FR-OFF-04)', () => {
  it('stamps lastAccessedAt on read and orders eviction oldest-first', async () => {
    const structure = { partId: '1', blobId: 'b', size: 1 } as never
    await putEmailBody(db, {
      accountId: ACC,
      id: 'e1',
      bodyValues: {},
      bodyStructure: structure,
      textBody: [],
      htmlBody: [],
      attachments: [],
      hasAttachment: false,
      fetchedAt: 1,
      lastAccessedAt: 1,
    })
    await putEmailBody(db, {
      accountId: ACC,
      id: 'e2',
      bodyValues: {},
      bodyStructure: structure,
      textBody: [],
      htmlBody: [],
      attachments: [],
      hasAttachment: false,
      fetchedAt: 2,
      lastAccessedAt: 2,
    })

    // e1 is oldest.
    expect((await lruBodies(db, ACC, 1)).map((row) => row.id)).toEqual(['e1'])

    // Touching e1 moves it to the front; e2 becomes the eviction candidate.
    const touched = await getEmailBody(db, ACC, 'e1', 99)
    expect(touched?.id).toBe('e1')
    expect((await lruBodies(db, ACC, 1)).map((row) => row.id)).toEqual(['e2'])
  })
})

describe('sync state, query cache, prefs, outbox', () => {
  it('reads and writes the per-type JMAP state string', async () => {
    expect(await getSyncState(db, ACC, 'Email')).toBeNull()
    await setSyncState(db, ACC, 'Email', 'state-1', 1)
    expect(await getSyncState(db, ACC, 'Email')).toBe('state-1')
  })

  it('round-trips a query-cache window', async () => {
    await putQueryCache(db, {
      accountId: ACC,
      key: 'k',
      ids: ['e1', 'e2'],
      queryState: 'qs',
      total: 2,
      upToId: 'e2',
      filter: { inMailbox: 'inbox' },
      sort: [{ property: 'receivedAt', isAscending: false }],
      collapseThreads: true,
      lastUsedAt: 1,
    })
    expect((await getQueryCache(db, ACC, 'k'))?.ids).toEqual(['e1', 'e2'])
  })

  it('stores typed local preferences', async () => {
    await setPref(db, ACC, 'tree.collapsed', ['archive'])
    expect(await getPref<string[]>(db, ACC, 'tree.collapsed')).toEqual(['archive'])
    expect(await getPref<string[]>(db, ACC, 'missing')).toBeUndefined()
  })

  it('returns pending/errored outbox intents in FIFO order', async () => {
    await enqueue(db, {
      accountId: ACC,
      id: 'i2',
      type: 'setKeywords',
      payload: {},
      ifInState: null,
      status: 'pending',
      attempts: 0,
      createdAt: 20,
      lastError: null,
      notBefore: null,
    })
    await enqueue(db, {
      accountId: ACC,
      id: 'i1',
      type: 'move',
      payload: {},
      ifInState: null,
      status: 'error',
      attempts: 1,
      createdAt: 10,
      lastError: 'boom',
      notBefore: null,
    })
    await enqueue(db, {
      accountId: ACC,
      id: 'i3',
      type: 'destroy',
      payload: {},
      ifInState: null,
      status: 'done',
      attempts: 1,
      createdAt: 30,
      lastError: null,
      notBefore: null,
    })

    const pending = await pendingOutbox(db, ACC)
    expect(pending.map((row) => row.id)).toEqual(['i1', 'i2'])
  })
})

describe('threads helper', () => {
  it('round-trips a stored thread via getThread', async () => {
    await putThreads(db, ACC, [thread('t1', ['e1', 'e2'])])
    expect((await getThread(db, ACC, 't1'))?.emailIds).toEqual(['e1', 'e2'])
    expect(await getThread(db, ACC, 'no-such-thread')).toBeUndefined()
  })
})
