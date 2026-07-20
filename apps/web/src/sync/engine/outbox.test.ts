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
import { enqueueAction, type OutboxIntent, replayOutbox } from './outbox'
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
