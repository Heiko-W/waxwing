import type { Calendar, CalendarEvent, Mailbox } from '@waxwing/jmap'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EmailEnvelopeInput, ReplicaDb } from '../db'
import {
  calendarsForAccount,
  getCalendarQueryCache,
  getContactQueryCache,
  getQueryCache,
  getSyncState,
  putAddressBooks,
  putCalendarQueryCache,
  putContactCards,
  putContactQueryCache,
  putEmails,
  putMailboxes,
  putQueryCache,
  setSyncState,
} from '../repo'
import { addressBook, contactCard, email, freshDb, mailbox } from '../test-utils'
import {
  fullRequeryCalendar,
  reconcileCalendarQuery,
  reconcileContactQuery,
  reconcileQuery,
  syncAddressBooks,
  syncCalendarEvents,
  syncCalendars,
  syncContactCards,
  syncEmails,
  syncMailboxes,
} from './delta'
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

function emptyQuery(): QueryResult {
  return { ids: [], queryState: 'q', canCalculateChanges: true, position: 0 }
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
    getAddressBooks: async () => ({ list: [], notFound: [], state: 's' }),
    addressBookChanges: async () => emptyChanges('s'),
    setAddressBooks: async () => emptySet(),
    getContactCards: async () => ({ list: [], notFound: [], state: 's' }),
    contactCardChanges: async () => emptyChanges('s'),
    queryContactCards: async (): Promise<QueryResult> => ({
      ids: [],
      queryState: 'q',
      canCalculateChanges: true,
      position: 0,
    }),
    queryContactCardChanges: async (): Promise<QueryChangesResult> => ({
      oldQueryState: 'q',
      newQueryState: 'q',
      removed: [],
      added: [],
    }),
    setContactCards: async () => emptySet(),
    getCalendars: async () => ({ list: [], notFound: [], state: 's' }),
    calendarChanges: async () => emptyChanges('s'),
    getCalendarEvents: async () => ({ list: [], notFound: [], state: 's' }),
    calendarEventChanges: async () => emptyChanges('s'),
    queryCalendarEvents: async () => emptyQuery(),
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

// ── Contacts (M4.2, RFC 9610) — mirror of the mail delta suites above ─────────────────────────

describe('syncAddressBooks', () => {
  it('does an initial full pull and records the state when there is none', async () => {
    const port = fakePort({
      getAddressBooks: async () => ({
        list: [addressBook('book1'), addressBook('book2')],
        notFound: [],
        state: 'ab1',
      }),
    })

    await syncAddressBooks(port, db, ACC, clock)

    expect(await db.addressBooks.count()).toBe(2)
    expect(await getSyncState(db, ACC, 'AddressBook')).toBe('ab1')
  })

  it('applies a created/destroyed delta and advances the state', async () => {
    await putAddressBooks(db, ACC, [addressBook('gone')])
    await setSyncState(db, ACC, 'AddressBook', 'ab0', 1)

    const port = fakePort({
      addressBookChanges: async (): Promise<ChangesResult> => ({
        newState: 'ab1',
        hasMoreChanges: false,
        created: ['fresh'],
        updated: [],
        destroyed: ['gone'],
      }),
      getAddressBooks: async () => ({ list: [addressBook('fresh')], notFound: [], state: 'ab1' }),
    })

    await syncAddressBooks(port, db, ACC, clock)

    expect(await db.addressBooks.get([ACC, 'fresh'])).toBeDefined()
    expect(await db.addressBooks.get([ACC, 'gone'])).toBeUndefined()
    expect(await getSyncState(db, ACC, 'AddressBook')).toBe('ab1')
  })
})

describe('syncContactCards', () => {
  it('is a no-op when there is no ContactCard state (initial population is the query path)', async () => {
    let called = false
    const port = fakePort({
      contactCardChanges: async () => {
        called = true
        return emptyChanges('cc1')
      },
    })

    await syncContactCards(port, db, ACC, clock)

    expect(called).toBe(false)
    expect(await db.contactCards.count()).toBe(0)
  })

  it('applies a ContactCard/changes delta and advances the state', async () => {
    await putContactCards(db, ACC, [contactCard('c2')])
    await setSyncState(db, ACC, 'ContactCard', 'cc0', 1)

    const port = fakePort({
      contactCardChanges: async (): Promise<ChangesResult> => ({
        newState: 'cc1',
        hasMoreChanges: false,
        created: ['c1'],
        updated: [],
        destroyed: ['c2'],
      }),
      getContactCards: async () => ({ list: [contactCard('c1')], notFound: [], state: 'cc1' }),
    })

    await syncContactCards(port, db, ACC, clock)

    expect(await db.contactCards.get([ACC, 'c1'])).toBeDefined()
    expect(await db.contactCards.get([ACC, 'c2'])).toBeUndefined()
    expect(await getSyncState(db, ACC, 'ContactCard')).toBe('cc1')
  })

  it('folds created+destroyed across a hasMoreChanges page boundary', async () => {
    await setSyncState(db, ACC, 'ContactCard', 'cc0', 1)
    const pages: ChangesResult[] = [
      {
        newState: 'cc1',
        hasMoreChanges: true,
        created: ['gone', 'kept'],
        updated: [],
        destroyed: [],
      },
      { newState: 'cc2', hasMoreChanges: false, created: [], updated: [], destroyed: ['gone'] },
    ]
    let page = 0
    const requested: string[][] = []
    const port = fakePort({
      contactCardChanges: async () => pages[page++] as ChangesResult,
      getContactCards: async (ids) => {
        requested.push([...ids])
        return { list: ids.map((id) => contactCard(id)), notFound: [], state: 'cc2' }
      },
    })

    await syncContactCards(port, db, ACC, clock)

    expect(requested).toEqual([['kept']]) // the created-then-destroyed id is never even fetched
    expect(await db.contactCards.get([ACC, 'kept'])).toBeDefined()
    expect(await getSyncState(db, ACC, 'ContactCard')).toBe('cc2')
  })
})

describe('reconcileContactQuery', () => {
  const KEY = 'ck'
  const spec = { filter: null, sort: null }

  async function seedWindow(ids: string[], queryState: string) {
    await putContactQueryCache(db, {
      accountId: ACC,
      key: KEY,
      ids,
      queryState,
      total: ids.length,
      upToId: ids[ids.length - 1] ?? null,
      filter: null,
      sort: null,
      lastUsedAt: 1,
    })
  }

  it('applies removed-then-added splices and hydrates missing cards', async () => {
    await putContactCards(db, ACC, [contactCard('c1'), contactCard('c2'), contactCard('c3')])
    await seedWindow(['c1', 'c2', 'c3'], 'cq0')

    let hydrated: string[] = []
    const port = fakePort({
      queryContactCardChanges: async (): Promise<QueryChangesResult> => ({
        oldQueryState: 'cq0',
        newQueryState: 'cq1',
        removed: ['c2'],
        added: [{ id: 'c9', index: 1 }],
      }),
      getContactCards: async (ids) => {
        hydrated = ids
        return { list: ids.map((id) => contactCard(id)), notFound: [], state: 'cc1' }
      },
    })

    await reconcileContactQuery(port, db, ACC, KEY, spec, clock)

    const row = await getContactQueryCache(db, ACC, KEY)
    expect(row?.ids).toEqual(['c1', 'c9', 'c3'])
    expect(row?.queryState).toBe('cq1')
    expect(hydrated).toEqual(['c9'])
    expect(await db.contactCards.get([ACC, 'c9'])).toBeDefined()
  })

  // The correctness-critical path: Stalwart does not always raise `cannotCalculateChanges` reliably
  // (SP.4), but WHEN it does, the window must recover via a full re-query rather than strand the list.
  it('recovers via a full re-query on cannotCalculateChanges', async () => {
    await seedWindow(['c1', 'c2'], 'cq0')

    const port = fakePort({
      queryContactCardChanges: async () => {
        throw new CannotCalculateChangesError()
      },
      queryContactCards: async (): Promise<QueryResult> => ({
        ids: ['c5'],
        queryState: 'cq2',
        canCalculateChanges: true,
        position: 0,
        total: 1,
      }),
      getContactCards: async () => ({ list: [contactCard('c5')], notFound: [], state: 'cc5' }),
    })

    await reconcileContactQuery(port, db, ACC, KEY, spec, clock)

    const row = await getContactQueryCache(db, ACC, KEY)
    expect(row?.ids).toEqual(['c5'])
    expect(row?.queryState).toBe('cq2')
    expect(await db.contactCards.get([ACC, 'c5'])).toBeDefined()
  })

  it('forceFull skips queryChanges entirely and re-materializes the window', async () => {
    await seedWindow(['c1'], 'cq0')

    let deltaCalled = false
    const port = fakePort({
      queryContactCardChanges: async () => {
        deltaCalled = true
        return { oldQueryState: 'cq0', newQueryState: 'cq0', removed: [], added: [] }
      },
      queryContactCards: async (): Promise<QueryResult> => ({
        ids: ['c7'],
        queryState: 'cq3',
        canCalculateChanges: true,
        position: 0,
      }),
      getContactCards: async () => ({ list: [contactCard('c7')], notFound: [], state: 'cc7' }),
    })

    await reconcileContactQuery(port, db, ACC, KEY, spec, clock, true)

    expect(deltaCalled).toBe(false)
    expect((await getContactQueryCache(db, ACC, KEY))?.ids).toEqual(['c7'])
  })

  it('seeds the ContactCard state on a full re-query when none exists', async () => {
    const port = fakePort({
      queryContactCards: async (): Promise<QueryResult> => ({
        ids: ['c1'],
        queryState: 'cq9',
        canCalculateChanges: true,
        position: 0,
      }),
      getContactCards: async () => ({ list: [contactCard('c1')], notFound: [], state: 'ccstate' }),
    })

    await reconcileContactQuery(port, db, ACC, KEY, spec, clock)

    expect(await getSyncState(db, ACC, 'ContactCard')).toBe('ccstate')
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

// ---------------------------------------------------------------------------------------------
// Calendar (K-8)
// ---------------------------------------------------------------------------------------------

function calendar(id: string, over: Partial<Calendar> = {}): Calendar {
  return { id, name: id, isVisible: true, isSubscribed: true, ...over } as unknown as Calendar
}

function occurrence(id: string, baseEventId?: string): CalendarEvent {
  return {
    id,
    calendarIds: { c1: true },
    title: id,
    start: '2026-08-20T09:00:00',
    duration: 'PT1H',
    ...(baseEventId === undefined ? {} : { baseEventId }),
  } as unknown as CalendarEvent
}

const WINDOW_FILTER = { after: '2026-08-01T00:00:00Z', before: '2026-09-01T00:00:00Z' }

/** A materialized window, as `fullRequeryCalendar` would have left it. */
async function seedWindow(key: string, ids: string[], objectIds: string[]): Promise<void> {
  await putCalendarQueryCache(db, {
    accountId: ACC,
    key,
    ids,
    objectIds,
    filter: WINDOW_FILTER,
    stale: false,
    syncedAt: 500,
    lastUsedAt: 500,
  })
}

describe('syncCalendars', () => {
  it('pulls the whole list when there is no state, and seeds the cursor', async () => {
    const port = fakePort({
      getCalendars: async () => ({
        list: [calendar('c1'), calendar('c2')],
        notFound: [],
        state: 's1',
      }),
    })

    await syncCalendars(port, db, ACC, clock)

    expect((await calendarsForAccount(db, ACC)).map((row) => row.id)).toEqual(['c1', 'c2'])
    expect(await getSyncState(db, ACC, 'Calendar')).toBe('s1')
  })

  it('treats `cannotCalculateChanges` as "read the list again", not as a failure', async () => {
    // A brand-new account has no change history, so the server genuinely cannot diff. Surfacing
    // that as an error would greet a first-time user with a broken calendar rail.
    await setSyncState(db, ACC, 'Calendar', 'old', 1)
    let listPulls = 0
    const port = fakePort({
      calendarChanges: async () => {
        throw new CannotCalculateChangesError()
      },
      getCalendars: async () => {
        listPulls += 1
        return { list: [calendar('c1')], notFound: [], state: 's9' }
      },
    })

    await expect(syncCalendars(port, db, ACC, clock)).resolves.toBeUndefined()
    expect(listPulls).toBe(1)
    expect(await getSyncState(db, ACC, 'Calendar')).toBe('s9')
  })

  it('drops a calendar the whole-list pull no longer names', async () => {
    await setSyncState(db, ACC, 'Calendar', 'old', 1)
    await putCalendarQueryCache(db, {
      accountId: ACC,
      key: 'unused',
      ids: [],
      objectIds: [],
      filter: null,
      stale: false,
      syncedAt: 1,
      lastUsedAt: 1,
    })
    await db.calendars.put({ accountId: ACC, ...calendar('gone') } as never)
    const port = fakePort({
      calendarChanges: async () => {
        throw new CannotCalculateChangesError()
      },
      getCalendars: async () => ({ list: [calendar('c1')], notFound: [], state: 's9' }),
    })

    await syncCalendars(port, db, ACC, clock)

    expect((await calendarsForAccount(db, ACC)).map((row) => row.id)).toEqual(['c1'])
  })
})

describe('syncCalendarEvents', () => {
  it('is a no-op from a null state — the initial population is the window query', async () => {
    let called = false
    const port = fakePort({
      calendarEventChanges: async () => {
        called = true
        return emptyChanges('s')
      },
    })

    expect(await syncCalendarEvents(port, db, ACC, clock)).toBe(0)
    expect(called).toBe(false)
  })

  it('marks the windows a changed STORED event appears in, and fetches nothing', async () => {
    /*
     * The delta reports on stored objects; the grid draws expanded occurrences. There is no way to
     * turn "master e1 moved" into "these three rows in August changed" without expanding the rule,
     * so the delta marks and the window re-query reads.
     */
    await setSyncState(db, ACC, 'CalendarEvent', 'v1', 1)
    await seedWindow('august', ['occ-1'], ['e1'])
    await seedWindow('other', ['occ-9'], ['e9'])
    let gets = 0
    const port = fakePort({
      calendarEventChanges: async () => ({
        newState: 'v2',
        hasMoreChanges: false,
        created: [],
        updated: ['e1'],
        destroyed: [],
      }),
      getCalendarEvents: async () => {
        gets += 1
        return { list: [], notFound: [], state: 'v2' }
      },
    })

    expect(await syncCalendarEvents(port, db, ACC, clock)).toBe(1)
    expect(gets).toBe(0)
    expect((await getCalendarQueryCache(db, ACC, 'august'))?.stale).toBe(true)
    expect((await getCalendarQueryCache(db, ACC, 'other'))?.stale).toBe(false)
    expect(await getSyncState(db, ACC, 'CalendarEvent')).toBe('v2')
  })

  it('marks EVERY window when an event was created, because a new event is in none of them yet', async () => {
    await setSyncState(db, ACC, 'CalendarEvent', 'v1', 1)
    await seedWindow('august', ['occ-1'], ['e1'])
    await seedWindow('september', ['occ-9'], ['e9'])
    const port = fakePort({
      calendarEventChanges: async () => ({
        newState: 'v2',
        hasMoreChanges: false,
        created: ['brand-new'],
        updated: [],
        destroyed: [],
      }),
    })

    expect(await syncCalendarEvents(port, db, ACC, clock)).toBe(2)
  })

  it('deletes the expanded rows of a destroyed master — nothing else ever would', async () => {
    await setSyncState(db, ACC, 'CalendarEvent', 'v1', 1)
    await seedWindow('august', ['occ-1', 'occ-2'], ['e1'])
    await db.calendarEvents.bulkPut([
      {
        accountId: ACC,
        id: 'occ-1',
        base: 'e1',
        occurrence: true,
        event: occurrence('occ-1', 'e1'),
      },
      {
        accountId: ACC,
        id: 'occ-2',
        base: 'e1',
        occurrence: true,
        event: occurrence('occ-2', 'e1'),
      },
      { accountId: ACC, id: 'keep', base: 'e2', occurrence: true, event: occurrence('keep', 'e2') },
    ])
    const port = fakePort({
      calendarEventChanges: async () => ({
        newState: 'v2',
        hasMoreChanges: false,
        created: [],
        updated: [],
        destroyed: ['e1'],
      }),
    })

    await syncCalendarEvents(port, db, ACC, clock)

    expect((await db.calendarEvents.toArray()).map((row) => row.id)).toEqual(['keep'])
  })

  it('treats `cannotCalculateChanges` as a FULL RELOAD, not an error', async () => {
    /*
     * The measured trap (fixed in v0.16.18 for `FileNode`/`CalendarEventNotification`, but the shape
     * is the point): a server with no change history for this account refuses to diff the very state
     * a `/get` just handed out. That is the FIRST SYNC of every new account. It must mean "read it
     * all again": every window stale, the cursor dropped so the next full re-query re-seeds it.
     */
    await setSyncState(db, ACC, 'CalendarEvent', 'stale-cursor', 1)
    await seedWindow('august', ['occ-1'], ['e1'])
    await seedWindow('september', ['occ-9'], ['e9'])
    const port = fakePort({
      calendarEventChanges: async () => {
        throw new CannotCalculateChangesError()
      },
    })

    await expect(syncCalendarEvents(port, db, ACC, clock)).resolves.toBe(2)

    expect((await getCalendarQueryCache(db, ACC, 'august'))?.stale).toBe(true)
    expect((await getCalendarQueryCache(db, ACC, 'september'))?.stale).toBe(true)
    expect(await getSyncState(db, ACC, 'CalendarEvent')).toBeNull()
  })
})

describe('the calendar window', () => {
  it('stores the OCCURRENCES the grid draws AND the objects behind them, and seeds the cursor', async () => {
    const port = fakePort({
      queryCalendarEvents: async (spec) => ({
        ids: spec.expandRecurrences === true ? ['occ-1', 'occ-2'] : ['e1'],
        queryState: 'q',
        canCalculateChanges: false,
        position: 0,
      }),
      getCalendarEvents: async (ids, expanded) => ({
        list: expanded ? ids.map((id) => occurrence(id, 'e1')) : [occurrence('e1')],
        notFound: [],
        state: 'v1',
      }),
    })

    await fullRequeryCalendar(port, db, ACC, 'august', { filter: WINDOW_FILTER }, clock)

    const row = await getCalendarQueryCache(db, ACC, 'august')
    expect(row?.ids).toEqual(['occ-1', 'occ-2'])
    expect(row?.objectIds).toEqual(['e1'])
    expect(row?.stale).toBe(false)
    expect(row?.syncedAt).toBe(1000)
    // The occurrence rows carry the link back to their writable master — the whole reason the
    // identity half is stored beside them.
    expect((await db.calendarEvents.get([ACC, 'occ-2']))?.base).toBe('e1')
    expect(await getSyncState(db, ACC, 'CalendarEvent')).toBe('v1')
  })

  it('still draws the month when the identity half is refused', async () => {
    // A month that reads but cannot be edited beats no month at all — the same trade the online
    // client has made since K-2.
    const port = fakePort({
      queryCalendarEvents: async (spec) => {
        if (spec.expandRecurrences !== true) throw new Error('unsupported')
        return { ids: ['occ-1'], queryState: 'q', canCalculateChanges: false, position: 0 }
      },
      getCalendarEvents: async (ids) => ({
        list: ids.map((id) => occurrence(id, 'e1')),
        notFound: [],
        state: 'v1',
      }),
    })

    await fullRequeryCalendar(port, db, ACC, 'august', { filter: WINDOW_FILTER }, clock)

    const row = await getCalendarQueryCache(db, ACC, 'august')
    expect(row?.ids).toEqual(['occ-1'])
    expect(row?.objectIds).toEqual([])
  })

  it('does not re-query a fresh window, and does re-query a stale one', async () => {
    let queries = 0
    const port = fakePort({
      queryCalendarEvents: async () => {
        queries += 1
        return { ids: [], queryState: 'q', canCalculateChanges: false, position: 0 }
      },
    })
    await seedWindow('august', ['occ-1'], ['e1'])

    await reconcileCalendarQuery(port, db, ACC, 'august', { filter: WINDOW_FILTER }, clock)
    expect(queries).toBe(0)

    await putCalendarQueryCache(db, {
      ...(await getCalendarQueryCache(db, ACC, 'august')),
      stale: true,
    } as never)
    await reconcileCalendarQuery(port, db, ACC, 'august', { filter: WINDOW_FILTER }, clock)
    // Two queries: the expanded window and its identity companion.
    expect(queries).toBe(2)
  })
})
