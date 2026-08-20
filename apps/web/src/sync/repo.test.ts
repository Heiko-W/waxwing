import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ReplicaDb } from './db'
import {
  addressBooksForAccount,
  contactCardsByIds,
  countEmailsWithKeyword,
  deleteAddressBooks,
  deleteContactCards,
  emailIdsInMailbox,
  emailIdsWithKeyword,
  emailsByIds,
  emailsInThread,
  emailsWithKeyword,
  enqueue,
  failedOutbox,
  getContactQueryCache,
  getEmailBody,
  getPref,
  getQueryCache,
  getSyncState,
  getThread,
  labelUnreadCounts,
  lruBodies,
  mailboxByRole,
  mailboxesForAccount,
  pendingOutbox,
  putAddressBooks,
  putContactCards,
  putContactQueryCache,
  putEmailBody,
  putEmails,
  putMailboxes,
  putQueryCache,
  putThreads,
  queuedSends,
  setPref,
  setSyncState,
} from './repo'
import { addressBook, contactCard, email, freshDb, mailbox, thread } from './test-utils'

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

  /*
   * The row-free readers over the SAME index range. They exist because two callers wanted a count
   * and a list of ids and were paying for a full envelope each to get them — so what has to hold is
   * that they agree with the reader that does load rows, account scoping included. A cheaper query
   * that answers a slightly different question would be worse than the cost it saves.
   */
  it('counts and lists ids over the same range, without leaking another account', async () => {
    await putEmails(db, ACC, [
      email('k1', { keywords: { work: true } }),
      email('k2', { keywords: { work: true } }),
      email('k3', { keywords: {} }),
    ])
    await putEmails(db, 'other', [email('k9', { keywords: { work: true } })])

    const rows = await emailsWithKeyword(db, ACC, 'work')
    const ids = await emailIdsWithKeyword(db, ACC, 'work')
    const count = await countEmailsWithKeyword(db, ACC, 'work')

    expect(ids.sort()).toEqual(['k1', 'k2'])
    expect(count).toBe(2)
    expect(ids.sort()).toEqual(rows.map((row) => row.id).sort())
    expect(count).toBe(rows.length)
  })

  it('answers zero for a keyword nothing carries', async () => {
    await putEmails(db, ACC, [email('n1', { keywords: {} })])
    expect(await countEmailsWithKeyword(db, ACC, 'absent')).toBe(0)
    expect(await emailIdsWithKeyword(db, ACC, 'absent')).toEqual([])
  })

  it('counts unread per keyword concurrently and agrees with the rows', async () => {
    await putEmails(db, ACC, [
      email('u1', { keywords: { work: true } }),
      email('u2', { keywords: { work: true, $seen: true } }),
      email('u3', { keywords: { home: true } }),
    ])

    const counts = await labelUnreadCounts(db, ACC, ['work', 'home', 'absent'])

    expect(counts.get('work')).toBe(1)
    expect(counts.get('home')).toBe(1)
    expect(counts.get('absent')).toBe(0)
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
      authResults: [],
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
      authResults: [],
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

  /**
   * The LIVE queue and the DEAD-LETTER queue are separate reads (M3.3, defect D4). `pendingOutbox`
   * used to return `error` rows too, which permanently inflated `EngineStatus.pendingActions` with
   * every dead letter and made replay re-scan rows it can never send.
   */
  it('separates the live queue (pending+inflight) from the dead letters (error)', async () => {
    const base = { accountId: ACC, payload: {}, ifInState: null, notBefore: null }
    await enqueue(db, {
      ...base,
      id: 'i2',
      type: 'setKeywords',
      status: 'pending',
      attempts: 0,
      createdAt: 20,
      lastError: null,
    })
    await enqueue(db, {
      ...base,
      id: 'i1',
      type: 'move',
      status: 'error',
      attempts: 1,
      createdAt: 10,
      lastError: 'notFound',
    })
    await enqueue(db, {
      ...base,
      id: 'i3',
      type: 'destroy',
      status: 'done',
      attempts: 1,
      createdAt: 30,
      lastError: null,
    })
    await enqueue(db, {
      ...base,
      id: 'i4',
      type: 'setKeywords',
      status: 'inflight',
      attempts: 0,
      createdAt: 15,
      lastError: null,
    })

    // FIFO by createdAt; the `error` dead letter i1 and the terminal `done` i3 are excluded.
    expect((await pendingOutbox(db, ACC)).map((row) => row.id)).toEqual(['i4', 'i2'])
    expect((await failedOutbox(db, ACC)).map((row) => row.id)).toEqual(['i1'])
  })

  it('returns queued sends (pending sendEmail rows) oldest first', async () => {
    const base = { accountId: ACC, payload: {}, ifInState: null, notBefore: null, lastError: null }
    await enqueue(db, {
      ...base,
      id: 'send:b',
      type: 'sendEmail',
      status: 'pending',
      attempts: 0,
      createdAt: 20,
    })
    await enqueue(db, {
      ...base,
      id: 'send:a',
      type: 'sendEmail',
      status: 'pending',
      attempts: 0,
      createdAt: 10,
    })
    // Already dispatched (inflight) — no longer cancelable, so not a "queued" send.
    await enqueue(db, {
      ...base,
      id: 'send:c',
      type: 'sendEmail',
      status: 'inflight',
      attempts: 0,
      createdAt: 5,
    })
    await enqueue(db, {
      ...base,
      id: 'i9',
      type: 'setKeywords',
      status: 'pending',
      attempts: 0,
      createdAt: 1,
    })

    expect((await queuedSends(db, ACC)).map((row) => row.id)).toEqual(['send:a', 'send:b'])
  })
})

