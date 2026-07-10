import type { Mailbox } from '@waxwing/jmap'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EmailEnvelopeInput, ReplicaDb } from '../db'
import {
  getQueryCache,
  getSyncState,
  putEmails,
  putMailboxes,
  putQueryCache,
  setSyncState,
} from '../repo'
import { email, freshDb, mailbox } from '../test-utils'
import { reconcileQuery, syncEmails, syncMailboxes } from './delta'
import {
  CannotCalculateChangesError,
  type ChangesResult,
  type EngineClock,
  type GetResult,
  type JmapPort,
  type QueryChangesResult,
  type QueryResult,
} from './types'

const ACC = 'acc'
const clock: EngineClock = { now: () => 1000, setTimeout: () => 0, clearTimeout: () => {} }

let db: ReplicaDb
beforeEach(() => {
  db = freshDb()
})
afterEach(async () => {
  await db.delete()
})

function emptyChanges(newState: string): ChangesResult {
  return { newState, hasMoreChanges: false, created: [], updated: [], destroyed: [] }
}

function fakePort(overrides: Partial<JmapPort> = {}): JmapPort {
  return {
    accountId: ACC,
    mailboxChanges: async () => emptyChanges('s'),
    threadChanges: async () => emptyChanges('s'),
    emailChanges: async () => emptyChanges('s'),
    getMailboxes: async (): Promise<GetResult<Mailbox>> => ({ list: [], notFound: [], state: 's' }),
    getThreads: async () => ({ list: [], notFound: [], state: 's' }),
    getEmailEnvelopes: async (): Promise<GetResult<EmailEnvelopeInput>> => ({
      list: [],
      notFound: [],
      state: 's',
    }),
    queryEmails: async (): Promise<QueryResult> => ({
      ids: [],
      queryState: 'q',
      canCalculateChanges: true,
      position: 0,
    }),
    queryEmailChanges: async (): Promise<QueryChangesResult> => ({
      oldQueryState: 'q',
      newQueryState: 'q',
      removed: [],
      added: [],
    }),
    setEmails: async () => emptySet(),
    setMailboxes: async () => emptySet(),
    ...overrides,
  }
}

