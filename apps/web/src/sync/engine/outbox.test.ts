import { type EmailCreate, type EmailFilter, JmapHttpError, JmapMethodError } from '@waxwing/jmap'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DraftRow, EmailEnvelopeInput, OutboxRow, QueryCacheRow, ReplicaDb } from '../db'
import {
  emailsInMailbox,
  emailsWithKeyword,
  failedOutbox,
  pendingOutbox,
  putEmails,
  putMailboxes,
  putQueryCache,
} from '../repo'
import { email, freshDb, mailbox } from '../test-utils'
import { STUCK_AFTER_ATTEMPTS } from './backoff'
import { reconcileQuery } from './delta'
import { enqueueAction, type OutboxIntent, reapplyPendingCounts, replayOutbox } from './outbox'
import type { EngineClock, JmapPort, PortSetResult } from './types'

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
    getAddressBooks: unused,
    addressBookChanges: unused,
    setAddressBooks: unused,
    getContactCards: unused,
    contactCardChanges: unused,
    queryContactCards: unused,
    queryContactCardChanges: unused,
    setContactCards: unused,
    getCalendars: unused,
    calendarChanges: unused,
    getCalendarEvents: unused,
    calendarEventChanges: unused,
    queryCalendarEvents: unused,
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
    expect((await row('i1'))?.undo).toEqual({
      kind: 'keywords',
      keyword: '$seen',
      had: [],
      prunedKeys: [], // no cached window in this test — nothing to prune
    })
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
      prunedKeys: [], // no cached window in this test — nothing to prune…
      insertedKeys: [], // …and nothing to place into either (M3.10, gap B2)
    })
  })
})

/**
 * M3.8 defect: the list renders `queryCache[key].ids` VERBATIM (the server-ordered window), so an
 * optimistic apply that only patched `emails.mailboxIds` left the archived message rendering in the
 * folder it had just left — and `dispatch` triggers a REPLAY-ONLY pass, so nothing local ever fixed
 * it. The row went away only when the SERVER's push echoed the change back: never while offline, and
 * not at all when the archive beat the push channel's connect (reproduced live on both counts).
 *
 * These tests look at the WINDOW. The pre-existing suite only ever looked at `emails`, which is
 * exactly why the defect shipped.
 */