describe('threads helper', () => {
  it('round-trips a stored thread via getThread', async () => {
    await putThreads(db, ACC, [thread('t1', ['e1', 'e2'])])
    expect((await getThread(db, ACC, 't1'))?.emailIds).toEqual(['e1', 'e2'])
    expect(await getThread(db, ACC, 'no-such-thread')).toBeUndefined()
  })
})

describe('contacts repo (M4.2)', () => {
  it('orders address books by sortOrder then name, and deletes by id', async () => {
    await putAddressBooks(db, ACC, [
      addressBook('personal', { sortOrder: 0, name: 'Personal' }),
      addressBook('zeta', { sortOrder: 5, name: 'Zeta' }),
      addressBook('alpha', { sortOrder: 5, name: 'Alpha' }),
    ])
    expect((await addressBooksForAccount(db, ACC)).map((b) => b.id)).toEqual([
      'personal',
      'alpha',
      'zeta',
    ])

    await deleteAddressBooks(db, ACC, ['alpha'])
    expect((await addressBooksForAccount(db, ACC)).map((b) => b.id)).toEqual(['personal', 'zeta'])
  })

  it('hydrates a contact window in order, marking gaps, and deletes by id', async () => {
    await putContactCards(db, ACC, [contactCard('c1'), contactCard('c2'), contactCard('c3')])

    const rows = await contactCardsByIds(db, ACC, ['c2', 'missing', 'c1'])
    expect(rows.map((r) => r?.id)).toEqual(['c2', undefined, 'c1'])

    await deleteContactCards(db, ACC, ['c2'])
    expect((await contactCardsByIds(db, ACC, ['c2']))[0]).toBeUndefined()
  })

  it('round-trips a contact query-cache window', async () => {
    await putContactQueryCache(db, {
      accountId: ACC,
      key: 'ck',
      ids: ['c1', 'c2'],
      queryState: 'cqs',
      total: 2,
      upToId: 'c2',
      filter: { inAddressBook: 'book1' },
      sort: [{ property: 'name/surname' }],
      lastUsedAt: 1,
    })
    const row = await getContactQueryCache(db, ACC, 'ck')
    expect(row?.ids).toEqual(['c1', 'c2'])
    expect(row?.filter).toEqual({ inAddressBook: 'book1' })
    expect(await getContactQueryCache(db, ACC, 'missing')).toBeUndefined()
  })
})
