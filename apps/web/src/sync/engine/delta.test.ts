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
    getIdentities: async () => ({ list: [], notFound: [], state: 's' }),
    getThreads: async () => ({ list: [], notFound: [], state: 's' }),
    getEmailEnvelopes: async (): Promise<GetResult<EmailEnvelopeInput>> => ({
      list: [],
      notFound: [],
      state: 's',
    }),
    getEmailBodies: async () => ({ list: [], notFound: [], state: 's' }),
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
    submitEmail: async () => emptySet(),
    getSearchSnippets: async () => ({ list: [], notFound: [] }),
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

  /**
   * The count fields this pass OVERWROTE, per field (M3.10, gap B7). `reapplyPendingCounts` puts an
   * unsent intent's ±1 back on top of exactly these — so reporting a field the pass did not write
   * would add the delta a SECOND time, on top of the optimistic patch already sitting in the row,
   * and a double-count does not self-correct.
   */
  it('reports which count fields it overwrote — per field, and nothing when nothing changed', async () => {
    await putMailboxes(db, ACC, [mailbox('inbox')])
    await setSyncState(db, ACC, 'Mailbox', 'm0', 1)

    const changed = (updatedProperties: string[] | undefined) =>
      fakePort({
        mailboxChanges: async () => ({
          newState: 'm1',
          hasMoreChanges: false,
          created: [],
          updated: ['inbox'],
          destroyed: [],
          ...(updatedProperties === undefined ? {} : { updatedProperties }),
        }),
        getMailboxes: async () => ({ list: [mailbox('inbox')], notFound: [], state: 'm1' }),
      })

    // A rename: the counts were NOT rewritten, so neither field may be re-applied over.
    expect(await syncMailboxes(changed(['name']), db, ACC, clock)).toEqual({
      total: [],
      unread: [],
    })
    await setSyncState(db, ACC, 'Mailbox', 'm0', 1)
    // The common "counts moved" delta.
    expect(await syncMailboxes(changed(['totalEmails', 'unreadEmails']), db, ACC, clock)).toEqual({
      total: ['inbox'],
      unread: ['inbox'],
    })
    await setSyncState(db, ACC, 'Mailbox', 'm0', 1)
    // Only one of the two — the fields must not be reported together.
    expect(await syncMailboxes(changed(['unreadEmails']), db, ACC, clock)).toEqual({
      total: [],
      unread: ['inbox'],
    })
    await setSyncState(db, ACC, 'Mailbox', 'm0', 1)
    // `updatedProperties` absent ⇒ a whole-row put ⇒ both fields rewritten.
    expect(await syncMailboxes(changed(undefined), db, ACC, clock)).toEqual({
      total: ['inbox'],
      unread: ['inbox'],
    })
    await setSyncState(db, ACC, 'Mailbox', 'm0', 1)
    // Nothing changed at all: the mailbox is not even fetched, so nothing was overwritten.
    expect(await syncMailboxes(fakePort(), db, ACC, clock)).toEqual({ total: [], unread: [] })
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

  // --- the M3.6 new-mail signal -----------------------------------------------------------------
  //
  // `Email/changes` reports `created` and `updated` separately and the engine folds them together to
  // fetch them. The notifier needs them apart: an `updated` id is a `$seen` flip from a phone, a move,
  // a label edit — any write by any client — and treating that as an arrival would buzz at the user
  // for reading their own mail somewhere else.

  it('returns ONLY the created envelopes — never the updated ones', async () => {
    await setSyncState(db, ACC, 'Email', 'e0', 1)
    const port = fakePort({
      emailChanges: async () => ({
        newState: 'e1',
        hasMoreChanges: false,
        created: ['new-1'],
        updated: ['read-elsewhere'], // e.g. another client just marked it $seen
        destroyed: [],
      }),
      getEmailEnvelopes: async () => ({
        list: [email('new-1'), email('read-elsewhere')],
        notFound: [],
        state: 'e1',
      }),
    })

    const created = await syncEmails(port, db, ACC, clock)

    expect(created.map((e) => e.id)).toEqual(['new-1'])
    // …but BOTH are still stored: the fold is right for the replica, wrong for the notifier.
    expect(await db.emails.get([ACC, 'read-elsewhere'])).toBeDefined()
  })

  it('returns nothing when there is no Email state (the initial pass is backfill, not delta)', async () => {
    expect(await syncEmails(fakePort(), db, ACC, clock)).toEqual([])
  })

  it('an id created on one page and UPDATED on a later one is still an arrival', async () => {
    await setSyncState(db, ACC, 'Email', 'e0', 1)
    const pages = [
      { newState: 'e1', hasMoreChanges: true, created: ['e1'], updated: [], destroyed: [] },
      { newState: 'e2', hasMoreChanges: false, created: [], updated: ['e1'], destroyed: [] },
    ]
    let page = 0
    const port = fakePort({
      emailChanges: async () => pages[page++] as (typeof pages)[number],
      getEmailEnvelopes: async () => ({ list: [email('e1')], notFound: [], state: 'e2' }),
    })

    expect((await syncEmails(port, db, ACC, clock)).map((e) => e.id)).toEqual(['e1'])
  })

  it('an id created and then DESTROYED across pages is neither fetched nor notified', async () => {
    // Two layers have to hold, and the test has to pin BOTH — an earlier version of it handed back an
    // empty `list` from the fake port, which made it pass no matter what the fold did.
    //
    //  1. The destroyed id is dropped from `changed`, so it is never even asked for.
    //  2. It is dropped from `created` too. `syncEmails` intersects `created` with what the `/get`
    //     actually returned, so (1) alone would usually cover it — but a server that hands back an
    //     envelope we did not ask for must not be able to turn a destroyed message into a banner.
    await setSyncState(db, ACC, 'Email', 'e0', 1)
    const pages = [
      {
        newState: 'e1',
        hasMoreChanges: true,
        created: ['gone', 'kept'],
        updated: [],
        destroyed: [],
      },
      { newState: 'e2', hasMoreChanges: false, created: [], updated: [], destroyed: ['gone'] },
    ]
    let page = 0
    const requested: string[][] = []
    const port = fakePort({
      emailChanges: async () => pages[page++] as (typeof pages)[number],
      getEmailEnvelopes: async (ids) => {
        requested.push([...ids])
        // The server answers with the destroyed id anyway. `created.delete()` is what stops it.
        return { list: [email('kept'), email('gone')], notFound: [], state: 'e2' }
      },
    })

    const created = await syncEmails(port, db, ACC, clock)

    expect(requested).toEqual([['kept']]) // layer 1: never asked for
    expect(created.map((e) => e.id)).toEqual(['kept']) // layer 2: never notified
  })

  it('does not notify for an id the server called created but did not return an envelope for', async () => {
    // A `/get` that omits an id (destroyed in the meantime, or invisible to us) leaves nothing to
    // build a banner from — the notification would have no sender, no subject and no target.
    await setSyncState(db, ACC, 'Email', 'e0', 1)
    const port = fakePort({
      emailChanges: async () => ({
        newState: 'e1',
        hasMoreChanges: false,
        created: ['ghost'],
        updated: [],
        destroyed: [],
      }),
      getEmailEnvelopes: async () => ({ list: [], notFound: ['ghost'], state: 'e1' }),
    })

    expect(await syncEmails(port, db, ACC, clock)).toEqual([])
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