describe('outbox — the cached list window (M3.8)', () => {
  /** `AND(inMailbox, after)` — a folder window's filter, exactly as `backfillMailbox` writes it. */
  const inMailboxFilter = (mailboxId: string): EmailFilter => ({
    operator: 'AND',
    conditions: [{ inMailbox: mailboxId }, { after: '2026-06-01T00:00:00Z' }],
  })

  function windowRow(
    key: string,
    filter: EmailFilter | null,
    ids: string[],
    over: Partial<QueryCacheRow> = {},
  ): QueryCacheRow {
    return {
      accountId: ACC,
      key,
      ids,
      queryState: 'q-1',
      total: ids.length,
      upToId: ids.at(-1) ?? null,
      filter,
      sort: [{ property: 'receivedAt', isAscending: false }],
      collapseThreads: true,
      lastUsedAt: 1,
      ...over,
    }
  }

  const win = (key: string): Promise<QueryCacheRow | undefined> => db.queryCache.get([ACC, key])

  /** The window keys an intent's PERSISTED undo recorded (sorted — the scan order is the index's). */
  async function prunedKeys(id: string): Promise<string[]> {
    const undo = (await row(id))?.undo
    if (!undo || !('prunedKeys' in undo)) return []
    return [...(undo.prunedKeys ?? [])].sort()
  }

  /** The window keys the apply SPLICED an id into (M3.10, gap B2) — the rollback's other half. */
  async function insertedKeys(id: string): Promise<string[]> {
    const undo = (await row(id))?.undo
    if (undo?.kind !== 'mailboxIds') return []
    return [...(undo.insertedKeys ?? [])].sort()
  }

  const inbox = (id: string, over: Partial<EmailEnvelopeInput> = {}) =>
    email(id, { mailboxIds: { inbox: true }, ...over })

  const clock: EngineClock = { now: () => 9, setTimeout: () => 0, clearTimeout: () => {} }

  it('a move prunes the ids out of the SOURCE window and decrements its total', async () => {
    await putEmails(db, ACC, [inbox('e1'), inbox('e2'), inbox('e3')])
    // `total` (42) is the SERVER's match count, not the window length — the decrement is by the
    // number of ids actually removed, never a re-count of `ids`.
    await putQueryCache(
      db,
      windowRow('inbox-win', inMailboxFilter('inbox'), ['e1', 'e2', 'e3'], {
        total: 42,
      }),
    )
    // A SECOND Inbox window (another sort) that does not actually hold the ids — they sit past its
    // loaded slice. Its `ids` are not edited, so its delta baseline is still honest: leave it alone.
    await putQueryCache(db, windowRow('inbox-old-win', inMailboxFilter('inbox'), ['e9']))

    await enqueueAction(
      db,
      ACC,
      { kind: 'move', emailIds: ['e1', 'e3'], from: 'inbox', to: 'archive' },
      { id: 'i1', now: 1 },
    )

    // No sync, no server, no push: the window the list renders is already correct.
    const window = await win('inbox-win')
    expect(window?.ids).toEqual(['e2'])
    expect(window?.total).toBe(40)
    expect(window?.upToId).toBe('e2') // the cursor invariant (`upToId === ids.at(-1)`) survives
    // We edited its `ids`, so the state the server computes its delta AGAINST is no longer the state
    // we hold: void it (see the next two tests for what keeping it costs).
    expect(window?.queryState).toBeNull()
    expect((await win('inbox-old-win'))?.queryState).toBe('q-1') // untouched ids ⇒ honest baseline
    expect((await pendingOutbox(db, ACC)).map((r) => r.id)).toEqual(['i1'])
    expect(await prunedKeys('i1')).toEqual(['inbox-win'])
  })

  /**
   * The DESTINATION half, in the case M3.10 (gap B2) did NOT change: a window whose collation we
   * cannot reproduce keeps its ids untouched and is merely marked for a full re-query. Two independent
   * reasons are exercised here because they fail at different points in the gate — a `subject` sort
   * (string collation is the server's) is refused before any envelope is read, a missing neighbour
   * envelope only after. The placements that DO happen live in the `gap B2` block below.
   */
  it('a move VOIDS a DESTINATION window whose order it cannot reproduce', async () => {
    await putEmails(db, ACC, [inbox('e1'), inbox('e2')])
    await putQueryCache(db, windowRow('inbox-win', inMailboxFilter('inbox'), ['e1', 'e2']))
    // Sorted by subject — server locale/case/collation rules, not reproducible client-side.
    await putQueryCache(
      db,
      windowRow('archive-win', inMailboxFilter('archive'), ['e2'], {
        sort: [{ property: 'subject', isAscending: true }],
      }),
    )
    // Sortable, but `e9`'s envelope is not in the replica — the "reverse gap" a window written before
    // its envelopes leaves behind (backfill.ts). We cannot compare against a row we do not hold.
    await putQueryCache(db, windowRow('archive-hole-win', inMailboxFilter('archive'), ['e9']))
    await putQueryCache(db, windowRow('later-win', inMailboxFilter('later'), ['e9']))

    await enqueueAction(
      db,
      ACC,
      { kind: 'move', emailIds: ['e1'], from: 'inbox', to: 'archive' },
      { id: 'i1', now: 1 },
    )

    // Both destinations keep their ids but lose their delta cursor, so the next reconcile re-queries
    // them in full and picks the message up in the server's order.
    expect((await win('archive-win'))?.ids).toEqual(['e2'])
    expect((await win('archive-win'))?.queryState).toBeNull()
    expect((await win('archive-hole-win'))?.ids).toEqual(['e9'])
    expect((await win('archive-hole-win'))?.queryState).toBeNull()
    // A window pinned to a THIRD mailbox is neither source nor destination: nothing about it changed,
    // so it keeps its cheap delta.
    expect((await win('later-win'))?.ids).toEqual(['e9'])
    expect((await win('later-win'))?.queryState).toBe('q-1')
    // A destination we could not place into is NOT recorded in the undo: nothing was edited there, so
    // a rollback owes it nothing — a re-query of an unedited window returns the truth regardless.
    expect(await prunedKeys('i1')).toEqual(['inbox-win'])
    expect(await insertedKeys('i1')).toEqual([])
  })

  /**
   * THE defect, at engine level: Undo — the button `use-triage` puts in every archive/junk/trash toast.
   *
   * Archive `e1` (the Inbox window drops the id), then Undo, which dispatches the INVERSE move
   * (archive → inbox). Server-side the message leaves the Inbox and comes straight back: a NET-ZERO
   * change. While the Inbox window still carried the queryState it held BEFORE the archive, the next
   * `Email/queryChanges` truthfully answered "nothing changed", that empty delta was applied to our
   * already-pruned ids, and `e1` never came back into the list — reproduced live against Stalwart
   * (15 s, push channel connected, row never returned). The Undo button was decorative.
   */
  it('Undo (the inverse move) brings the row back into the list, in the server’s order', async () => {
    await putEmails(db, ACC, [
      inbox('e1', { receivedAt: '2026-07-02T00:00:00Z' }),
      inbox('e2', { receivedAt: '2026-07-01T00:00:00Z' }),
    ])
    await putQueryCache(db, windowRow('inbox-win', inMailboxFilter('inbox'), ['e1', 'e2']))

    // `e` — archive.
    await enqueueAction(
      db,
      ACC,
      { kind: 'move', emailIds: ['e1'], from: 'inbox', to: 'archive' },
      { id: 'i1', now: 1 },
    )
    expect((await win('inbox-win'))?.ids).toEqual(['e2'])

    // "Undo" — the inverse move, exactly what the toast dispatches.
    await enqueueAction(
      db,
      ACC,
      { kind: 'move', emailIds: ['e1'], from: 'archive', to: 'inbox' },
      { id: 'i2', now: 2 },
    )

    expect((await db.emails.get([ACC, 'e1']))?.mailboxIds).toEqual({ inbox: true })
    // M3.10 (gap B2): the row is BACK IN THE LIST in the same frame, at the index its own envelope
    // says it belongs — no server, no reconnect. Before this, `ids` stayed `['e2']` and only the void
    // below could repair it, which offline never runs (`runReplay` is behind `isOnline()`), so Undo
    // looked broken for the whole offline session.
    expect((await win('inbox-win'))?.ids).toEqual(['e1', 'e2'])
    // Still voided: our index is a guess, and `queryChanges` against ids we edited is the lie the
    // M3.8 invariant forbids. The re-query below is what makes the guess converge.
    expect((await win('inbox-win'))?.queryState).toBeNull()
    expect(await insertedKeys('i2')).toEqual(['inbox-win'])

    // Now drive the reconcile the engine runs next, against a server that has the message back.
    const server = ['e1', 'e2'] // the SERVER's order: e1 is the newest again
    let deltaCalled = false
    let seenLimit: number | undefined
    const port = fakePort({
      queryEmailChanges: async () => {
        deltaCalled = true
        // What a correct server really answers for a move-out-and-back: nothing changed. Applied to
        // our pruned ids it would strand `e1` forever — so this branch must not be taken at all.
        return { oldQueryState: 'q-1', newQueryState: 'q-2', removed: [], added: [] }
      },
      queryEmails: async (spec) => {
        seenLimit = spec.limit
        const ids = server.slice(0, spec.limit ?? server.length)
        return { ids, queryState: 'q-2', canCalculateChanges: true, position: 0, total: ids.length }
      },
      getEmailEnvelopes: async (ids) => ({
        list: ids.map((id) => inbox(id)),
        notFound: [],
        state: 'eml-1',
      }),
    })

    await reconcileQuery(port, db, ACC, 'inbox-win', { filter: inMailboxFilter('inbox') }, clock)

    expect(deltaCalled).toBe(false) // the net-zero delta was never consulted
    expect((await win('inbox-win'))?.ids).toEqual(['e1', 'e2']) // BACK — and in the server's order
    expect((await win('inbox-win'))?.queryState).toBe('q-2')
    // The re-query must not re-materialize the window at the length the PRUNE left it (1), or the
    // restored row would return at the top while `e2` silently dropped off the bottom (delta.ts).
    expect(seenLimit).not.toBe(1)
  })

  it('touches no window it cannot prove the message left (other folder, search, label, OR)', async () => {
    await putEmails(db, ACC, [inbox('e1')])
    await putQueryCache(db, windowRow('inbox-win', inMailboxFilter('inbox'), ['e1']))
    await putQueryCache(db, windowRow('archive-win', inMailboxFilter('archive'), ['e1']))
    await putQueryCache(db, windowRow('search-win', { text: 'invoice' }, ['e1']))
    await putQueryCache(db, windowRow('label-win', { hasKeyword: 'work' }, ['e1']))
    await putQueryCache(db, windowRow('nofilter-win', null, ['e1']))
    await putQueryCache(
      db,
      windowRow(
        'or-win',
        { operator: 'OR', conditions: [{ inMailbox: 'inbox' }, { hasKeyword: 'work' }] },
        ['e1'],
      ),
    )

    await enqueueAction(
      db,
      ACC,
      { kind: 'move', emailIds: ['e1'], from: 'inbox', to: 'archive' },
      { id: 'i1', now: 1 },
    )

    expect((await win('inbox-win'))?.ids).toEqual([]) // the source folder — pruned
    // The destination window already LISTS `e1` (it was in `archive` too): there is nothing to pick
    // up, so it is left with its cheap delta rather than being sent on a pointless full re-query.
    expect((await win('archive-win'))?.ids).toEqual(['e1'])
    expect((await win('archive-win'))?.queryState).toBe('q-1')
    expect((await win('search-win'))?.ids).toEqual(['e1']) // a search is a SNAPSHOT — it keeps the hit
    expect((await win('label-win'))?.ids).toEqual(['e1']) // so is a label view (FR-LST / M3.2)
    expect((await win('nofilter-win'))?.ids).toEqual(['e1'])
    expect((await win('or-win'))?.ids).toEqual(['e1']) // an OR can still match on its other branch
    // None of them was edited, so none of them lost its baseline either.
    for (const key of ['search-win', 'label-win', 'nofilter-win', 'or-win']) {
      expect((await win(key))?.queryState).toBe('q-1')
    }
    expect(await prunedKeys('i1')).toEqual(['inbox-win'])
  })

  it('a move with from === null (the source folder is unknown) prunes nothing', async () => {
    await putEmails(db, ACC, [inbox('e1')])
    await putQueryCache(db, windowRow('inbox-win', inMailboxFilter('inbox'), ['e1']))

    await enqueueAction(
      db,
      ACC,
      { kind: 'move', emailIds: ['e1'], from: null, to: 'archive' },
      { id: 'i1', now: 1 },
    )

    // It is a COPY into `archive`, not a move out of `inbox` — so the message is still in the Inbox
    // and the Inbox window is still right. (This is also why the M3.8 shortcuts refuse to fire here.)
    expect((await db.emails.get([ACC, 'e1']))?.mailboxIds).toEqual({ inbox: true, archive: true })
    expect((await win('inbox-win'))?.ids).toEqual(['e1'])
    expect(await prunedKeys('i1')).toEqual([])
  })

  /**
   * A destroy has no destination, and its prune is unconditional. Voiding the baseline of the windows
   * it edited is DEFENSIVE here rather than load-bearing — a destroy is irreversible, the id can never
   * re-enter a query result, so the server's delta can only ever agree with the prune ("removed: e1",
   * which we already applied). It is kept because the exception would have to be re-proved every time
   * this code is touched, and because a permanent delete is rare: the re-query costs nothing real.
   */
  it('a destroy prunes the ids out of EVERY window — a destroyed message belongs in none', async () => {
    await putEmails(db, ACC, [inbox('e1'), inbox('e2')])
    await putQueryCache(db, windowRow('inbox-win', inMailboxFilter('inbox'), ['e1', 'e2']))
    await putQueryCache(db, windowRow('archive-win', inMailboxFilter('archive'), ['e1']))
    await putQueryCache(db, windowRow('search-win', { text: 'invoice' }, ['e1'], { total: 9 }))
    await putQueryCache(db, windowRow('later-win', inMailboxFilter('later'), ['e9']))

    await enqueueAction(db, ACC, { kind: 'destroyEmails', emailIds: ['e1'] }, { id: 'i1', now: 1 })

    expect((await win('inbox-win'))?.ids).toEqual(['e2'])
    expect((await win('archive-win'))?.ids).toEqual([])
    expect((await win('search-win'))?.ids).toEqual([]) // even a search: its envelope is GONE
    expect((await win('search-win'))?.total).toBe(8)
    // Every window whose ids we edited loses its baseline — the same rule as a move's source.
    for (const key of ['inbox-win', 'archive-win', 'search-win']) {
      expect((await win(key))?.queryState).toBeNull()
    }
    // …and the one that held none of the destroyed ids keeps its cheap delta.
    expect((await win('later-win'))?.ids).toEqual(['e9'])
    expect((await win('later-win'))?.queryState).toBe('q-1')
    expect(await prunedKeys('i1')).toEqual(['archive-win', 'inbox-win', 'search-win'])
  })

  it('never touches a window belonging to a DIFFERENT account', async () => {
    const OTHER = 'other-acc'
    await putEmails(db, ACC, [inbox('e1')])
    await putEmails(db, OTHER, [inbox('e1')])
    // Same canonical key on both accounts — `canonicalQueryKey` deliberately excludes the accountId
    // (scoping is the compound primary key), so a prune that forgot to scope would hit both.
    await putQueryCache(db, windowRow('inbox-win', inMailboxFilter('inbox'), ['e1']))
    await putQueryCache(db, {
      ...windowRow('inbox-win', inMailboxFilter('inbox'), ['e1']),
      accountId: OTHER,
    })

    await enqueueAction(
      db,
      ACC,
      { kind: 'move', emailIds: ['e1'], from: 'inbox', to: 'archive' },
      { id: 'i1', now: 1 },
    )
    await enqueueAction(db, ACC, { kind: 'destroyEmails', emailIds: ['e1'] }, { id: 'i2', now: 2 })

    expect((await db.queryCache.get([ACC, 'inbox-win']))?.ids).toEqual([])
    expect((await db.queryCache.get([OTHER, 'inbox-win']))?.ids).toEqual(['e1'])
    expect(await db.emails.get([OTHER, 'e1'])).toBeDefined()
  })

  it('the rollback of a REJECTED move marks the pruned window for a full re-query', async () => {
    await putEmails(db, ACC, [inbox('e1')])
    await putQueryCache(db, windowRow('inbox-win', inMailboxFilter('inbox'), ['e1'], { total: 5 }))
    await enqueueAction(
      db,
      ACC,
      { kind: 'move', emailIds: ['e1'], from: 'inbox', to: 'archive' },
      { id: 'i1', now: 1 },
    )
    expect((await win('inbox-win'))?.ids).toEqual([])

    const port = fakePort({
      setEmails: async () => setResult({ notUpdated: { e1: { type: 'forbidden' } } }),
    })
    await replayOutbox(port, db, ACC, { random: NO_JITTER })

    expect((await row('i1'))?.status).toBe('error')
    expect((await db.emails.get([ACC, 'e1']))?.mailboxIds).toEqual({ inbox: true }) // envelope restored
    // The window is NOT repaired by re-inserting the id at a guessed index — we hold none of the
    // server's sort keys. It is marked for a full re-query instead (a rollback means the server
    // ANSWERED, so we are online and the round-trip is free).
    expect((await win('inbox-win'))?.queryState).toBeNull()

    // And that null really is what `reconcileQuery` branches on: the row comes back, in the server's
    // order. (Asserting only on `queryState === null` would leave the delta.ts contract untested.)
    const requeryPort = fakePort({
      queryEmails: async () => ({
        ids: ['e1'],
        queryState: 'q-2',
        canCalculateChanges: true,
        position: 0,
        total: 5,
      }),
      getEmailEnvelopes: async (ids) => ({
        list: ids.map((id) => email(id)),
        notFound: [],
        state: 'eml-1',
      }),
    })
    await reconcileQuery(
      requeryPort,
      db,
      ACC,
      'inbox-win',
      { filter: inMailboxFilter('inbox') },
      clock,
    )
    expect((await win('inbox-win'))?.ids).toEqual(['e1'])
    expect((await win('inbox-win'))?.queryState).toBe('q-2')
  })

  /**
   * M3.10 (gap B1): the SAME defect, reached through `setKeywords` instead of `move`. Its optimistic
   * apply never touched `queryCache` at all, so a keyword-filtered window kept rendering a message
   * whose keywords had just changed — mark a message read in `?q=is:unread` and the row stayed; strip
   * a label and it stayed in that `?label=` view — until the server's push echoed (online) or the app
   * reconnected (offline).
   *
   * The polarity is the whole fix and the thing a reviewer misreads: `left` must prove NON-membership,
   * so it asks for the OPPOSITE of the value being written.
   */
  describe('a keyword change (M3.10, gap B1)', () => {
    const unreadFilter: EmailFilter = { notKeyword: '$seen' } // `?q=is:unread`
    const readFilter: EmailFilter = { hasKeyword: '$seen' } // `?q=is:read`
    /** `?label=work` — a BARE condition, exactly as `useLabelView` writes it. */
    const labelFilter = (keyword: string): EmailFilter => ({ hasKeyword: keyword })

    it('marking read PRUNES the is:unread window — same frame, no server', async () => {
      await putEmails(db, ACC, [inbox('e1'), inbox('e2')])
      // `total` (42) is the SERVER's match count, not the window length.
      await putQueryCache(db, windowRow('unread-win', unreadFilter, ['e1', 'e2'], { total: 42 }))

      await enqueueAction(
        db,
        ACC,
        { kind: 'setKeywords', emailIds: ['e1'], keyword: '$seen', value: true },
        { id: 'i1', now: 1 },
      )

      const window = await win('unread-win')
      expect(window?.ids).toEqual(['e2'])
      expect(window?.total).toBe(41)
      expect(window?.upToId).toBe('e2') // the cursor invariant survives, as for a move
      expect(window?.queryState).toBeNull() // we edited its ids ⇒ its delta baseline is a lie
      expect(await prunedKeys('i1')).toEqual(['unread-win'])
    })

    it('marking read VOIDS the is:read window without touching its ids', async () => {
      await putEmails(db, ACC, [inbox('e1')])
      await putQueryCache(db, windowRow('read-win', readFilter, ['e9']))

      await enqueueAction(
        db,
        ACC,
        { kind: 'setKeywords', emailIds: ['e1'], keyword: '$seen', value: true },
        { id: 'i1', now: 1 },
      )

      // Being read is necessary, not sufficient, and the position is the server's to compute — so the
      // window keeps its ids and is simply marked for a full re-query.
      expect((await win('read-win'))?.ids).toEqual(['e9'])
      expect((await win('read-win'))?.queryState).toBeNull()
      // Nothing was EDITED there, so a rollback owes it nothing.
      expect(await prunedKeys('i1')).toEqual([])
    })

    it('removing a label prunes the ?label= view; adding one voids it', async () => {
      await putEmails(db, ACC, [email('e1', { keywords: { work: true } })])
      await putQueryCache(db, windowRow('work-win', labelFilter('work'), ['e1'], { total: 7 }))

      await enqueueAction(
        db,
        ACC,
        { kind: 'setKeywords', emailIds: ['e1'], keyword: 'work', value: false },
        { id: 'i1', now: 1 },
      )
      expect((await win('work-win'))?.ids).toEqual([])
      expect((await win('work-win'))?.total).toBe(6)
      expect(await prunedKeys('i1')).toEqual(['work-win'])

      // …and the other direction, on a second label view the message is not in yet.
      await putQueryCache(db, windowRow('todo-win', labelFilter('todo'), ['e9']))
      await enqueueAction(
        db,
        ACC,
        { kind: 'setKeywords', emailIds: ['e1'], keyword: 'todo', value: true },
        { id: 'i2', now: 2 },
      )
      expect((await win('todo-win'))?.ids).toEqual(['e9']) // only the server can place it
      expect((await win('todo-win'))?.queryState).toBeNull()
      expect(await prunedKeys('i2')).toEqual([])
    })

    /**
     * The highest-cardinality `setKeywords` path in the app: deleting a label with `alsoStrip` fans
     * `setKeywords(value:false)` over every replica-known carrier, 500 ids per intent (`useLabels`'
     * `STRIP_CHUNK`). What must not grow with the id count is the PERSISTED undo: `prunedKeys` is keyed
     * by WINDOW, so one chunk that empties a window records one string — and a follow-up chunk whose
     * ids the window never held records none at all (`removed === 0`).
     */
    it('a bulk strip records one key per WINDOW, not per id — and nothing for a chunk that misses', async () => {
      const ids = ['e1', 'e2', 'e3', 'e4']
      await putEmails(
        db,
        ACC,
        ids.map((id) => email(id, { keywords: { work: true } })),
      )
      await putQueryCache(
        db,
        windowRow('work-win', labelFilter('work'), ['e1', 'e2'], { total: 42 }),
      )

      // Chunk 1 — the ids the loaded window actually holds, plus one it does not.
      await enqueueAction(
        db,
        ACC,
        { kind: 'setKeywords', emailIds: ['e1', 'e2', 'e3'], keyword: 'work', value: false },
        { id: 'i1', now: 1 },
      )
      expect((await win('work-win'))?.ids).toEqual([])
      expect((await win('work-win'))?.total).toBe(40) // by the number REALLY removed, never the chunk size
      expect((await win('work-win'))?.upToId).toBeNull()
      expect(await prunedKeys('i1')).toEqual(['work-win'])

      // Chunk 2 — carriers that sit past the loaded window. Its baseline is still honest.
      await db.queryCache.update([ACC, 'work-win'], { queryState: 'q-2' })
      await enqueueAction(
        db,
        ACC,
        { kind: 'setKeywords', emailIds: ['e4'], keyword: 'work', value: false },
        { id: 'i2', now: 2 },
      )
      expect((await win('work-win'))?.total).toBe(40)
      expect((await win('work-win'))?.queryState).toBe('q-2')
      expect(await prunedKeys('i2')).toEqual([])
    })

    it('reads the keyword condition nested under an AND (a folder-scoped is:unread)', async () => {
      await putEmails(db, ACC, [inbox('e1')])
      // What `tokensToFilter` produces for `?q=in:inbox is:unread`.
      await putQueryCache(
        db,
        windowRow(
          'inbox-unread-win',
          { operator: 'AND', conditions: [{ inMailbox: 'inbox' }, { notKeyword: '$seen' }] },
          ['e1'],
        ),
      )

      await enqueueAction(
        db,
        ACC,
        { kind: 'setKeywords', emailIds: ['e1'], keyword: '$seen', value: true },
        { id: 'i1', now: 1 },
      )

      expect((await win('inbox-unread-win'))?.ids).toEqual([])
      expect(await prunedKeys('i1')).toEqual(['inbox-unread-win'])
    })

    /**
     * The predicate is an ALLOW-LIST: only `hasKeyword`/`notKeyword` under `AND`. Everything else —
     * `OR`, `NOT`, another keyword, a text search, a folder window, no filter at all — answers "I do
     * not know", which means leave it completely alone.
     *
     * The thread-level conditions are the trap: `someInThreadHaveKeyword` is one autocomplete away
     * from being added to the predicate, and it is a property of the THREAD — marking ONE message
     * read neither proves nor disproves it, so pruning on it would remove rows that still belong.
     */
    it('trusts neither OR/NOT, another keyword, nor the THREAD-level keyword conditions', async () => {
      await putEmails(db, ACC, [inbox('e1')])
      await putQueryCache(db, windowRow('unread-win', unreadFilter, ['e1']))
      await putQueryCache(
        db,
        windowRow('or-win', { operator: 'OR', conditions: [{ notKeyword: '$seen' }] }, ['e1']),
      )
      await putQueryCache(
        db,
        windowRow('not-win', { operator: 'NOT', conditions: [{ notKeyword: '$seen' }] }, ['e1']),
      )
      await putQueryCache(
        db,
        windowRow('thread-all-win', { allInThreadHaveKeyword: '$seen' }, ['e1']),
      )
      await putQueryCache(
        db,
        windowRow('thread-some-win', { someInThreadHaveKeyword: '$seen' }, ['e1']),
      )
      await putQueryCache(
        db,
        windowRow('thread-none-win', { noneInThreadHaveKeyword: '$seen' }, ['e1']),
      )
      await putQueryCache(db, windowRow('other-kw-win', { notKeyword: '$flagged' }, ['e1']))
      await putQueryCache(db, windowRow('search-win', { text: 'invoice' }, ['e1']))
      await putQueryCache(db, windowRow('inbox-win', inMailboxFilter('inbox'), ['e1']))
      await putQueryCache(db, windowRow('nofilter-win', null, ['e1']))

      await enqueueAction(
        db,
        ACC,
        { kind: 'setKeywords', emailIds: ['e1'], keyword: '$seen', value: true },
        { id: 'i1', now: 1 },
      )

      expect((await win('unread-win'))?.ids).toEqual([]) // the one window we can prove
      for (const key of [
        'or-win',
        'not-win',
        'thread-all-win',
        'thread-some-win',
        'thread-none-win',
        'other-kw-win',
        'search-win',
        'inbox-win',
        'nofilter-win',
      ]) {
        expect((await win(key))?.ids, key).toEqual(['e1'])
        expect((await win(key))?.queryState, key).toBe('q-1') // not even a superfluous re-query
      }
      expect(await prunedKeys('i1')).toEqual(['unread-win'])
    })

    /**
     * The SAME allow-list, proven on the other half of `updateWindows`' membership split.
     *
     * The test above can only prove the PRUNE (`left`) direction: every window it sets up already
     * lists the id, so the split routes each of them to `resorted` and `entered` is never asked. That
     * left the arrival direction's refusals — the `hasKeyword` branch of the predicate, and the very
     * thread-level conditions the comment above calls "one autocomplete away" — covered by nothing.
     * These windows deliberately hold a DIFFERENT id so the `entered` question is the one being asked.
     */
    it('refuses the same shapes when asking whether the message ARRIVED (the entered half)', async () => {
      await putEmails(db, ACC, [inbox('e1')])
      // The one shape we do act on, as the positive control: a bare `hasKeyword` is a void.
      await putQueryCache(db, windowRow('read-win', readFilter, ['e9']))
      await putQueryCache(
        db,
        windowRow('or-read-win', { operator: 'OR', conditions: [{ hasKeyword: '$seen' }] }, ['e9']),
      )
      await putQueryCache(
        db,
        windowRow('not-read-win', { operator: 'NOT', conditions: [{ hasKeyword: '$seen' }] }, [
          'e9',
        ]),
      )
      await putQueryCache(db, windowRow('t-all-win', { allInThreadHaveKeyword: '$seen' }, ['e9']))
      await putQueryCache(db, windowRow('t-some-win', { someInThreadHaveKeyword: '$seen' }, ['e9']))
      await putQueryCache(db, windowRow('t-none-win', { noneInThreadHaveKeyword: '$seen' }, ['e9']))
      await putQueryCache(db, windowRow('other-read-win', { hasKeyword: '$flagged' }, ['e9']))

      await enqueueAction(
        db,
        ACC,
        { kind: 'setKeywords', emailIds: ['e1'], keyword: '$seen', value: true },
        { id: 'i1', now: 1 },
      )

      expect((await win('read-win'))?.queryState).toBeNull() // provable maybe-arrival ⇒ void
      for (const key of [
        'or-read-win',
        'not-read-win',
        't-all-win',
        't-some-win',
        't-none-win',
        'other-read-win',
      ]) {
        expect((await win(key))?.ids, key).toEqual(['e9'])
        expect((await win(key))?.queryState, key).toBe('q-1')
      }
      expect(await prunedKeys('i1')).toEqual([]) // a void is never a prune
    })

    it('leaves an unread window that does not HOLD the id — and its key out of the undo', async () => {
      await putEmails(db, ACC, [inbox('e1')])
      // A second unread window (another sort) whose loaded slice stops before `e1`: its ids do not
      // change, so its delta baseline is still honest.
      await putQueryCache(db, windowRow('unread-win', unreadFilter, ['e1']))
      await putQueryCache(db, windowRow('unread-old-win', unreadFilter, ['e9'], { total: 3 }))

      await enqueueAction(
        db,
        ACC,
        { kind: 'setKeywords', emailIds: ['e1'], keyword: '$seen', value: true },
        { id: 'i1', now: 1 },
      )

      expect((await win('unread-old-win'))?.ids).toEqual(['e9'])
      expect((await win('unread-old-win'))?.total).toBe(3) // never a speculative decrement
      expect((await win('unread-old-win'))?.queryState).toBe('q-1')
      expect(await prunedKeys('i1')).toEqual(['unread-win'])
    })

    /**
     * The case the FILTER predicate cannot see: with the shipped "Unread first" toggle the window
     * SORTS on `hasKeyword $seen`, so marking a message read leaves its MEMBERSHIP untouched and its
     * POSITION wrong — the just-read row stayed pinned to the top of the list until the server echoed.
     *
     * It needs its own effect: `entered` deliberately skips a window that already lists the id, which
     * is by definition every window this case is about.
     */
    it('voids a window that SORTS on the keyword ("Unread first"), ids untouched', async () => {
      await putEmails(db, ACC, [inbox('e1'), inbox('e2')])
      await putQueryCache(
        db,
        windowRow('unread-first-win', inMailboxFilter('inbox'), ['e1', 'e2'], {
          sort: [
            { property: 'hasKeyword', keyword: '$seen', isAscending: true },
            { property: 'receivedAt', isAscending: false },
          ],
        }),
      )
      // A comparator carrying `keyword` on a property that does not take one is structurally legal and
      // means nothing — it must not buy a full re-query of the whole window.
      await putQueryCache(
        db,
        windowRow('nonsense-sort-win', inMailboxFilter('inbox'), ['e1'], {
          sort: [{ property: 'receivedAt', keyword: '$seen', isAscending: false }],
        }),
      )
      // …and a keyword sort for a DIFFERENT keyword is equally uninterested.
      await putQueryCache(
        db,
        windowRow('flagged-sort-win', inMailboxFilter('inbox'), ['e1'], {
          sort: [{ property: 'hasKeyword', keyword: '$flagged', isAscending: true }],
        }),
      )

      await enqueueAction(
        db,
        ACC,
        { kind: 'setKeywords', emailIds: ['e1'], keyword: '$seen', value: true },
        { id: 'i1', now: 1 },
      )

      // Nothing is re-ordered locally — the collation is the server's — so the window is re-queried.
      expect((await win('unread-first-win'))?.ids).toEqual(['e1', 'e2'])
      expect((await win('unread-first-win'))?.total).toBe(2)
      expect((await win('unread-first-win'))?.queryState).toBeNull()
      expect((await win('nonsense-sort-win'))?.queryState).toBe('q-1')
      expect((await win('flagged-sort-win'))?.queryState).toBe('q-1')
      expect(await prunedKeys('i1')).toEqual([]) // a void is not a prune: nothing to roll back
    })

    /**
     * ARRIVAL BY SORT — the case the membership gate concealed, and the reason `resorted` is now asked
     * of every window instead of only the ones that already hold the id.
     *
     * The old justification ("a window that does not hold the message cannot be rendering it in the
     * wrong place") is true about RENDERING and silently omits ARRIVAL: a folder window carries a
     * keyword SORT, not a keyword FILTER, so `entered` is false too — and nothing voided. The row then
     * showed up only at the next full reconcile: online when the server's push echoed, offline not
     * until reconnect.
     */
    it('voids an "Unread first" window that does NOT hold the id — it can arrive by SORT', async () => {
      // `e1` is read and sits past this window's loaded slice; the user marks it unread from somewhere
      // else entirely — a search result, a label view.
      await putEmails(db, ACC, [inbox('e1', { keywords: { $seen: true } }), inbox('e9')])
      await putQueryCache(
        db,
        windowRow('unread-first-win', inMailboxFilter('inbox'), ['e9'], {
          total: 40,
          sort: [
            { property: 'hasKeyword', keyword: '$seen', isAscending: true },
            { property: 'receivedAt', isAscending: false },
          ],
        }),
      )
      // The positive control, and the reason the cost of this is opt-in: the SAME folder window with
      // the default sort. Its order does not depend on `$seen`, `e1` cannot reach it by sort, and its
      // baseline is still honest — with "Unread first" OFF nothing here is voided at all.
      await putQueryCache(
        db,
        windowRow('inbox-recent-win', inMailboxFilter('inbox'), ['e9'], { total: 40 }),
      )

      await enqueueAction(
        db,
        ACC,
        { kind: 'setKeywords', emailIds: ['e1'], keyword: '$seen', value: false },
        { id: 'i1', now: 1 },
      )

      // `e1` now sorts to the TOP of the "Unread first" window and must become visible there. Nothing
      // places it locally (a keyword change carries no `arrivals` — see `applyOptimistic`), so the void
      // is the whole answer: the re-query is what puts the row on screen.
      expect((await win('unread-first-win'))?.queryState).toBeNull()
      expect((await win('unread-first-win'))?.ids).toEqual(['e9']) // ids untouched — the server places it
      expect((await win('unread-first-win'))?.total).toBe(40) // never a speculative increment
      expect((await win('inbox-recent-win'))?.queryState).toBe('q-1')
      expect((await win('inbox-recent-win'))?.ids).toEqual(['e9'])
      expect(await prunedKeys('i1')).toEqual([]) // a void is not a prune: nothing to roll back
    })

    it('never touches a keyword window belonging to a DIFFERENT account', async () => {
      const OTHER = 'other-acc'
      await putEmails(db, ACC, [inbox('e1')])
      await putEmails(db, OTHER, [inbox('e1')])
      // Same canonical key on both accounts — the scoping is the compound primary key alone.
      await putQueryCache(db, windowRow('unread-win', unreadFilter, ['e1']))
      await putQueryCache(db, {
        ...windowRow('unread-win', unreadFilter, ['e1']),
        accountId: OTHER,
      })

      await enqueueAction(
        db,
        ACC,
        { kind: 'setKeywords', emailIds: ['e1'], keyword: '$seen', value: true },
        { id: 'i1', now: 1 },
      )

      expect((await db.queryCache.get([ACC, 'unread-win']))?.ids).toEqual([])
      expect((await db.queryCache.get([OTHER, 'unread-win']))?.ids).toEqual(['e1'])
      expect((await db.queryCache.get([OTHER, 'unread-win']))?.queryState).toBe('q-1')
      expect((await db.emails.get([OTHER, 'e1']))?.keywords).toEqual({})
    })

    it('the rollback of a REJECTED mark-read marks the pruned window for a full re-query', async () => {
      await putEmails(db, ACC, [inbox('e1')])
      await putQueryCache(db, windowRow('unread-win', unreadFilter, ['e1'], { total: 5 }))
      await enqueueAction(
        db,
        ACC,
        { kind: 'setKeywords', emailIds: ['e1'], keyword: '$seen', value: true },
        { id: 'i1', now: 1 },
      )
      expect((await win('unread-win'))?.ids).toEqual([])
      // A reconcile that ran in between restored the baseline — against a window holding the ids we
      // are about to un-prune. This is why the rollback re-voids rather than trusting the apply's void.
      await db.queryCache.update([ACC, 'unread-win'], { queryState: 'q-2' })

      const port = fakePort({
        setEmails: async () => setResult({ notUpdated: { e1: { type: 'forbidden' } } }),
      })
      await replayOutbox(port, db, ACC, { random: NO_JITTER })

      expect((await row('i1'))?.status).toBe('error')
      expect((await db.emails.get([ACC, 'e1']))?.keywords).toEqual({}) // envelope restored
      // The id is NOT spliced back at a guessed index — the window is re-queried instead.
      expect((await win('unread-win'))?.queryState).toBeNull()

      const requeryPort = fakePort({
        queryEmails: async () => ({
          ids: ['e1'],
          queryState: 'q-3',
          canCalculateChanges: true,
          position: 0,
          total: 5,
        }),
        getEmailEnvelopes: async (ids) => ({
          list: ids.map((id) => email(id)),
          notFound: [],
          state: 'eml-1',
        }),
      })
      await reconcileQuery(requeryPort, db, ACC, 'unread-win', { filter: unreadFilter }, clock)
      expect((await win('unread-win'))?.ids).toEqual(['e1'])
      expect((await win('unread-win'))?.queryState).toBe('q-3')
    })
  })

  /**
   * M3.10 (gap B2): the ARRIVAL half. A departure was pruned locally, but an arrival only voided the
   * baseline and waited for a re-query — and offline there is nothing to re-query (`runReplay` puts
   * the whole replay + `reconcileWatched` block behind `isOnline()`). So undoing an archive offline
   * put the message back in the replica and NOT back in the list until reconnect: the Undo button
   * worked and looked broken.
   *
   * These cases are all about the GATE. The insert is only allowed where the placement is locally
   * computable, and every refusal below is the pre-M3.10 behaviour reached deliberately, not by
   * accident. `total` is set explicitly in most of them because completeness — `ids.length >= total` —
   * decides whether a tail insert is legal at all.
   */
  describe('an arrival placed locally (M3.10, gap B2)', () => {
    /** `receivedAt desc`, the default folder sort. Older id ⇒ older message. */
    const at = (day: number) => `2026-07-${String(day).padStart(2, '0')}T00:00:00Z`

    /** Three archived messages, newest first, already listed by a COMPLETE archive window. */
    async function seedArchive(over: Partial<QueryCacheRow> = {}): Promise<void> {
      await putEmails(db, ACC, [
        email('a1', { mailboxIds: { archive: true }, receivedAt: at(9) }),
        email('a2', { mailboxIds: { archive: true }, receivedAt: at(5) }),
        email('a3', { mailboxIds: { archive: true }, receivedAt: at(1) }),
      ])
      await putQueryCache(
        db,
        windowRow('archive-win', inMailboxFilter('archive'), ['a1', 'a2', 'a3'], {
          total: 3,
          ...over,
        }),
      )
    }

    const archiveTo = (id: string) =>
      enqueueAction(
        db,
        ACC,
        { kind: 'move', emailIds: [id], from: 'inbox', to: 'archive' },
        { id: 'i1', now: 1 },
      )

    it('splices the arrival at the index its own envelope proves — mid-window', async () => {
      await seedArchive()
      await putEmails(db, ACC, [inbox('e1', { receivedAt: at(7) })]) // between a1 and a2

      await archiveTo('e1')

      expect((await win('archive-win'))?.ids).toEqual(['a1', 'e1', 'a2', 'a3'])
      expect((await win('archive-win'))?.total).toBe(4)
      expect((await win('archive-win'))?.upToId).toBe('a3') // the invariant: `upToId === ids.at(-1)`
      // Still voided — the index is OUR guess, so the baseline is no longer one `queryChanges` may
      // be computed against (the M3.8 invariant, which the insert does not get to opt out of).
      expect((await win('archive-win'))?.queryState).toBeNull()
      expect(await insertedKeys('i1')).toEqual(['archive-win'])
    })

    it('places at index 0 (the newest) without disturbing upToId', async () => {
      await seedArchive()
      await putEmails(db, ACC, [inbox('e1', { receivedAt: at(20) })])

      await archiveTo('e1')

      expect((await win('archive-win'))?.ids).toEqual(['e1', 'a1', 'a2', 'a3'])
      expect((await win('archive-win'))?.upToId).toBe('a3')
    })

    it('appends past the last row only when the window holds EVERYTHING', async () => {
      await seedArchive() // total 3, ids 3 ⇒ complete
      await putEmails(db, ACC, [inbox('e1', { receivedAt: at(1) })]) // ties with a3 ⇒ sorts after it

      await archiveTo('e1')

      expect((await win('archive-win'))?.ids).toEqual(['a1', 'a2', 'a3', 'e1'])
      expect((await win('archive-win'))?.total).toBe(4)
      expect((await win('archive-win'))?.upToId).toBe('e1') // the tail moved WITH the insert
    })

    it('refuses to append past the last row of an INCOMPLETE window', async () => {
      // The window holds 3 of 40 matches. A message older than every loaded row belongs to a page the
      // user has not scrolled to; showing it after `a3` would put it above messages that sort ahead.
      await seedArchive({ total: 40 })
      await putEmails(db, ACC, [inbox('e1', { receivedAt: at(1) })])

      await archiveTo('e1')

      expect((await win('archive-win'))?.ids).toEqual(['a1', 'a2', 'a3'])
      expect((await win('archive-win'))?.total).toBe(40) // untouched — nothing was placed
      expect((await win('archive-win'))?.queryState).toBeNull() // …but still marked for the re-query
      expect(await insertedKeys('i1')).toEqual([])
    })

    it('keeps an INCOMPLETE window exactly as long as it was, by dropping its tail', async () => {
      // A cached window is the head page `position: 0`; `loadMore` pages by `position: ids.length`.
      // Growing it would ratchet `reconcileQuery`'s windowLimit up by one PERMANENTLY per arrival
      // (delta.ts) and re-arm MessageList's load-more guard. The dropped id is one page away and comes
      // back at that same position — which is exactly what the server did to it.
      await seedArchive({ total: 40 })
      await putEmails(db, ACC, [inbox('e1', { receivedAt: at(7) })])

      await archiveTo('e1')

      expect((await win('archive-win'))?.ids).toEqual(['a1', 'e1', 'a2'])
      expect((await win('archive-win'))?.upToId).toBe('a2')
      // `a3` did not LEAVE the query — it is one page down. Only the arrival moves the count.
      expect((await win('archive-win'))?.total).toBe(41)
    })

    it('refuses an arrival the window’s own `after` boundary excludes', async () => {
      // A folder window is `AND(inMailbox, after: <cacheDays midnight>)` (backfill.ts). Pinning the
      // mailbox is NECESSARY, not sufficient: a message older than the horizon does not belong in the
      // window at all, and "it sorts after every loaded row" would have placed it there anyway.
      await seedArchive()
      await putEmails(db, ACC, [inbox('e1', { receivedAt: '2026-05-01T00:00:00Z' })])

      await archiveTo('e1')

      expect((await win('archive-win'))?.ids).toEqual(['a1', 'a2', 'a3'])
      expect((await win('archive-win'))?.queryState).toBeNull()
      expect(await insertedKeys('i1')).toEqual([])
    })

    it('refuses a filter condition it cannot evaluate, even nested inside the folder AND', async () => {
      // `entered` (filterPinsMailbox) only proves the mailbox pin, and it is satisfied as soon as ONE
      // branch of the AND names the mailbox — so the REST of the filter reaches the placement gate and
      // has to be evaluated there. These are the shapes that reach it and must all be refused:
      // an unknown condition key (a deny-list would place the row and be wrong about it), a nested
      // OR/NOT (`false` here means "not proven", which only composes soundly under AND), and a keyword
      // condition the arrival does not satisfy.
      type FilterBranch = Extract<EmailFilter, { operator: string }>['conditions'][number]
      const and = (...extra: FilterBranch[]): EmailFilter => ({
        operator: 'AND',
        conditions: [{ inMailbox: 'archive' }, { after: '2026-06-01T00:00:00Z' }, ...extra],
      })
      const filters: Record<string, EmailFilter> = {
        'attachment-win': and({ hasAttachment: true }), // known to JMAP, not to us
        'text-win': and({ text: 'invoice' }),
        'thread-cond-win': and({ someInThreadHaveKeyword: '$flagged' }),
        'or-win': and({
          operator: 'OR',
          conditions: [{ hasKeyword: 'work' }, { hasKeyword: 'other' }],
        }),
        'not-win': and({ operator: 'NOT', conditions: [{ hasKeyword: 'nope' }] }),
        // Evaluable AND false: the arrival carries `work`, so a `notKeyword: work` window rejects it.
        'notkeyword-win': and({ notKeyword: 'work' }),
        'haskeyword-win': and({ hasKeyword: 'absent' }),
      }
      await putEmails(db, ACC, [
        email('a1', { mailboxIds: { archive: true }, receivedAt: at(9) }),
        inbox('e1', { receivedAt: at(7), keywords: { work: true } }),
      ])
      for (const [key, filter] of Object.entries(filters)) {
        await putQueryCache(db, windowRow(key, filter, ['a1'], { total: 1 }))
      }
      // The positive control: the same AND plus a condition we CAN evaluate and that holds.
      await putQueryCache(
        db,
        windowRow('ok-win', and({ hasKeyword: 'work' }), ['a1'], { total: 1 }),
      )

      await archiveTo('e1')

      for (const key of Object.keys(filters)) {
        expect((await win(key))?.ids, key).toEqual(['a1'])
        expect((await win(key))?.queryState, key).toBeNull() // refused ⇒ void-only
      }
      expect((await win('ok-win'))?.ids).toEqual(['a1', 'e1'])
      expect(await insertedKeys('i1')).toEqual(['ok-win'])
    })

    it('refuses when ANY neighbour envelope is missing from the replica', async () => {
      // `backfillQuery` writes the window row BEFORE the envelopes it lists, with a network round-trip
      // in between ("the reverse gap"). Comparing against a row we do not hold is guessing.
      await seedArchive()
      await db.emails.delete([ACC, 'a2'])
      await putEmails(db, ACC, [inbox('e1', { receivedAt: at(7) })])

      await archiveTo('e1')

      expect((await win('archive-win'))?.ids).toEqual(['a1', 'a2', 'a3'])
      expect(await insertedKeys('i1')).toEqual([])
    })

    it('refuses a sort it cannot reproduce, and the two thread-keyword comparator traps', async () => {
      // `from`/`subject` sort by STRING COLLATION — the server's locale and case rules. The thread
      // comparators carry a `keyword` exactly like `hasKeyword` does, so a "has a keyword field" test
      // would accept them and get them wrong: they are properties of a whole thread whose other
      // envelopes the replica does not guarantee to hold.
      const sorts: Record<string, QueryCacheRow['sort']> = {
        'from-win': [{ property: 'from', isAscending: true }],
        'subject-win': [{ property: 'subject', isAscending: true }],
        'all-thread-win': [{ property: 'allInThreadHaveKeyword', keyword: '$seen' }],
        'some-thread-win': [{ property: 'someInThreadHaveKeyword', keyword: '$seen' }],
        'nosort-win': null,
        'unknown-win': [{ property: 'somethingTheServerAdded' }],
        // A `hasKeyword` comparator with NO keyword is structurally legal and means nothing local.
        'bare-keyword-win': [{ property: 'hasKeyword' }],
      }
      await putEmails(db, ACC, [
        email('a1', { mailboxIds: { archive: true }, receivedAt: at(9) }),
        inbox('e1', { receivedAt: at(7) }),
      ])
      for (const [key, sort] of Object.entries(sorts)) {
        await putQueryCache(
          db,
          windowRow(key, inMailboxFilter('archive'), ['a1'], { total: 1, sort }),
        )
      }
      // The positive control: the SAME setup with a reproducible sort does place the row, so these
      // refusals are about the comparator and not about some unrelated gate failing first.
      await putQueryCache(
        db,
        windowRow('date-win', inMailboxFilter('archive'), ['a1'], { total: 1 }),
      )

      await archiveTo('e1')

      for (const key of Object.keys(sorts)) {
        expect((await win(key))?.ids, key).toEqual(['a1'])
        expect((await win(key))?.queryState, key).toBeNull() // refused ⇒ void-only, as before M3.10
      }
      expect((await win('date-win'))?.ids).toEqual(['a1', 'e1'])
      expect(await insertedKeys('i1')).toEqual(['date-win'])
    })

    it('places by size and honours a comparator whose isAscending is OMITTED (⇒ true)', async () => {
      // `isAscending` defaults to TRUE (core.ts), so the test must be `=== false`; `!c.isAscending`
      // would read an omitted flag as descending and invert every window that leaves it out.
      await putEmails(db, ACC, [
        email('a1', { mailboxIds: { archive: true }, size: 100 }),
        email('a2', { mailboxIds: { archive: true }, size: 300 }),
        inbox('e1', { size: 200 }),
      ])
      await putQueryCache(
        db,
        windowRow('size-win', inMailboxFilter('archive'), ['a1', 'a2'], {
          total: 2,
          sort: [{ property: 'size' }], // ascending by omission
        }),
      )

      await archiveTo('e1')

      expect((await win('size-win'))?.ids).toEqual(['a1', 'e1', 'a2'])
    })

    it('places under "Unread first", and falls through to the TIE-BREAKING comparator', async () => {
      // The shipped toggle's sort (use-message-list.ts): `hasKeyword $seen` ascending, then the base.
      // Two windows, because one alone cannot prove the key is compared ELEMENT-WISE:
      //  - `unread-first-win`: the arrival is OLDER than both neighbours and must still land FIRST,
      //    purely on the keyword — the leading comparator decides on its own.
      //  - `all-read-win`: every row carries `$seen`, so the leading comparator ties all the way
      //    through and only the SECOND can order the arrival. Comparing just the first would append.
      const seen: Record<string, true> = { $seen: true }
      await putEmails(db, ACC, [
        email('a1', { mailboxIds: { archive: true }, keywords: seen, receivedAt: at(9) }),
        email('a2', { mailboxIds: { archive: true }, keywords: seen, receivedAt: at(5) }),
        email('b1', { mailboxIds: { archive: true }, keywords: seen, receivedAt: at(9) }),
        email('b2', { mailboxIds: { archive: true }, keywords: seen, receivedAt: at(1) }),
        inbox('e1', { receivedAt: at(1) }), // unread ⇒ above every read row, despite being oldest
        inbox('e2', { receivedAt: at(7), keywords: seen }), // read ⇒ ordered by date alone
      ])
      const unreadFirstSort: QueryCacheRow['sort'] = [
        { property: 'hasKeyword', keyword: '$seen', isAscending: true },
        { property: 'receivedAt', isAscending: false },
      ]
      await putQueryCache(
        db,
        windowRow('unread-first-win', inMailboxFilter('archive'), ['a1', 'a2'], {
          total: 2,
          sort: unreadFirstSort,
        }),
      )
      await putQueryCache(
        db,
        windowRow('all-read-win', inMailboxFilter('archive'), ['b1', 'b2'], {
          total: 2,
          sort: unreadFirstSort,
        }),
      )

      await enqueueAction(
        db,
        ACC,
        { kind: 'move', emailIds: ['e1', 'e2'], from: 'inbox', to: 'archive' },
        { id: 'i1', now: 1 },
      )

      expect((await win('unread-first-win'))?.ids).toEqual(['e1', 'a1', 'e2', 'a2'])
      expect((await win('all-read-win'))?.ids).toEqual(['e1', 'b1', 'e2', 'b2'])
    })

    it('refuses a collapsed window whose thread is already represented; a flat one takes it', async () => {
      // Under `collapseThreads` an entry stands for a THREAD. The server would not add a second row
      // for a thread it already lists, so inserting one would double the conversation on screen and
      // over-count `total`, which counts THREADS for a collapsed query. Flat is the opposite case:
      // there every message is its own row, so the sibling is a legitimate extra entry.
      await putEmails(db, ACC, [
        email('a1', { mailboxIds: { archive: true }, threadId: 't-shared', receivedAt: at(9) }),
        inbox('e1', { threadId: 't-shared', receivedAt: at(7) }),
      ])
      await putQueryCache(
        db,
        windowRow('collapsed-win', inMailboxFilter('archive'), ['a1'], { total: 1 }),
      )
      await putQueryCache(
        db,
        windowRow('flat-win', inMailboxFilter('archive'), ['a1'], {
          total: 1,
          collapseThreads: false,
        }),
      )

      await archiveTo('e1')

      expect((await win('collapsed-win'))?.ids).toEqual(['a1'])
      expect((await win('collapsed-win'))?.total).toBe(1)
      expect((await win('collapsed-win'))?.queryState).toBeNull()
      expect((await win('flat-win'))?.ids).toEqual(['a1', 'e1'])
      expect(await insertedKeys('i1')).toEqual(['flat-win'])
    })

    it('never places into a window it cannot prove the message entered (search, OR, other folder)', async () => {
      // The `entered` predicate still runs first: a free-text search and an OR-filtered window are
      // never even offered the arrival, whatever their sort says.
      await putEmails(db, ACC, [
        email('a1', { mailboxIds: { archive: true }, receivedAt: at(9) }),
        inbox('e1', { receivedAt: at(7) }),
      ])
      await putQueryCache(db, windowRow('search-win', { text: 'invoice' }, ['a1'], { total: 1 }))
      await putQueryCache(
        db,
        windowRow(
          'or-win',
          { operator: 'OR', conditions: [{ inMailbox: 'archive' }, { hasKeyword: 'work' }] },
          ['a1'],
          { total: 1 },
        ),
      )
      await putQueryCache(
        db,
        windowRow('later-win', inMailboxFilter('later'), ['a1'], { total: 1 }),
      )

      await archiveTo('e1')

      for (const key of ['search-win', 'or-win', 'later-win']) {
        expect((await win(key))?.ids, key).toEqual(['a1'])
        expect((await win(key))?.queryState, key).toBe('q-1') // not even voided — nothing changed
      }
      expect(await insertedKeys('i1')).toEqual([])
    })

    it('places a BULK move in one pass, each id at its own index', async () => {
      await seedArchive()
      await putEmails(db, ACC, [
        inbox('e1', { receivedAt: at(20) }),
        inbox('e2', { receivedAt: at(7) }),
        inbox('e3', { receivedAt: at(3) }),
      ])

      await enqueueAction(
        db,
        ACC,
        { kind: 'move', emailIds: ['e1', 'e2', 'e3'], from: 'inbox', to: 'archive' },
        { id: 'i1', now: 1 },
      )

      expect((await win('archive-win'))?.ids).toEqual(['e1', 'a1', 'e2', 'a2', 'e3', 'a3'])
      expect((await win('archive-win'))?.total).toBe(6)
      expect(await insertedKeys('i1')).toEqual(['archive-win']) // one key per WINDOW, not per id
    })

    it('never places into a window belonging to a DIFFERENT account', async () => {
      const OTHER = 'other-acc'
      await seedArchive()
      await putEmails(db, ACC, [inbox('e1', { receivedAt: at(7) })])
      await putEmails(db, OTHER, [
        email('a1', { mailboxIds: { archive: true }, receivedAt: at(9) }),
      ])
      await putQueryCache(db, {
        ...windowRow('archive-win', inMailboxFilter('archive'), ['a1'], { total: 1 }),
        accountId: OTHER,
      })

      await archiveTo('e1')

      expect((await db.queryCache.get([ACC, 'archive-win']))?.ids).toEqual(['a1', 'e1', 'a2', 'a3'])
      expect((await db.queryCache.get([OTHER, 'archive-win']))?.ids).toEqual(['a1'])
      expect((await db.queryCache.get([OTHER, 'archive-win']))?.queryState).toBe('q-1')
    })

    it('the insert CONVERGES on the server’s order — it never duplicates the id', async () => {
      // The single most important case: a deliberately WRONG guess, then the re-query the void forces.
      // `fullRequery` replaces `ids` wholesale (delta.ts), so the row cannot end up twice — and the
      // `queryChanges` branch, which WOULD duplicate it against a baseline we edited, is never taken.
      await seedArchive()
      await putEmails(db, ACC, [inbox('e1', { receivedAt: at(7) })])
      await archiveTo('e1')
      expect((await win('archive-win'))?.ids).toEqual(['a1', 'e1', 'a2', 'a3'])

      let deltaCalled = false
      const port = fakePort({
        queryEmailChanges: async () => {
          deltaCalled = true
          return { oldQueryState: 'q-1', newQueryState: 'q-2', removed: [], added: [] }
        },
        // The server disagrees with our guess by one position (a collapsed window sorts by a key it
        // picks for the THREAD, which need not be the envelope it handed us).
        queryEmails: async () => ({
          ids: ['a1', 'a2', 'e1', 'a3'],
          queryState: 'q-2',
          canCalculateChanges: true,
          position: 0,
          total: 4,
        }),
        getEmailEnvelopes: async (ids) => ({
          list: ids.map((id) => email(id)),
          notFound: [],
          state: 'eml-1',
        }),
      })
      await reconcileQuery(
        port,
        db,
        ACC,
        'archive-win',
        { filter: inMailboxFilter('archive') },
        clock,
      )

      expect(deltaCalled).toBe(false)
      expect((await win('archive-win'))?.ids).toEqual(['a1', 'a2', 'e1', 'a3'])
      expect((await win('archive-win'))?.queryState).toBe('q-2')
    })

    it('the rollback of a REJECTED move takes the inserted id back OUT of the window', async () => {
      // Voiding alone is NOT enough here, which is why `insertedKeys` exists: the phantom id would
      // keep rendering a message the server refused to move until the re-query lands.
      await seedArchive()
      await putEmails(db, ACC, [inbox('e1', { receivedAt: at(7) })])
      await archiveTo('e1')
      expect((await win('archive-win'))?.ids).toEqual(['a1', 'e1', 'a2', 'a3'])
      // A reconcile that ran in between restored the baseline — against ids we are about to edit.
      await db.queryCache.update([ACC, 'archive-win'], { queryState: 'q-2' })

      const port = fakePort({
        setEmails: async () => setResult({ notUpdated: { e1: { type: 'forbidden' } } }),
      })
      await replayOutbox(port, db, ACC, { random: NO_JITTER })

      expect((await row('i1'))?.status).toBe('error')
      expect((await db.emails.get([ACC, 'e1']))?.mailboxIds).toEqual({ inbox: true })
      expect((await win('archive-win'))?.ids).toEqual(['a1', 'a2', 'a3'])
      expect((await win('archive-win'))?.total).toBe(3)
      expect((await win('archive-win'))?.upToId).toBe('a3')
      expect((await win('archive-win'))?.queryState).toBeNull()
    })

    /**
     * TWO arrivals into ONE incomplete window, where the second one's tail-drop drops the id the first
     * one inserted. Pinned here because the interaction is not obvious and nothing else covered it.
     *
     * `e1` lands at index 1 and pushes `a2` off the tail; `e2` then lands at index 0 and pushes `e1`
     * itself off. `total` was already incremented for `e1` and `archive-win` is already in
     * `insertedKeys`, so the window ends up counting an id it no longer lists.
     */
    it('a second arrival may drop the first off the tail — the count that leaves behind', async () => {
      await putEmails(db, ACC, [
        email('a1', { mailboxIds: { archive: true }, receivedAt: at(9) }),
        email('a2', { mailboxIds: { archive: true }, receivedAt: at(5) }),
      ])
      // 2 loaded of 40 matches ⇒ incomplete, so every insert is paid for by dropping the tail.
      await putQueryCache(
        db,
        windowRow('archive-win', inMailboxFilter('archive'), ['a1', 'a2'], { total: 40 }),
      )
      await putEmails(db, ACC, [
        inbox('e1', { receivedAt: at(7) }), // between a1 and a2
        inbox('e2', { receivedAt: at(20) }), // newer than everything ⇒ index 0
      ])

      await enqueueAction(
        db,
        ACC,
        { kind: 'move', emailIds: ['e1', 'e2'], from: 'inbox', to: 'archive' },
        { id: 'i1', now: 1 },
      )

      // The window is still exactly 2 long (the invariant `placeArrival` exists to keep), and `e1` —
      // inserted a moment ago — is already back off the page. `total` counts BOTH arrivals, which is
      // the honest match count: 40 + e1 + e2. Both really are in the archive now.
      expect((await win('archive-win'))?.ids).toEqual(['e2', 'a1'])
      expect((await win('archive-win'))?.total).toBe(42)
      expect((await win('archive-win'))?.upToId).toBe('a1')
      expect((await win('archive-win'))?.queryState).toBeNull()
      expect(await insertedKeys('i1')).toEqual(['archive-win'])

      // Now the server rejects BOTH. `retractWindows` can only take back what the window still LISTS,
      // and `e1` is not listed — so `total` comes down by one instead of two and settles at 41 where
      // the truth is 40. This is the drift, and it is why the retraction voids as well as edits.
      const port = fakePort({
        setEmails: async () =>
          setResult({ notUpdated: { e1: { type: 'forbidden' }, e2: { type: 'forbidden' } } }),
      })
      await replayOutbox(port, db, ACC, { random: NO_JITTER })

      expect((await db.emails.get([ACC, 'e1']))?.mailboxIds).toEqual({ inbox: true })
      expect((await db.emails.get([ACC, 'e2']))?.mailboxIds).toEqual({ inbox: true })
      expect((await win('archive-win'))?.ids).toEqual(['a1'])
      expect((await win('archive-win'))?.total).toBe(41) // ← +1 drift: the truth is 40
      expect((await win('archive-win'))?.queryState).toBeNull()

      // …and why the drift is benign rather than merely small: the void forces a `fullRequery`, which
      // replaces `ids`, `total` and `upToId` wholesale from the server's answer (delta.ts) — it never
      // adjusts them relative to what we left behind. A rollback only ever runs because the server
      // ANSWERED, so we are online and that re-query is always reachable.
      const requeryPort = fakePort({
        queryEmails: async () => ({
          ids: ['a1', 'a2'],
          queryState: 'q-9',
          canCalculateChanges: true,
          position: 0,
          total: 40,
        }),
        getEmailEnvelopes: async (ids) => ({
          list: ids.map((id) => email(id)),
          notFound: [],
          state: 'eml-1',
        }),
      })
      await reconcileQuery(
        requeryPort,
        db,
        ACC,
        'archive-win',
        { filter: inMailboxFilter('archive') },
        clock,
      )
      expect((await win('archive-win'))?.ids).toEqual(['a1', 'a2'])
      expect((await win('archive-win'))?.total).toBe(40) // the drift is gone, not carried forward
      expect((await win('archive-win'))?.queryState).toBe('q-9')
    })

    it('a PARTIAL rejection retracts only the ids that actually failed', async () => {
      // `insertedKeys` records WINDOWS, not which id went into which, so the removal has to intersect
      // with the rollback's scope (`undoTargets` — db.ts: an undo must survive being applied to a
      // SUBSET). Without the intersection a one-id rejection would strip the whole batch out.
      await seedArchive()
      await putEmails(db, ACC, [
        inbox('e1', { receivedAt: at(7) }),
        inbox('e2', { receivedAt: at(3) }),
      ])
      await enqueueAction(
        db,
        ACC,
        { kind: 'move', emailIds: ['e1', 'e2'], from: 'inbox', to: 'archive' },
        { id: 'i1', now: 1 },
      )
      expect((await win('archive-win'))?.ids).toEqual(['a1', 'e1', 'a2', 'e2', 'a3'])

      const port = fakePort({
        setEmails: async () =>
          setResult({ updated: ['e1'], notUpdated: { e2: { type: 'forbidden' } } }),
      })
      await replayOutbox(port, db, ACC, { random: NO_JITTER })

      // `e1` succeeded and stays placed; only `e2` is taken back out.
      expect((await win('archive-win'))?.ids).toEqual(['a1', 'e1', 'a2', 'a3'])
      expect((await win('archive-win'))?.total).toBe(4)
      expect((await db.emails.get([ACC, 'e1']))?.mailboxIds).toEqual({ archive: true })
      expect((await db.emails.get([ACC, 'e2']))?.mailboxIds).toEqual({ inbox: true })
    })
  })

  /**
   * Gap B8: the membership gate in front of `entered` used to be a WHOLE-WINDOW quantifier
   * (`window.ids.some(id => touched.has(id))`), so one already-listed id marked the entire window
   * "listed" and suppressed the whole batch. A bulk move of `[e1,e2]` into a window already showing
   * `e1` placed NEITHER and did not even void it — the row was visibly missing until a reconcile that
   * offline never runs. The gate is now per id: "is this window missing any of them?".
   */
  describe('per-id window membership (M3.10, gap B8)', () => {
    const at = (day: number) => `2026-07-${String(day).padStart(2, '0')}T00:00:00Z`

    /**
     * The B8 shape: a COMPLETE archive window that already lists ONE of the ids the move touches.
     * `e1` is in the archive AND the Inbox (a copy, or an archive the user re-filed); `e2` is
     * Inbox-only and is the id the window is missing.
     */
    async function seedOverlap(over: Partial<QueryCacheRow> = {}): Promise<void> {
      await putEmails(db, ACC, [
        email('a1', { mailboxIds: { archive: true }, receivedAt: at(9) }),
        email('e1', { mailboxIds: { archive: true, inbox: true }, receivedAt: at(7) }),
        inbox('e2', { receivedAt: at(5) }),
      ])
      await putQueryCache(
        db,
        windowRow('archive-win', inMailboxFilter('archive'), ['a1', 'e1'], { total: 2, ...over }),
      )
    }

    const moveToArchive = (emailIds: string[]) =>
      enqueueAction(
        db,
        ACC,
        { kind: 'move', emailIds, from: 'inbox', to: 'archive' },
        { id: 'i1', now: 1 },
      )

    it('places the ids a window is MISSING even though it already lists one of them', async () => {
      await seedOverlap()

      await moveToArchive(['e1', 'e2'])

      // `e2` lands after `e1` (day 5 < day 7) — legal past the tail because the window is complete.
      // `e1` is filtered out of the batch by `placeArrivals`, so it is not duplicated.
      expect((await win('archive-win'))?.ids).toEqual(['a1', 'e1', 'e2'])
      expect((await win('archive-win'))?.total).toBe(3) // by the number really PLACED, not the batch size
      expect((await win('archive-win'))?.upToId).toBe('e2')
      expect((await win('archive-win'))?.queryState).toBeNull()
      expect(await insertedKeys('i1')).toEqual(['archive-win'])
    })

    it('never lists the already-present id TWICE, on a window with no thread collapsing', async () => {
      // B8 turned the per-id filtering inside `placeArrivals`/`placeArrival` from defensive dead code
      // into live code: before it, a partially-overlapping batch never reached the placement at all.
      // On a COLLAPSED window the same-thread refusal would mask a missing id guard; a FLAT window
      // (`collapseThreads: false`, what `useLabelView` and the flat list mode write) has no such
      // second line of defence, so `e1` would be appended a second time and render twice.
      await seedOverlap({ collapseThreads: false })

      await moveToArchive(['e1', 'e2'])

      expect((await win('archive-win'))?.ids).toEqual(['a1', 'e1', 'e2'])
      expect((await win('archive-win'))?.total).toBe(3)
    })

    it('still skips a window that already lists EVERY id the move touches', async () => {
      // The guardrail against over-correcting into an unconditional `entered`: there is genuinely
      // nothing to pick up here, so the window keeps its cheap delta instead of buying a re-query.
      await seedOverlap()

      await moveToArchive(['e1'])

      expect((await win('archive-win'))?.ids).toEqual(['a1', 'e1'])
      expect((await win('archive-win'))?.total).toBe(2)
      expect((await win('archive-win'))?.queryState).toBe('q-1')
      expect(await insertedKeys('i1')).toEqual([])
    })

    it('voids a window that holds every id it could ACCEPT — accepted cost, not desired behaviour', async () => {
      // PINNED AS A KNOWN COST, so it is visible rather than rediscovered. The `entered` gate asks
      // "does the intent contain an id this window does not LIST?" — which is NOT the same question
      // as "is there anything here for this window to pick up?": neither the gate nor `entered`
      // itself (`filterPinsMailbox`, mailbox-coarse) is filter-aware. This window is pinned to
      // `archive` AND `hasKeyword:$flagged`, and it already holds `e1` — the only id in the batch it
      // could ever accept, because `e2` is unflagged. It is voided all the same, buying a
      // `fullRequery` that changes nothing.
      //
      // Deliberate, not an oversight: the only per-id filter test available (`windowAcceptsLocally`)
      // is an allow-list that REFUSES what it cannot decide, so using it as a gate would skip the
      // void exactly where we are least sure the baseline is still valid. Over-voiding costs a
      // round-trip; under-voiding is a wrong list. If the gate is ever made filter-aware, the
      // `queryState` expectation below is the one to flip.
      await putEmails(db, ACC, [
        email('e1', {
          mailboxIds: { archive: true, inbox: true },
          keywords: { $flagged: true },
          receivedAt: at(7),
        }),
        inbox('e2', { receivedAt: at(5) }), // unflagged ⇒ this window can never take it
      ])
      await putQueryCache(
        db,
        windowRow(
          'flagged-win',
          { operator: 'AND', conditions: [{ inMailbox: 'archive' }, { hasKeyword: '$flagged' }] },
          ['e1'],
          { total: 1 },
        ),
      )

      await moveToArchive(['e1', 'e2'])

      expect((await win('flagged-win'))?.ids).toEqual(['e1']) // `e2` is correctly NOT spliced in
      expect((await win('flagged-win'))?.total).toBe(1)
      expect((await win('flagged-win'))?.queryState).toBeNull() // ← the cost: a re-query for nothing
      expect(await insertedKeys('i1')).toEqual([])
    })

    it('VOIDS a partially-overlapping window whose order it cannot reproduce', async () => {
      // The other half of the B8 report ("does not even void"): the newly-opened branch must still
      // fall back to voiding when the placement is not provable — here a `subject` sort, whose
      // collation is the server's.
      await seedOverlap({ sort: [{ property: 'subject', isAscending: true }] })

      await moveToArchive(['e1', 'e2'])

      expect((await win('archive-win'))?.ids).toEqual(['a1', 'e1'])
      expect((await win('archive-win'))?.queryState).toBeNull()
      expect(await insertedKeys('i1')).toEqual([]) // nothing edited ⇒ nothing to roll back
    })

    it('keeps a partially-overlapping INCOMPLETE window as long as it was, after EVERY insert', async () => {
      // The tail-drop invariant is paid per INSERT, not per transaction. Two arrivals both place at
      // index 0, and the second evicts the first-inserted id rather than growing the head page.
      await seedOverlap({ total: 40 })
      await putEmails(db, ACC, [
        inbox('e2', { receivedAt: at(20) }), // newer than everything loaded ⇒ index 0
        inbox('e3', { receivedAt: at(30) }), // newer still ⇒ index 0 again, evicting e2's neighbour
      ])

      await moveToArchive(['e1', 'e2', 'e3'])

      expect((await win('archive-win'))?.ids).toEqual(['e3', 'e2'])
      expect((await win('archive-win'))?.ids).toHaveLength(2) // exactly as long as it was seeded
      expect((await win('archive-win'))?.upToId).toBe('e2')
      // 40 + e2 + e3. `e1` was already listed, so it is not a new match and moves nothing; `a1` and
      // the old `e1` row did not LEAVE the query, they are one page down.
      expect((await win('archive-win'))?.total).toBe(42)
      expect(await insertedKeys('i1')).toEqual(['archive-win'])
    })

    it('places a bulk batch in the intent’s order and gets the same answer in any order', async () => {
      // The decision NOT to pre-sort the arrivals (see `placeArrivals`): each placement recomputes its
      // index against the RUNNING ids, so on a complete window the result is an insertion sort and is
      // order-independent. This is the reverse of the `places a BULK move in one pass` case above and
      // must land on the identical ids.
      await putEmails(db, ACC, [
        email('a1', { mailboxIds: { archive: true }, receivedAt: at(9) }),
        email('a2', { mailboxIds: { archive: true }, receivedAt: at(5) }),
        email('a3', { mailboxIds: { archive: true }, receivedAt: at(1) }),
        inbox('e1', { receivedAt: at(20) }),
        inbox('e2', { receivedAt: at(7) }),
        inbox('e3', { receivedAt: at(3) }),
      ])
      await putQueryCache(
        db,
        windowRow('archive-win', inMailboxFilter('archive'), ['a1', 'a2', 'a3'], { total: 3 }),
      )

      await moveToArchive(['e3', 'e2', 'e1']) // reversed

      expect((await win('archive-win'))?.ids).toEqual(['e1', 'a1', 'e2', 'a2', 'e3', 'a3'])
      expect((await win('archive-win'))?.total).toBe(6)
    })

    it('breaks a TIE by ARRIVAL order, not by the sort — the order-independence has a limit', async () => {
      // The claim above holds only for DISTINCT sort keys, and the test above cannot see the gap
      // because every id in its fixture has its own day. `placeArrival` scans for the first
      // neighbour the arrival sorts STRICTLY before (`compareSortKeys(...) < 0`), so an arrival ties
      // in AFTER an equal neighbour — including one placed a moment earlier in the same batch. Two
      // messages carrying the same `receivedAt` is the normal case for bulk-delivered mail.
      //
      // Recorded, not wished away, and behaviourally benign: every insert voids the window, so the
      // server's `fullRequery` replaces `ids` wholesale and decides the tie itself.
      const seed = async (key: string) => {
        await putEmails(db, ACC, [
          email('a1', { mailboxIds: { archive: true }, receivedAt: at(9) }),
          inbox('e1', { receivedAt: at(5) }),
          inbox('e2', { receivedAt: at(5) }), // the SAME instant as `e1`
        ])
        await putQueryCache(
          db,
          windowRow(key, inMailboxFilter('archive'), ['a1'], { total: 1 }), // complete
        )
      }

      await seed('fwd-win')
      await moveToArchive(['e1', 'e2'])
      expect((await win('fwd-win'))?.ids).toEqual(['a1', 'e1', 'e2'])

      // The identical batch, reversed, over an identical window and identical envelopes.
      await db.queryCache.delete([ACC, 'fwd-win'])
      await seed('rev-win')
      await enqueueAction(
        db,
        ACC,
        { kind: 'move', emailIds: ['e2', 'e1'], from: 'inbox', to: 'archive' },
        { id: 'i2', now: 2 },
      )
      expect((await win('rev-win'))?.ids).toEqual(['a1', 'e2', 'e1']) // NOT the forward answer
      expect((await win('rev-win'))?.queryState).toBeNull() // which is why it does not matter
    })

    it('voids a partially-overlapping keyword window too — the setKeywords half of B8', async () => {
      // `setKeywords` passes no `arrivals`, so its `entered` branch is void-only. It sat behind the
      // same whole-window gate: an `is:read` window listing `e1` was not even voided when `[e1,e2]`
      // were marked read together, so `e2` did not show up there until the next full reconcile.
      await putEmails(db, ACC, [
        email('e1', { keywords: { $seen: true } }),
        inbox('e2'),
        inbox('e3'),
      ])
      await putQueryCache(db, windowRow('read-win', { hasKeyword: '$seen' }, ['e1'], { total: 9 }))

      await enqueueAction(
        db,
        ACC,
        { kind: 'setKeywords', emailIds: ['e1', 'e2'], keyword: '$seen', value: true },
        { id: 'i1', now: 1 },
      )

      expect((await win('read-win'))?.ids).toEqual(['e1']) // only the server can place `e2`
      expect((await win('read-win'))?.total).toBe(9)
      expect((await win('read-win'))?.queryState).toBeNull()
      expect(await prunedKeys('i1')).toEqual([]) // void-only ⇒ nothing was edited, nothing to undo

      // …and the all-listed case still keeps its baseline, exactly as for a move.
      await db.queryCache.update([ACC, 'read-win'], { queryState: 'q-3' })
      await enqueueAction(
        db,
        ACC,
        { kind: 'setKeywords', emailIds: ['e1'], keyword: '$seen', value: true },
        { id: 'i2', now: 2 },
      )
      expect((await win('read-win'))?.queryState).toBe('q-3')
    })

    /**
     * The UNDO half, and the ACCEPTED COST B8 makes reachable: rejecting the bulk move retracts MORE
     * than it inserted. This is pinned as behaviour, not celebrated as correct.
     *
     * `insertedKeys` records WINDOWS, not which id landed where, so the retraction removes by
     * intersection over the undo's whole id set — and that takes `e1` out of `archive-win` even though
     * the apply never spliced `e1` in (the window already listed it) and the envelope patch
     * deliberately leaves `e1` IN the archive. The window ends one row SHORTER than it was before the
     * move. Before B8 this window could never have been in `insertedKeys` at all, because the
     * whole-window gate skipped any window that listed a touched id; the existing arrival-retraction
     * tests all seed a destination window with ZERO overlap, which is why it was not covered.
     *
     * A narrowing by `hadTo` was tried here and REVERTED — see the long note in `applyUndo`. `hadTo` is
     * envelope-scoped and the question is window-scoped, so it fixes this shape and breaks the one in
     * "an id the window did NOT list is spliced in and must come back out" below.
     *
     * What redeems it is the forced re-query at the end of this test, and nothing else.
     */
    it('a REJECTED bulk move over-retracts the id the window already listed, and re-queries', async () => {
      await seedOverlap()
      await moveToArchive(['e1', 'e2'])
      expect((await win('archive-win'))?.ids).toEqual(['a1', 'e1', 'e2'])

      const port = fakePort({
        setEmails: async () =>
          setResult({ notUpdated: { e1: { type: 'forbidden' }, e2: { type: 'forbidden' } } }),
      })
      await replayOutbox(port, db, ACC, { random: NO_JITTER })

      expect((await row('i1'))?.status).toBe('error')
      // The ENVELOPES are exact: `e2` goes back to the Inbox, and `e1` — which was in the archive
      // before the move — keeps `archive` and gets `inbox` back.
      expect((await db.emails.get([ACC, 'e2']))?.mailboxIds).toEqual({ inbox: true })
      expect((await db.emails.get([ACC, 'e1']))?.mailboxIds).toEqual({ inbox: true, archive: true })
      // The WINDOW is NOT: the retraction drops the whole undo id set, so `e1` goes too — a row that
      // was in this window BEFORE the move and that the apply never inserted. `total` is one short of
      // the truth to match. This is the over-retraction, asserted so a change to it is deliberate.
      expect((await win('archive-win'))?.ids).toEqual(['a1'])
      expect((await win('archive-win'))?.total).toBe(1)
      expect((await win('archive-win'))?.upToId).toBe('a1')
      // The window is voided anyway: our `ids` were edited, so the delta baseline is a lie regardless.
      expect((await win('archive-win'))?.queryState).toBeNull()

      const requeryPort = fakePort({
        queryEmails: async () => ({
          ids: ['a1', 'e1'],
          queryState: 'q-9',
          canCalculateChanges: true,
          position: 0,
          total: 2,
        }),
        getEmailEnvelopes: async (ids) => ({
          list: ids.map((id) => email(id)),
          notFound: [],
          state: 'eml-1',
        }),
      })
      await reconcileQuery(
        requeryPort,
        db,
        ACC,
        'archive-win',
        { filter: inMailboxFilter('archive') },
        clock,
      )

      expect((await win('archive-win'))?.ids).toEqual(['a1', 'e1']) // `e1` is back
      expect((await win('archive-win'))?.total).toBe(2)
      expect((await win('archive-win'))?.queryState).toBe('q-9')
    })

    /**
     * THE SHAPE THAT KILLED THE `hadTo` NARROWING, and the reason it could ship green: every other
     * fixture in this block puts the `hadTo` id INSIDE `window.ids`, so the `hadTo ∧ NOT-LISTED`
     * branch was reached by no test at all.
     *
     * `e1` is in the archive AND the Inbox, so it is `hadTo` — a property of the ENVELOPE. But THIS
     * archive window does not list it (it is a complete two-row window of `a1`/`a2`; think a filtered
     * or freshly-paged view). The apply passes every touched envelope as an arrival and
     * `placeArrivals` drops only the ids the window ALREADY LISTS, so `e1` IS spliced in here and DOES
     * add 1 to `total`. A retraction that excluded `hadTo` ids would therefore leave `e1` and its `+1`
     * behind for good — a phantom row the server rejected.
     *
     * The assertion below is the reverted, correct behaviour: the window returns to its exact pre-move
     * state. Re-applying `ids.filter((id) => !hadTo.has(id))` in `applyUndo` must turn this RED.
     */
    it('an id the window did NOT list is spliced in and must come back out, `hadTo` or not', async () => {
      await putEmails(db, ACC, [
        email('a1', { mailboxIds: { archive: true }, receivedAt: at(9) }),
        email('a2', { mailboxIds: { archive: true }, receivedAt: at(8) }),
        // `hadTo` (already in the archive) — and NOT listed by the window below.
        email('e1', { mailboxIds: { archive: true, inbox: true }, receivedAt: at(20) }),
        inbox('e2', { receivedAt: at(21) }),
      ])
      await putQueryCache(
        db,
        windowRow('archive-win', inMailboxFilter('archive'), ['a1', 'a2'], { total: 2 }),
      )

      await moveToArchive(['e1', 'e2'])

      // Both are spliced in — `e1` too, because THIS window never listed it.
      expect((await win('archive-win'))?.ids).toEqual(['e2', 'e1', 'a1', 'a2'])
      expect((await win('archive-win'))?.total).toBe(4)
      expect(await insertedKeys('i1')).toEqual(['archive-win'])

      const port = fakePort({
        setEmails: async () =>
          setResult({ notUpdated: { e1: { type: 'forbidden' }, e2: { type: 'forbidden' } } }),
      })
      await replayOutbox(port, db, ACC, { random: NO_JITTER })

      expect((await row('i1'))?.status).toBe('error')
      // The envelope patch is unchanged by any of this: `e1` keeps the archive it had before the move.
      expect((await db.emails.get([ACC, 'e1']))?.mailboxIds).toEqual({ inbox: true, archive: true })
      expect((await db.emails.get([ACC, 'e2']))?.mailboxIds).toEqual({ inbox: true })
      // And the WINDOW is back to exactly what it was before the move — both inserts and both `+1`s
      // taken back. Under the reverted narrowing this was `['e1','a1','a2']` with a total of 3.
      expect((await win('archive-win'))?.ids).toEqual(['a1', 'a2'])
      expect((await win('archive-win'))?.total).toBe(2)
      expect((await win('archive-win'))?.upToId).toBe('a2')
      expect((await win('archive-win'))?.queryState).toBeNull()
    })

    it('a destination window that could reject the restored `from` is never inserted into', async () => {
      // The undo RESTORES `from` on the envelope, so a destination window whose filter EXCLUDES `from`
      // could in principle be left holding a row it no longer accepts. It cannot happen: such a window
      // can never be in `insertedKeys` in the first place. Saying "in the archive and NOT in the inbox"
      // needs an `OR`/`NOT`, which `windowAcceptsLocally` refuses outright, so `placeArrivals` returns
      // null and the window is only VOIDED. The conditions it DOES understand
      // (`inMailbox`/`after`/`before`/`hasKeyword`/`notKeyword`) cannot be falsified by adding a
      // mailbox id back to the envelope — so the placement gate, not the retraction, is what keeps
      // this sound.
      await putEmails(db, ACC, [
        email('a1', { mailboxIds: { archive: true }, receivedAt: at(9) }),
        email('e1', { mailboxIds: { archive: true, inbox: true }, receivedAt: at(7) }),
        inbox('e2', { receivedAt: at(5) }),
      ])
      await putQueryCache(
        db,
        windowRow(
          'not-inbox-win',
          {
            operator: 'AND',
            conditions: [
              { inMailbox: 'archive' },
              { operator: 'NOT', conditions: [{ inMailbox: 'inbox' }] },
            ],
          },
          ['a1'],
          { total: 1 },
        ),
      )

      await moveToArchive(['e1', 'e2'])

      expect((await win('not-inbox-win'))?.ids).toEqual(['a1']) // nothing spliced in…
      expect((await win('not-inbox-win'))?.queryState).toBeNull() // …void-only, the old behaviour
      expect(await insertedKeys('i1')).toEqual([]) // ⇒ the retraction never sees this window
    })

    /**
     * THE LARGER HOLE — the same rollback as the two tests above, at its worst.
     *
     * An arrival into an INCOMPLETE window is paid for by dropping the tail id, and the undo records
     * nothing about what was evicted. At N > 2 that eats the entire head page: four inserts push all
     * three original rows off the tail, the retraction takes the four inserts back out, and the
     * window ends EMPTY while still carrying a `total` of 41.
     *
     * Not fixable within the undo's budget: restoring the evicted ids means recording them, i.e.
     * growing a payload stored on the outbox row, which `outbox.ts` says it may not do. It converges
     * (the retraction voids, the next reconcile is a `fullRequery`, and a rollback only happens
     * because the server ANSWERED — so we are online). Until then the window is empty-but-nonzero,
     * and the web UI must not paint a confident "no messages" over a window whose `total` is not zero.
     */
    it('the retraction can wipe the whole head page — the eviction the undo cannot record', async () => {
      await putEmails(db, ACC, [
        email('a1', { mailboxIds: { archive: true }, receivedAt: at(9) }),
        email('a2', { mailboxIds: { archive: true }, receivedAt: at(8) }),
        email('e1', { mailboxIds: { archive: true, inbox: true }, receivedAt: at(7) }),
        inbox('e2', { receivedAt: at(20) }), // all four sort to index 0, newest last
        inbox('e3', { receivedAt: at(21) }),
        inbox('e4', { receivedAt: at(22) }),
        inbox('e5', { receivedAt: at(23) }),
      ])
      await putQueryCache(
        db,
        windowRow('archive-win', inMailboxFilter('archive'), ['a1', 'a2', 'e1'], { total: 40 }),
      )

      await moveToArchive(['e1', 'e2', 'e3', 'e4', 'e5'])

      // The APPLY is CORRECT: four inserts at index 0, the head page stays three long, `total` up by
      // the four ids that really are new matches (`e1` was already listed).
      expect((await win('archive-win'))?.ids).toEqual(['e5', 'e4', 'e3'])
      expect((await win('archive-win'))?.total).toBe(44)

      const port = fakePort({
        setEmails: async () =>
          setResult({
            notUpdated: Object.fromEntries(
              ['e1', 'e2', 'e3', 'e4', 'e5'].map((id) => [id, { type: 'forbidden' }]),
            ),
          }),
      })
      await replayOutbox(port, db, ACC, { random: NO_JITTER })

      expect((await row('i1'))?.status).toBe('error')
      // The ENVELOPES are exact, as always: `e1` keeps the archive it had before the move.
      expect((await db.emails.get([ACC, 'e1']))?.mailboxIds).toEqual({ inbox: true, archive: true })
      expect((await db.emails.get([ACC, 'e5']))?.mailboxIds).toEqual({ inbox: true })
      // The WINDOW is not: a1/a2/e1 were evicted off the tail by the inserts and nothing restores
      // them, so removing the four inserts leaves an EMPTY head page carrying a total of 41.
      expect((await win('archive-win'))?.ids).toEqual([])
      expect((await win('archive-win'))?.total).toBe(41) // ← empty, and not zero
      expect((await win('archive-win'))?.upToId).toBeNull()
      expect((await win('archive-win'))?.queryState).toBeNull() // the only thing that saves it
    })

    /**
     * `retractWindows`' `Math.max(0, …)` clamp, which survived deletion with the whole suite green.
     *
     * It is NOT decorative, and the function's own comment says why: the retraction removes ids by a
     * bare intersection over the undo's whole id set, so it can remove ids this rollback never put
     * there — ids the window's `total` therefore never counted. Drive `total` below the number
     * removed and a bare subtraction hands the list a NEGATIVE match count.
     *
     * The way it gets there is the one `retractWindows` already documents in its `get`-then-`put`:
     * a reconcile landing BETWEEN the optimistic apply and the rollback, rewriting `total` from the
     * server's answer. Here the server has meanwhile emptied the archive down to a single match.
     */
    it('the retraction clamps `total` at zero — it removes ids the total never counted', async () => {
      await seedOverlap()

      await moveToArchive(['e1', 'e2'])
      expect((await win('archive-win'))?.ids).toEqual(['a1', 'e1', 'e2'])
      expect(await insertedKeys('i1')).toEqual(['archive-win'])

      // A reconcile lands in between and re-states `total` from the server: one match left.
      const applied = await win('archive-win')
      if (applied === undefined) throw new Error('window vanished')
      await putQueryCache(db, { ...applied, total: 1, queryState: 'q-2' })

      const port = fakePort({
        setEmails: async () =>
          setResult({ notUpdated: { e1: { type: 'forbidden' }, e2: { type: 'forbidden' } } }),
      })
      await replayOutbox(port, db, ACC, { random: NO_JITTER })

      expect((await row('i1'))?.status).toBe('error')
      // Two ids come out (`e1` — the over-retraction — and `e2`), against a total of 1.
      expect((await win('archive-win'))?.ids).toEqual(['a1'])
      expect((await win('archive-win'))?.total).toBe(0) // ← NOT -1
      expect((await win('archive-win'))?.queryState).toBeNull()
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
    // STILL OWED — never silently dropped.
    expect(owed?.undo).toEqual({ kind: 'refetchEmails', prunedKeys: [] })
    expect(await db.emails.get([ACC, 'e1'])).toBeUndefined()
    // The dead letter is still listed, so the stale local state is visible, not silent.
    expect((await failedOutbox(db, ACC)).map((r) => r.id)).toEqual(['i1'])

    await replayOutbox(port, db, ACC, { random: NO_JITTER })
    expect(await db.emails.get([ACC, 'e1'])).toBeDefined() // drained on the next pass
    expect(await db.emails.get([ACC, 'e2'])).toBeDefined()
    expect((await row('i1'))?.undo).toBeNull()
  })

  /**
   * `applyUndo`'s `hadFrom` guard — the twin of the `hadTo` guard three lines above it, and the one
   * the whole M8 episode was NOT about. It survived deletion with the suite green because the only
   * fixture that set `hadFrom` set it to EVERY id in the batch, so the guard could never discriminate.
   *
   * A bulk move's ids do NOT have to share a source. `from` is the view the user acted in (the folder
   * the list is pinned to), while a selected message can sit in other folders and not in that one at
   * all — a Sent copy shown in a thread, a search result, a label view. `applyOptimistic` already
   * knows this: `hadFrom` is computed per id, and the forward patch only deletes `from` from the ids
   * that had it. Without the guard the ROLLBACK is not the inverse — it ADDS `from` to messages that
   * were never in it, filing mail into a folder the user never put it in.
   */
  it('a rollback re-adds the SOURCE folder only to the ids that were actually in it', async () => {
    await putEmails(db, ACC, [
      email('e1', { mailboxIds: { inbox: true } }),
      email('e2', { mailboxIds: { sent: true } }), // selected from a thread — never in the Inbox
    ])
    await enqueueAction(
      db,
      ACC,
      { kind: 'move', emailIds: ['e1', 'e2'], from: 'inbox', to: 'archive' },
      { id: 'i1', now: 1 },
    )
    expect((await row('i1'))?.undo).toMatchObject({ hadFrom: ['e1'] }) // per id, already

    const port = fakePort({
      setEmails: async () =>
        setResult({ notUpdated: { e1: { type: 'forbidden' }, e2: { type: 'forbidden' } } }),
    })
    await replayOutbox(port, db, ACC, { random: NO_JITTER })

    expect((await row('i1'))?.status).toBe('error')
    expect((await db.emails.get([ACC, 'e1']))?.mailboxIds).toEqual({ inbox: true })
    // The whole point: `e2` goes back to Sent ALONE. An unguarded rollback would leave it
    // `{ sent: true, inbox: true }` — filed into the Inbox by an operation that failed.
    expect((await db.emails.get([ACC, 'e2']))?.mailboxIds).toEqual({ sent: true })
  })
})

/**
 * M3.10, gap B7 — the folder-tree badge. `Mailbox.unreadEmails`/`totalEmails` are server-owned and
 * were never patched optimistically. That was invisible while the LIST was equally stale; B1 and B2
 * made the list move instantly, so the row now leaves the folder while the badge beside it does not,
 * until the server's delta lands — offline, until reconnect.
 *
 * The fix is a DELTA PATCH (±1), not a replica recompute: `db.emails` is a bounded, actively
 * shrinking horizon, so a local `count()` of a 50k Inbox is not stale but categorically wrong. See
 * `adjustMailboxCounts` for the full argument.
 *
 * Every fixture below seeds NON-ZERO counts on purpose. With everything at 0 the `Math.max(0, …)`
 * clamp makes several wrong implementations indistinguishable from a correct one — the failure mode
 * B1's verification caught, reproduced here deliberately as a rule rather than an accident.
 */
describe('outbox — the folder counts (M3.10, gap B7)', () => {
  /** Non-zero everywhere, and the THREAD counts are non-zero too so "untouched" is assertable. */
  async function seedBoxes(): Promise<void> {
    await putMailboxes(db, ACC, [
      mailbox('inbox', { totalEmails: 10, unreadEmails: 4, totalThreads: 7, unreadThreads: 3 }),
      mailbox('archive', { totalEmails: 2, unreadEmails: 1, totalThreads: 2, unreadThreads: 1 }),
      mailbox('work', { totalEmails: 5, unreadEmails: 5, totalThreads: 5, unreadThreads: 5 }),
    ])
  }

  async function counts(id: string): Promise<{ total: number; unread: number }> {
    const box = await db.mailboxes.get([ACC, id])
    if (box === undefined) throw new Error(`no mailbox ${id}`)
    return { total: box.totalEmails, unread: box.unreadEmails }
  }

  const read = (id: string, mailboxIds: Record<string, true>) =>
    email(id, { mailboxIds, keywords: { $seen: true } })
  const unread = (id: string, mailboxIds: Record<string, true>) =>
    email(id, { mailboxIds, keywords: {} })

  const rejectAll = (ids: string[]) =>
    fakePort({
      setEmails: async () =>
        setResult({ notUpdated: Object.fromEntries(ids.map((id) => [id, { type: 'forbidden' }])) }),
    })

  describe('the forward apply', () => {
    /**
     * THE `from` GATE — the third case `moveCountDeltas` covers and the only one its doc used to
     * omit. The `to` gate ("already in the destination") is pinned by the test below and the
     * `from === null` case by the copy test; `from !== null` but the message was NEVER IN `from` was
     * neither named nor covered, and dropping `&& row.mailboxIds[from] === true` left the whole
     * suite green.
     *
     * The action is ordinary, not exotic: a bulk selection made from a LABEL or a SEARCH view spans
     * folders, and `from` is only the view the user archived out of. Without the gate the source is
     * debited once per id in the batch regardless of where those ids were — 8/2 where the truth is
     * 9/3, i.e. the Inbox badge counts down for a message the Inbox never held.
     */
    it('a move debits the source only for the ids that were ACTUALLY in it', async () => {
      await seedBoxes()
      await putEmails(db, ACC, [
        unread('e1', { inbox: true }),
        unread('e2', { work: true }), // NEVER in the source
      ])

      await enqueueAction(
        db,
        ACC,
        { kind: 'move', emailIds: ['e1', 'e2'], from: 'inbox', to: 'archive' },
        { id: 'i1', now: 1 },
      )

      expect(await counts('inbox')).toEqual({ total: 9, unread: 3 }) // e1 left it; e2 never was in it
      expect(await counts('work')).toEqual({ total: 5, unread: 5 }) // a move touches `from` and `to`, nothing else
      expect(await counts('archive')).toEqual({ total: 4, unread: 3 }) // BOTH arrived
      // The gate's other half of the machinery: `hadFrom` is per id, and persisting it is the only
      // way the rollback and the re-apply can still tell e1 from e2 later.
      expect((await row('i1'))?.undo).toMatchObject({ hadFrom: ['e1'] })
    })

    it('a move debits the source and credits the destination, per id and per read state', async () => {
      await seedBoxes()
      await putEmails(db, ACC, [
        unread('e1', { inbox: true }),
        read('e2', { inbox: true }),
        unread('e3', { inbox: true, archive: true }), // ALREADY in the destination
      ])

      await enqueueAction(
        db,
        ACC,
        { kind: 'move', emailIds: ['e1', 'e2', 'e3'], from: 'inbox', to: 'archive' },
        { id: 'i1', now: 1 },
      )

      // Source: three left it, two of them unread.
      expect(await counts('inbox')).toEqual({ total: 7, unread: 2 })
      // Destination: only TWO arrived — `e3` was already there and must contribute 0 to both fields
      // — and only `e1` of those was unread.
      expect(await counts('archive')).toEqual({ total: 4, unread: 2 })
      // The THREAD counts are deliberately left alone: they are server-owned, nothing reads them,
      // and a per-message move cannot imply a thread-count delta at all (moving one message out of a
      // three-message thread changes `totalThreads` by 0, not 1, and nothing local can tell which).
      const box = await db.mailboxes.get([ACC, 'inbox'])
      expect(box?.totalThreads).toBe(7)
      expect(box?.unreadThreads).toBe(3)
    })

    it('a move with from === null (a copy) credits the destination and debits NOTHING', async () => {
      await seedBoxes()
      await putEmails(db, ACC, [unread('e1', { inbox: true })])

      await enqueueAction(
        db,
        ACC,
        { kind: 'move', emailIds: ['e1'], from: null, to: 'archive' },
        { id: 'i1', now: 1 },
      )

      expect(await counts('inbox')).toEqual({ total: 10, unread: 4 }) // the message left nothing
      expect(await counts('archive')).toEqual({ total: 3, unread: 2 })
    })

    it('marking read decrements unreadEmails in EVERY mailbox the message is in, total never', async () => {
      await seedBoxes()
      await putEmails(db, ACC, [
        unread('e1', { inbox: true, work: true }),
        read('e2', { inbox: true }), // already read — marking it read again must move nothing
      ])

      await enqueueAction(
        db,
        ACC,
        { kind: 'setKeywords', emailIds: ['e1', 'e2'], keyword: '$seen', value: true },
        { id: 'i1', now: 1 },
      )

      expect(await counts('inbox')).toEqual({ total: 10, unread: 3 })
      expect(await counts('work')).toEqual({ total: 5, unread: 4 })
    })

    it('marking UNread increments, and only for the ids that were actually read', async () => {
      await seedBoxes()
      // The two ids differ in MEMBERSHIP as well as in read state, deliberately: with both of them
      // in the Inbox alone, inverting the flip gate ("skip the rows that were already read" vs
      // "skip the rows that flip") yields the same Inbox number and the test proves nothing.
      await putEmails(db, ACC, [
        read('e1', { inbox: true, work: true }),
        unread('e2', { inbox: true }), // already unread — must contribute 0
      ])

      await enqueueAction(
        db,
        ACC,
        { kind: 'setKeywords', emailIds: ['e1', 'e2'], keyword: '$seen', value: false },
        { id: 'i1', now: 1 },
      )

      expect(await counts('inbox')).toEqual({ total: 10, unread: 5 })
      expect(await counts('work')).toEqual({ total: 5, unread: 6 })
    })

    /**
     * THE GATE, and the single most mutation-worthy line in B7. `Mailbox.unreadEmails` is a count of
     * `$seen`; no other keyword has a folder count at all. A label add or strip is a `setKeywords`
     * intent reaching exactly the same code path, and it must leave every badge where it was.
     */
    it('a LABEL add or strip moves no folder count whatsoever', async () => {
      await seedBoxes()
      await putEmails(db, ACC, [
        unread('e1', { inbox: true, work: true }),
        email('e2', { mailboxIds: { inbox: true }, keywords: { $flagged: true } }),
      ])

      await enqueueAction(
        db,
        ACC,
        { kind: 'setKeywords', emailIds: ['e1'], keyword: 'work', value: true },
        { id: 'i1', now: 1 },
      )
      await enqueueAction(
        db,
        ACC,
        { kind: 'setKeywords', emailIds: ['e2'], keyword: '$flagged', value: false },
        { id: 'i2', now: 2 },
      )

      expect(await counts('inbox')).toEqual({ total: 10, unread: 4 })
      expect(await counts('work')).toEqual({ total: 5, unread: 5 })
    })

    /**
     * The pre-image MUST be read before `deleteEmails` — this case used to read nothing at all before
     * it. Computed afterwards the delta is empty and every badge stays put.
     */
    it('a destroy debits every mailbox the message was in — read from the PRE-image', async () => {
      await seedBoxes()
      await putEmails(db, ACC, [
        unread('e1', { inbox: true, archive: true }),
        read('e2', { inbox: true }),
      ])

      await enqueueAction(
        db,
        ACC,
        { kind: 'destroyEmails', emailIds: ['e1', 'e2'] },
        {
          id: 'i1',
          now: 1,
        },
      )

      expect(await counts('inbox')).toEqual({ total: 8, unread: 3 })
      expect(await counts('archive')).toEqual({ total: 1, unread: 0 })
    })

    it('never drives a count negative — the replica may hold what the server has not counted', async () => {
      // The horizon cuts both ways: a backfill can hold envelopes a stale `Mailbox` row does not
      // reflect yet, so a decrement can outrun the number it is decrementing.
      await putMailboxes(db, ACC, [mailbox('inbox', { totalEmails: 1, unreadEmails: 0 })])
      await putEmails(db, ACC, [unread('e1', { inbox: true }), unread('e2', { inbox: true })])

      await enqueueAction(
        db,
        ACC,
        { kind: 'destroyEmails', emailIds: ['e1', 'e2'] },
        {
          id: 'i1',
          now: 1,
        },
      )

      expect(await counts('inbox')).toEqual({ total: 0, unread: 0 }) // NOT -1 / -2
    })

    it('leaves a mailbox the replica does not hold alone instead of inventing a row', async () => {
      await putMailboxes(db, ACC, [mailbox('inbox', { totalEmails: 10, unreadEmails: 4 })])
      await putEmails(db, ACC, [unread('e1', { inbox: true })])

      await enqueueAction(
        db,
        ACC,
        { kind: 'move', emailIds: ['e1'], from: 'inbox', to: 'not-synced-yet' },
        { id: 'i1', now: 1 },
      )

      expect(await counts('inbox')).toEqual({ total: 9, unread: 3 })
      expect(await db.mailboxes.get([ACC, 'not-synced-yet'])).toBeUndefined()
    })
  })

  describe('the rollback', () => {
    /**
     * The same `from` gate, in the direction where its absence INVENTS mail: `negate` turns the
     * missing debit into a CREDIT, so `inbox` gains +1 for an id that was never in `inbox` — a badge
     * counting a message the folder never held, which no later `Mailbox/changes` need ever correct.
     *
     * This is the direction the persisted `hadFrom` exists for. `applyUndo` rebuilds the pre-image
     * as `{ [from]: hadFrom.has(id), [to]: hadTo.has(id) }` — with an explicit `false`, which is the
     * only membership record in this module that ever carries one — purely so the gate can consume
     * it. Nothing tested that the persistence did anything at all.
     *
     * THE RE-SEED between the apply and the rollback is load-bearing, not decoration. The gate is
     * SHARED by both directions, so a round trip cancels itself out: without it the apply reads
     * -2/-2 and the rollback +2/+2, landing on exactly the same number as the correct -1/-1 then
     * +1/+1. Restating the post-move counts discards the forward arithmetic and leaves the
     * rollback's alone under test.
     */
    it('a rejected move credits the source only for the ids that were ACTUALLY in it', async () => {
      await seedBoxes()
      await putEmails(db, ACC, [
        unread('e1', { inbox: true }),
        unread('e2', { work: true }), // never in `inbox`
      ])
      await enqueueAction(
        db,
        ACC,
        { kind: 'move', emailIds: ['e1', 'e2'], from: 'inbox', to: 'archive' },
        { id: 'i1', now: 1 },
      )
      // The post-move truth, restated. See above — this is what isolates the rollback.
      await putMailboxes(db, ACC, [
        mailbox('inbox', { totalEmails: 9, unreadEmails: 3 }),
        mailbox('archive', { totalEmails: 4, unreadEmails: 3 }),
      ])

      await replayOutbox(rejectAll(['e1', 'e2']), db, ACC, { random: NO_JITTER })

      expect((await row('i1'))?.status).toBe('error')
      expect(await counts('inbox')).toEqual({ total: 10, unread: 4 }) // +1 for e1 — and nothing for e2
      expect(await counts('archive')).toEqual({ total: 2, unread: 1 }) // both leave again
      expect(await counts('work')).toEqual({ total: 5, unread: 5 }) // still untouched
    })

    it('a REJECTED move puts both mailboxes’ counts back exactly', async () => {
      await seedBoxes()
      await putEmails(db, ACC, [
        unread('e1', { inbox: true }),
        read('e2', { inbox: true }),
        unread('e3', { inbox: true, archive: true }),
      ])
      await enqueueAction(
        db,
        ACC,
        { kind: 'move', emailIds: ['e1', 'e2', 'e3'], from: 'inbox', to: 'archive' },
        { id: 'i1', now: 1 },
      )

      await replayOutbox(rejectAll(['e1', 'e2', 'e3']), db, ACC, { random: NO_JITTER })

      expect((await row('i1'))?.status).toBe('error')
      expect(await counts('inbox')).toEqual({ total: 10, unread: 4 })
      expect(await counts('archive')).toEqual({ total: 2, unread: 1 })
    })

    it('a PARTIAL rejection reverses the count only for the ids that actually failed', async () => {
      await seedBoxes()
      await putEmails(db, ACC, [unread('e1', { inbox: true }), unread('e2', { inbox: true })])
      await enqueueAction(
        db,
        ACC,
        { kind: 'move', emailIds: ['e1', 'e2'], from: 'inbox', to: 'archive' },
        { id: 'i1', now: 1 },
      )
      expect(await counts('inbox')).toEqual({ total: 8, unread: 2 })

      const port = fakePort({
        setEmails: async () =>
          setResult({ updated: ['e1'], notUpdated: { e2: { type: 'forbidden' } } }),
      })
      await replayOutbox(port, db, ACC, { random: NO_JITTER })

      // e1 stayed archived, e2 came back: exactly ONE of the two is reversed on each side.
      expect(await counts('inbox')).toEqual({ total: 9, unread: 3 })
      expect(await counts('archive')).toEqual({ total: 3, unread: 2 })
    })

    it('a REJECTED mark-read restores unreadEmails, and only for the id that flipped', async () => {
      await seedBoxes()
      await putEmails(db, ACC, [unread('e1', { inbox: true }), read('e2', { inbox: true })])
      await enqueueAction(
        db,
        ACC,
        { kind: 'setKeywords', emailIds: ['e1', 'e2'], keyword: '$seen', value: true },
        { id: 'i1', now: 1 },
      )
      expect(await counts('inbox')).toEqual({ total: 10, unread: 3 })

      await replayOutbox(rejectAll(['e1', 'e2']), db, ACC, { random: NO_JITTER })

      expect(await counts('inbox')).toEqual({ total: 10, unread: 4 }) // back, not 2
    })

    it('a rejected LABEL change reverses no count either — both directions of the gate', async () => {
      await seedBoxes()
      await putEmails(db, ACC, [unread('e1', { inbox: true })])
      await enqueueAction(
        db,
        ACC,
        { kind: 'setKeywords', emailIds: ['e1'], keyword: 'work', value: true },
        { id: 'i1', now: 1 },
      )

      await replayOutbox(rejectAll(['e1']), db, ACC, { random: NO_JITTER })

      expect((await row('i1'))?.status).toBe('error')
      expect(await counts('inbox')).toEqual({ total: 10, unread: 4 })
    })

    /**
     * The sharpest trap in the rollback path: a destroy's undo is a network RE-FETCH, and an id the
     * server reports `notFound` is really gone ("already gone" is a SUCCESS here). Restoring its
     * count would be a permanent over-count with no correction coming — that mailbox never changes
     * again, so `Mailbox/changes` never re-reports it.
     */
    it('a rejected destroy restores counts only for the envelopes the server RETURNED', async () => {
      await seedBoxes()
      await putEmails(db, ACC, [unread('e1', { inbox: true }), unread('e2', { inbox: true })])
      await enqueueAction(
        db,
        ACC,
        { kind: 'destroyEmails', emailIds: ['e1', 'e2'] },
        {
          id: 'i1',
          now: 1,
        },
      )
      expect(await counts('inbox')).toEqual({ total: 8, unread: 2 })

      const port = fakePort({
        setEmails: async () =>
          setResult({ notDestroyed: { e1: { type: 'forbidden' }, e2: { type: 'forbidden' } } }),
        // e2 really is gone server-side — it must come back neither as an envelope nor as a count.
        getEmailEnvelopes: async () => ({
          list: [unread('e1', { inbox: true })],
          notFound: ['e2'],
          state: 's',
        }),
      })
      await replayOutbox(port, db, ACC, { random: NO_JITTER })

      expect(await db.emails.get([ACC, 'e2'])).toBeUndefined()
      expect(await counts('inbox')).toEqual({ total: 9, unread: 3 }) // +1, not +2
    })
  })

  /**
   * `reapplyPendingCounts` — the durability half. A sync pass writes the server's ABSOLUTE count
   * over a badge an unsent intent has already moved, so the delta has to go back on.
   *
   * The narrowing to `pending` is the whole safety argument and it is asserted here directly rather
   * than through the engine, because the engine cannot hold a row `inflight` on demand.
   */
  describe('re-applying after a sync pass', () => {
    const bothFields = { total: ['inbox'], unread: ['inbox'] }

    async function markRead(): Promise<void> {
      await seedBoxes()
      await putEmails(db, ACC, [unread('e1', { inbox: true })])
      await enqueueAction(
        db,
        ACC,
        { kind: 'setKeywords', emailIds: ['e1'], keyword: '$seen', value: true },
        { id: 'i1', now: 1 },
      )
      // The pass overwrites the badge with the server's pre-mutation number.
      await putMailboxes(db, ACC, [mailbox('inbox', { totalEmails: 10, unreadEmails: 4 })])
    }

    it('puts an UNSENT intent’s delta back over the count the pass overwrote', async () => {
      await markRead()

      await reapplyPendingCounts(db, ACC, bothFields)

      expect(await counts('inbox')).toEqual({ total: 10, unread: 3 })
    })

    /**
     * THE `inflight` EXCLUSION. `pendingOutbox` — the function every other caller here uses —
     * returns `pending` AND `inflight`, and re-using it would have been the obvious thing to do. It
     * is wrong for arithmetic: an inflight intent's request is already out, its effect may already
     * be in the number the server just handed us, and `recoverStranded` even re-sends one a killed
     * leader left behind. Adding its ±1 again is a double-count — and a double-count, unlike
     * staleness, NEVER self-corrects, because the mailbox is only re-reported when it changes again.
     */
    it('never re-applies an INFLIGHT intent — its effect may already be in the server’s number', async () => {
      await markRead()
      await db.outbox.update([ACC, 'i1'], { status: 'inflight' })

      await reapplyPendingCounts(db, ACC, bothFields)

      expect(await counts('inbox')).toEqual({ total: 10, unread: 4 }) // the server's word stands
    })

    it('re-applies only the FIELDS the pass actually wrote', async () => {
      await markRead()

      // A rename: neither count was overwritten, so neither may be re-applied.
      await reapplyPendingCounts(db, ACC, { total: [], unread: [] })
      expect(await counts('inbox')).toEqual({ total: 10, unread: 4 })

      // A second unsent intent — a move, whose delta spans BOTH fields — against a pass that
      // rewrote only `unreadEmails`.
      await putEmails(db, ACC, [unread('e2', { inbox: true })])
      await enqueueAction(
        db,
        ACC,
        { kind: 'move', emailIds: ['e2'], from: 'inbox', to: 'archive' },
        { id: 'i2', now: 2 },
      )
      await putMailboxes(db, ACC, [mailbox('inbox', { totalEmails: 10, unreadEmails: 4 })])
      await reapplyPendingCounts(db, ACC, { total: [], unread: ['inbox'] })

      // `unreadEmails` gets both unsent deltas back (-1 mark-read, -1 move); `totalEmails` gets
      // nothing, because the pass never touched it and the optimistic -1 is still in the row.
      expect(await counts('inbox')).toEqual({ total: 10, unread: 2 })
    })

    /**
     * THE OTHER POLARITY of the same narrowing. The test above only ever passes
     * `{ total: [], unread: [] }` and `{ total: [], unread: ['inbox'] }`, so the `total` half of the
     * per-field zeroing carried all the weight and the `unread` half carried none: deleting
     * `if (!unread.has(mailboxId)) delta.unread = 0` left the whole suite green.
     *
     * `{ total: ['inbox'], unread: [] }` is an EVERYDAY pass, not a contrivance. A READ message
     * arriving in or leaving a folder changes `totalEmails` and not `unreadEmails`, so
     * `Mailbox/changes` reporting `updatedProperties: ['totalEmails']` alone is ordinary, and
     * `delta.ts` turns exactly that into this shape.
     *
     * And what sits behind it is the failure mode this module argues about at length: the unsent
     * move's `unread` -1 goes on top of the optimistic -1 STILL SITTING in the row, so
     * `unreadEmails` reads 2 where the truth is 3 — a double-count, which unlike staleness never
     * self-corrects, because the mailbox is only re-reported when it changes AGAIN.
     */
    it('re-applies only the FIELDS the pass wrote — the `unread` half of the narrowing too', async () => {
      await seedBoxes()
      await putEmails(db, ACC, [unread('e1', { inbox: true })])
      await enqueueAction(
        db,
        ACC,
        { kind: 'move', emailIds: ['e1'], from: 'inbox', to: 'archive' },
        { id: 'i1', now: 1 },
      )
      expect(await counts('inbox')).toEqual({ total: 9, unread: 3 })

      // The pass overwrote `totalEmails` ONLY: it is back at the server's pre-move 10, while
      // `unreadEmails` still holds our optimistic 3.
      await putMailboxes(db, ACC, [mailbox('inbox', { totalEmails: 10, unreadEmails: 3 })])

      await reapplyPendingCounts(db, ACC, { total: ['inbox'], unread: [] })

      // `totalEmails` gets the -1 back. `unreadEmails` must NOT — it was never overwritten.
      expect(await counts('inbox')).toEqual({ total: 9, unread: 3 })
      // The destination was not in the pass at all, so neither field of its delta may be re-applied.
      expect(await counts('archive')).toEqual({ total: 3, unread: 2 })
    })

    it('re-derives a move’s delta from the persisted undo, on both ends', async () => {
      await seedBoxes()
      await putEmails(db, ACC, [
        unread('e1', { inbox: true }),
        unread('e2', { inbox: true, archive: true }), // already in the destination
      ])
      await enqueueAction(
        db,
        ACC,
        { kind: 'move', emailIds: ['e1', 'e2'], from: 'inbox', to: 'archive' },
        { id: 'i1', now: 1 },
      )
      await putMailboxes(db, ACC, [
        mailbox('inbox', { totalEmails: 10, unreadEmails: 4 }),
        mailbox('archive', { totalEmails: 2, unreadEmails: 1 }),
      ])

      await reapplyPendingCounts(db, ACC, {
        total: ['inbox', 'archive'],
        unread: ['inbox', 'archive'],
      })

      // `hadFrom`/`hadTo` survive in the undo, so `e2` still contributes 0 to the destination.
      expect(await counts('inbox')).toEqual({ total: 8, unread: 2 })
      expect(await counts('archive')).toEqual({ total: 3, unread: 2 })
    })

    /**
     * The THIRD consumer of the `from` gate, and the third place a membership record is built with
     * an explicit `false` for it: `unsentCountDeltas` reconstructs
     * `{ [from]: hadFrom.has(id) }` from the persisted undo. The test above re-derives a move whose
     * ids were ALL in `from`, so `hadFrom.has` returned `true` for every one of them and the gate
     * could not discriminate — the same blind spot the forward and rollback tests had.
     *
     * Here `e2` was never in the Inbox, so the undo persists `hadFrom: ['e1']` and the re-apply must
     * put back exactly ONE debit. Without the gate it puts back two, on top of the number the pass
     * just wrote.
     */
    it('re-derives a move’s delta for the ids that were ACTUALLY in the source, and no others', async () => {
      await seedBoxes()
      await putEmails(db, ACC, [
        unread('e1', { inbox: true }),
        unread('e2', { work: true }), // never in `inbox`
      ])
      await enqueueAction(
        db,
        ACC,
        { kind: 'move', emailIds: ['e1', 'e2'], from: 'inbox', to: 'archive' },
        { id: 'i1', now: 1 },
      )
      // The pass re-reported the Inbox with the server's pre-move numbers, erasing our -1.
      await putMailboxes(db, ACC, [mailbox('inbox', { totalEmails: 10, unreadEmails: 4 })])

      await reapplyPendingCounts(db, ACC, bothFields)

      expect(await counts('inbox')).toEqual({ total: 9, unread: 3 }) // -1, not -2
    })

    /**
     * THE GATE, on the RE-APPLY path — a second copy of it used to live in `unsentCountDeltas` and
     * was completely unpinned: deleting it left the whole suite green, because the forward-apply
     * gate test above only ever exercised the copy in `countDeltasFor`.
     *
     * There is real behaviour behind it. An offline label add is a `setKeywords` intent with a
     * `keywords` undo, and it reaches this path like any other. Without the gate its `had` — the set
     * of ids that already carried the LABEL — is read as if it were the `$seen` pre-image, and
     * `unreadEmails` badges move for a change that touched no read state at all. The two copies are
     * now ONE: the re-apply routes through `countDeltasFor`, so there is a single gate to get right.
     */
    it('a LABEL add is never re-applied as a read-state change', async () => {
      await seedBoxes()
      // Unread and NOT yet labelled, so `had` is empty: with the gate gone, `!had.has('e1')` reads
      // as "was unread", the flip gate passes, and the Inbox badge moves 4 → 3 for a label add.
      await putEmails(db, ACC, [unread('e1', { inbox: true })])
      await enqueueAction(
        db,
        ACC,
        { kind: 'setKeywords', emailIds: ['e1'], keyword: 'work', value: true },
        { id: 'i1', now: 1 },
      )
      await putMailboxes(db, ACC, [mailbox('inbox', { totalEmails: 10, unreadEmails: 4 })])

      await reapplyPendingCounts(db, ACC, bothFields)

      expect(await counts('inbox')).toEqual({ total: 10, unread: 4 })
    })

    /**
     * THE FOUR LAUNDERING PATHS, and the reason the predicate is `pending` AND `attempts === 0`
     * rather than `pending` alone.
     *
     * `pending` in this state machine means "not currently dispatched", NOT "never dispatched".
     * Each path below takes a row whose request HAS gone out and puts it back to `pending`; its ±1
     * may already be in the server's number, so re-applying it double-counts — and a double-count
     * never self-corrects, because the mailbox is only re-reported when it changes AGAIN. All four
     * assert the SAFE error instead: the server's number stands, and it reverts to the optimistic
     * one when the intent finally lands.
     *
     * This block was titled THE THREE LAUNDERING PATHS and covered three. The fourth — the
     * per-object `rateLimit` retry — was missed because it is the only one not reached from a THROWN
     * error, and it is the one whose exclusion needs the least hedging of the four.
     */
    describe('never re-applies a row that was already dispatched', () => {
      it('a row `recoverStranded` returned to pending — the request went out, the leader died', async () => {
        await markRead()
        // A leader claimed the row and was killed mid-request: it is stranded `inflight`.
        await db.outbox.update([ACC, 'i1'], { status: 'inflight' })
        // `notBefore` past `now` keeps replay from ALSO re-sending it in this pass, so what is under
        // test is the recovery alone.
        await db.outbox.update([ACC, 'i1'], { notBefore: 10_000 })
        const port = fakePort({ setEmails: unused })

        await replayOutbox(port, db, ACC, { now: 100, random: NO_JITTER })

        const recovered = await row('i1')
        expect(recovered?.status).toBe('pending') // laundered back — this is the hazard
        expect(recovered?.attempts).toBe(1) // …but recorded as dispatched, which is what saves it

        await reapplyPendingCounts(db, ACC, bothFields)
        expect(await counts('inbox')).toEqual({ total: 10, unread: 4 })
      })

      it('a row the TRANSIENT retry returned to pending — a thrown error may have been processed', async () => {
        await markRead()
        const port = fakePort({
          setEmails: async () => {
            // The response may simply have been lost. The code's own comment says a thrown error
            // leaves it UNKNOWN whether the request reached the server; that reasoning was applied
            // only to `sendEmail`, and a ±1 count delta is no more idempotent than a submission.
            throw new TypeError('fetch failed')
          },
        })

        await replayOutbox(port, db, ACC, { now: 100, random: NO_JITTER })

        const backedOff = await row('i1')
        expect(backedOff?.status).toBe('pending')
        expect(backedOff?.attempts).toBe(1)

        await reapplyPendingCounts(db, ACC, bothFields)
        expect(await counts('inbox')).toEqual({ total: 10, unread: 4 })
      })

      it('a row AUTH EXPIRY returned to pending', async () => {
        await markRead()
        const port = fakePort({
          setEmails: async () => {
            throw new JmapHttpError(401, '')
          },
        })

        await expect(
          replayOutbox(port, db, ACC, { now: 100, random: NO_JITTER }),
        ).rejects.toBeInstanceOf(JmapHttpError)

        const parked = await row('i1')
        expect(parked?.status).toBe('pending')
        expect(parked?.attempts).toBe(1)

        // The weakest of the four — a 401 very probably precedes processing — and skipped anyway,
        // because "very probably" is not a standard an unrecoverable double-count may rest on.
        await reapplyPendingCounts(db, ACC, bothFields)
        expect(await counts('inbox')).toEqual({ total: 10, unread: 4 })
      })

      /**
       * THE FOURTH PATH, and the STRONGEST case for skipping of all four. The other three rest on
       * "the request MAY have reached the server": a stranded leader, a lost response, a 401 that
       * probably preceded processing. This one rests on "it DID". A per-object `SetError` is the
       * server ANSWERING — the request provably arrived and was processed — and in a bulk intent
       * the objects that were NOT rate-limited were applied, so part of this row's delta is
       * certainly already inside the number the pass just handed us. There is no doubt to resolve
       * here, only an obligation to skip.
       *
       * It is also the path that was missed, twice, because it is the only one not reached from a
       * thrown error: the row is laundered back to `pending` from a SUCCESSFUL response.
       */
      it('a row a per-object rateLimit returned to pending — the server ANSWERED', async () => {
        await markRead()
        const port = fakePort({
          setEmails: async () => setResult({ notUpdated: { e1: { type: 'rateLimit' } } }),
        })

        await replayOutbox(port, db, ACC, { now: 100, random: NO_JITTER })

        const backedOff = await row('i1')
        expect(backedOff?.status).toBe('pending')
        expect(backedOff?.attempts).toBe(1) // the increment is the whole safety property

        await reapplyPendingCounts(db, ACC, bothFields)
        expect(await counts('inbox')).toEqual({ total: 10, unread: 4 })
      })
    })
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
    // `attempts` DOES advance, and this assertion is the whole reason: it is what marks the row as
    // having been dispatched, so `unsentOutbox` will not re-apply its count delta on top of a server
    // number that might already contain it. Nothing else about the row changes — it is not backed
    // off, not rolled back and not dead-lettered.
    expect(still?.attempts).toBe(1)
    expect(still?.nextAttemptAt).toBeNull() // ready immediately once the session is renewed
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

  /*
   * JMAP gap analysis M-5 / M-6. `sortOrder`, `isSubscribed` and `role` are all mutable Mailbox
   * properties (RFC 8621 §2) and none of them was ever sent: the folder tree wrote them nowhere, so
   * an order made on the laptop was not the order on the phone, and a folder made here was not the
   * Archive anywhere else. These prove the intents reach the wire.
   */
  it('sends a whole sibling group in ONE Mailbox/set (M-5)', async () => {
    await putMailboxes(db, ACC, [mailbox('mb1', { name: 'One' }), mailbox('mb2', { name: 'Two' })])
    await enqueueAction(
      db,
      ACC,
      {
        kind: 'reorderMailboxes',
        order: [
          { id: 'mb2', sortOrder: 1 },
          { id: 'mb1', sortOrder: 2 },
        ],
      },
      { id: 'i1', now: 1 },
    )

    // The optimistic half: the replica already reads in the new order.
    expect((await db.mailboxes.get([ACC, 'mb2']))?.sortOrder).toBe(1)

    const calls: unknown[] = []
    const port = fakePort({
      setMailboxes: async (args) => {
        calls.push(args.update)
        return setResult({ updated: ['mb1', 'mb2'] })
      },
    })
    await replayOutbox(port, db, ACC, { random: NO_JITTER })

    // ONE request, not one per folder — a drag across four rows is a single save (ADR-026).
    expect(calls).toEqual([{ mb2: { sortOrder: 1 }, mb1: { sortOrder: 2 } }])
    expect(await row('i1')).toBeUndefined()
  })

  it('puts the whole group back when the server refuses the order (M-5)', async () => {
    await putMailboxes(db, ACC, [
      mailbox('mb1', { name: 'One', sortOrder: 7 }),
      mailbox('mb2', { name: 'Two', sortOrder: 9 }),
    ])
    await enqueueAction(
      db,
      ACC,
      {
        kind: 'reorderMailboxes',
        order: [
          { id: 'mb2', sortOrder: 1 },
          { id: 'mb1', sortOrder: 2 },
        ],
      },
      { id: 'i1', now: 1 },
    )
    const port = fakePort({
      setMailboxes: async () =>
        setResult({
          notUpdated: { mb1: { type: 'invalidProperties' }, mb2: { type: 'invalidProperties' } },
        }),
    })

    await replayOutbox(port, db, ACC, { random: NO_JITTER })

    expect((await db.mailboxes.get([ACC, 'mb1']))?.sortOrder).toBe(7)
    expect((await db.mailboxes.get([ACC, 'mb2']))?.sortOrder).toBe(9)
  })

  it('subscribes a folder it creates, so the sidebar keeps it (M-5)', async () => {
    // RFC 8621 §2 only SHOULDs this, and Stalwart v0.16.18 does not: a create that omits
    // `isSubscribed` is stored as `false`. Since M-5 the sidebar hides an unsubscribed folder, so
    // omitting it here meant the folder the user just made vanished the moment the server's copy
    // synced back. The optimistic row has always said `true`; this is the wire saying the same.
    await enqueueAction(
      db,
      ACC,
      { kind: 'createMailbox', creationId: 'tmp', props: { name: 'Receipts', parentId: null } },
      { id: 'i1', now: 1 },
    )
    expect((await db.mailboxes.get([ACC, 'tmp']))?.isSubscribed).toBe(true)

    const sent: unknown[] = []
    const port = fakePort({
      setMailboxes: async (args) => {
        sent.push(args.create)
        return setResult({ created: { tmp: { id: 'srv-1' } } })
      },
    })
    await replayOutbox(port, db, ACC, { random: NO_JITTER })

    expect(sent).toEqual([{ tmp: { name: 'Receipts', parentId: null, isSubscribed: true } }])
  })

  it('sends the role and the subscription, and rolls each back on refusal (M-5/M-6)', async () => {
    await putMailboxes(db, ACC, [mailbox('mb1', { name: 'Old mail' })])
    await enqueueAction(
      db,
      ACC,
      { kind: 'updateMailbox', id: 'mb1', props: { role: 'archive' } },
      { id: 'i1', now: 1 },
    )
    await enqueueAction(
      db,
      ACC,
      { kind: 'updateMailbox', id: 'mb1', props: { isSubscribed: false } },
      { id: 'i2', now: 2 },
    )

    expect((await db.mailboxes.get([ACC, 'mb1']))?.role).toBe('archive')
    expect((await db.mailboxes.get([ACC, 'mb1']))?.isSubscribed).toBe(false)

    const sent: unknown[] = []
    const port = fakePort({
      setMailboxes: async (args) => {
        sent.push(args.update)
        // MEASURED refusal shape: a role already taken answers `invalidProperties`. The FIRST
        // intent is refused, the second accepted — so the rollback must be per-row.
        return sent.length === 1
          ? setResult({
              notUpdated: {
                mb1: {
                  type: 'invalidProperties',
                  description: "A mailbox with role 'archive' already exists.",
                },
              },
            })
          : setResult({ updated: ['mb1'] })
      },
    })
    await replayOutbox(port, db, ACC, { random: NO_JITTER })

    expect(sent).toEqual([{ mb1: { role: 'archive' } }, { mb1: { isSubscribed: false } }])
    const after = await db.mailboxes.get([ACC, 'mb1'])
    expect(after?.role).toBeNull() // the refused role went back
    expect(after?.isSubscribed).toBe(false) // the accepted one stayed
  })

  it('rewrites an order/role update queued against a folder created offline (D5)', async () => {
    await enqueueAction(
      db,
      ACC,
      { kind: 'createMailbox', creationId: 'tmp', props: { name: 'New', parentId: null } },
      { id: 'i1', now: 1 },
    )
    await enqueueAction(
      db,
      ACC,
      { kind: 'updateMailbox', id: 'tmp', props: { role: 'archive' } },
      { id: 'i2', now: 2 },
    )
    await enqueueAction(
      db,
      ACC,
      { kind: 'reorderMailboxes', order: [{ id: 'tmp', sortOrder: 1 }] },
      { id: 'i3', now: 3 },
    )
    const port = fakePort({
      setMailboxes: async (args) => {
        if (args.create) return setResult({ created: { tmp: { id: 'srv-9' } } })
        throw new TypeError('fetch failed') // stop the pass so the rewrites can be inspected
      },
    })

    await replayOutbox(port, db, ACC, { random: NO_JITTER })

    const update = (await row('i2'))?.payload as Extract<OutboxIntent, { kind: 'updateMailbox' }>
    const reorder = (await row('i3'))?.payload as Extract<
      OutboxIntent,
      { kind: 'reorderMailboxes' }
    >
    expect(update.id).toBe('srv-9')
    expect(reorder.order).toEqual([{ id: 'srv-9', sortOrder: 1 }])
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