function emptySet() {
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

describe('syncMailboxes', () => {
  it('does an initial full pull and records the state when there is none', async () => {
    const port = fakePort({
      getMailboxes: async () => ({
        list: [mailbox('inbox', { role: 'inbox' }), mailbox('sent', { role: 'sent' })],
        notFound: [],
        state: 'm1',
      }),
    })

    await syncMailboxes(port, db, ACC, clock)

    expect(await db.mailboxes.count()).toBe(2)
    expect(await getSyncState(db, ACC, 'Mailbox')).toBe('m1')
  })

  it('applies a created/destroyed delta across a hasMoreChanges page boundary', async () => {
    await putMailboxes(db, ACC, [mailbox('gone', { role: null })])
    await setSyncState(db, ACC, 'Mailbox', 'm0', 1)

    let page = 0
    const port = fakePort({
      mailboxChanges: async (): Promise<ChangesResult> => {
        page += 1
        return page === 1
          ? { newState: 'm1', hasMoreChanges: true, created: ['fresh'], updated: [], destroyed: [] }
          : { newState: 'm2', hasMoreChanges: false, created: [], updated: [], destroyed: ['gone'] }
      },
      getMailboxes: async () => ({ list: [mailbox('fresh')], notFound: [], state: 'm2' }),
    })

    await syncMailboxes(port, db, ACC, clock)

    expect(await db.mailboxes.get([ACC, 'fresh'])).toBeDefined()
    expect(await db.mailboxes.get([ACC, 'gone'])).toBeUndefined()
    expect(await getSyncState(db, ACC, 'Mailbox')).toBe('m2')
  })

  it('patches only updatedProperties without replacing the row', async () => {
    await putMailboxes(db, ACC, [mailbox('inbox', { name: 'Local Name', unreadEmails: 0 })])
    await setSyncState(db, ACC, 'Mailbox', 'm0', 1)

    const port = fakePort({
      mailboxChanges: async () => ({
        newState: 'm1',
        hasMoreChanges: false,
        created: [],
        updated: ['inbox'],
        destroyed: [],
        updatedProperties: ['unreadEmails'],
      }),
      // The server object carries a different name, which must NOT be applied (patch, not replace).
      getMailboxes: async () => ({
        list: [mailbox('inbox', { name: 'Server Name', unreadEmails: 7 })],
        notFound: [],
        state: 'm1',
      }),
    })

    await syncMailboxes(port, db, ACC, clock)

    const row = await db.mailboxes.get([ACC, 'inbox'])
    expect(row?.unreadEmails).toBe(7)
    expect(row?.name).toBe('Local Name')
  })
})

describe('syncEmails', () => {
  it('is a no-op when there is no Email state', async () => {
    let called = false
    const port = fakePort({
      emailChanges: async () => {
        called = true
        return emptyChanges('e1')
      },
    })

    await syncEmails(port, db, ACC, clock)

    expect(called).toBe(false)
    expect(await db.emails.count()).toBe(0)
  })

  it('applies an Email/changes delta and advances the state', async () => {
    await putEmails(db, ACC, [email('e2')])
    await setSyncState(db, ACC, 'Email', 'e0', 1)

    const port = fakePort({
      emailChanges: async () => ({
        newState: 'e1',
        hasMoreChanges: false,
        created: ['e1'],
        updated: [],
        destroyed: ['e2'],
      }),
      getEmailEnvelopes: async () => ({ list: [email('e1')], notFound: [], state: 'e1' }),
    })

    await syncEmails(port, db, ACC, clock)

    expect(await db.emails.get([ACC, 'e1'])).toBeDefined()
    expect(await db.emails.get([ACC, 'e2'])).toBeUndefined()
    expect(await getSyncState(db, ACC, 'Email')).toBe('e1')
  })
})

describe('reconcileQuery', () => {
  const KEY = 'k'
  const spec = { filter: null, sort: null, collapseThreads: false }

  async function seedWindow(ids: string[], queryState: string) {
    await putQueryCache(db, {
      accountId: ACC,
      key: KEY,
      ids,
      queryState,
      total: ids.length,
      upToId: ids[ids.length - 1] ?? null,
      filter: null,
      sort: null,
      collapseThreads: false,
      lastUsedAt: 1,
    })
  }

  it('applies removed-then-added splices and hydrates missing envelopes', async () => {
    await putEmails(db, ACC, [email('e1'), email('e2'), email('e3')])
    await seedWindow(['e1', 'e2', 'e3'], 'q0')

    let hydrated: string[] = []
    const port = fakePort({
      queryEmailChanges: async () => ({
        oldQueryState: 'q0',
        newQueryState: 'q1',
        removed: ['e2'],
        added: [{ id: 'e9', index: 1 }],
      }),
      getEmailEnvelopes: async (ids) => {
        hydrated = ids
        return { list: ids.map((id) => email(id)), notFound: [], state: 'e1' }
      },
    })

    await reconcileQuery(port, db, ACC, KEY, spec, clock)

    const row = await getQueryCache(db, ACC, KEY)
    expect(row?.ids).toEqual(['e1', 'e9', 'e3'])
    expect(row?.queryState).toBe('q1')
    expect(hydrated).toEqual(['e9'])
    expect(await db.emails.get([ACC, 'e9'])).toBeDefined()
  })

  it('recovers via a full re-query on cannotCalculateChanges', async () => {
    await seedWindow(['e1', 'e2'], 'q0')

    const port = fakePort({
      queryEmailChanges: async () => {
        throw new CannotCalculateChangesError()
      },
      queryEmails: async () => ({
        ids: ['e5'],
        queryState: 'q2',
        canCalculateChanges: true,
        position: 0,
        total: 1,
      }),
      getEmailEnvelopes: async () => ({ list: [email('e5')], notFound: [], state: 'e5' }),
    })

    await reconcileQuery(port, db, ACC, KEY, spec, clock)

    const row = await getQueryCache(db, ACC, KEY)
    expect(row?.ids).toEqual(['e5'])
    expect(row?.queryState).toBe('q2')
  })

  it('forceFull skips queryChanges entirely', async () => {
    await seedWindow(['e1'], 'q0')

    let deltaCalled = false
    const port = fakePort({
      queryEmailChanges: async () => {
        deltaCalled = true
        return { oldQueryState: 'q0', newQueryState: 'q0', removed: [], added: [] }
      },
      queryEmails: async () => ({
        ids: ['e7'],
        queryState: 'q3',
        canCalculateChanges: true,
        position: 0,
      }),
      getEmailEnvelopes: async () => ({ list: [email('e7')], notFound: [], state: 'e7' }),
    })

    await reconcileQuery(port, db, ACC, KEY, spec, clock, true)

    expect(deltaCalled).toBe(false)
    expect((await getQueryCache(db, ACC, KEY))?.ids).toEqual(['e7'])
  })

  it('seeds the Email state on a full re-query when none exists', async () => {
    const port = fakePort({
      queryEmails: async () => ({
        ids: ['e1'],
        queryState: 'q9',
        canCalculateChanges: true,
        position: 0,
      }),
      getEmailEnvelopes: async () => ({ list: [email('e1')], notFound: [], state: 'estate' }),
    })

    await reconcileQuery(port, db, ACC, KEY, spec, clock)

    expect(await getSyncState(db, ACC, 'Email')).toBe('estate')
  })
})

describe('reconcileQuery — windowed delta (M1.3 review)', () => {
  it('passes the window upToId and clamps beyond-window adds', async () => {
    await putQueryCache(db, {
      accountId: ACC,
      key: 'k',
      ids: ['i0', 'i1', 'i2'],
      queryState: 'q0',
      total: 100,
      upToId: 'i2',
      filter: null,
      sort: null,
      collapseThreads: false,
      lastUsedAt: 1,
    })
    let seenUpToId: unknown = 'MISSING'
    const port = fakePort({
      queryEmailChanges: async (spec): Promise<QueryChangesResult> => {
        seenUpToId = (spec as { upToId?: unknown }).upToId
        return {
          oldQueryState: 'q0',
          newQueryState: 'q1',
          removed: [],
          added: [{ id: 'far', index: 99 }],
        }
      },
    })

    await reconcileQuery(
      port,
      db,
      ACC,
      'k',
      { filter: null, sort: null, collapseThreads: false },
      clock,
    )

    expect(seenUpToId).toBe('i2')
    const row = await getQueryCache(db, ACC, 'k')
    expect(row?.ids).toEqual(['i0', 'i1', 'i2'])
  })
})
