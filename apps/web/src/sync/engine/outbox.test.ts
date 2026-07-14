import { type EmailCreate, type EmailFilter, JmapHttpError, JmapMethodError } from '@waxwing/jmap'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DraftRow, OutboxRow, QueryCacheRow, ReplicaDb } from '../db'
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
      prunedKeys: [], // no cached window in this test — nothing to prune
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

  const inbox = (id: string) => email(id, { mailboxIds: { inbox: true } })

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
   * The DESTINATION half. A message that ARRIVES in a folder has to appear in that folder's list, and
   * only the server can say WHERE: the window is in its collation, and with `collapseThreads` the
   * entries are thread representatives. So the window is marked for a full re-query — never spliced at
   * an index we guessed.
   */
  it('a move VOIDS the DESTINATION windows — the arrival is the server’s to place', async () => {
    await putEmails(db, ACC, [inbox('e1'), inbox('e2')])
    await putQueryCache(db, windowRow('inbox-win', inMailboxFilter('inbox'), ['e1', 'e2']))
    await putQueryCache(db, windowRow('archive-win', inMailboxFilter('archive'), ['e9']))
    await putQueryCache(db, windowRow('later-win', inMailboxFilter('later'), ['e9']))

    await enqueueAction(
      db,
      ACC,
      { kind: 'move', emailIds: ['e1'], from: 'inbox', to: 'archive' },
      { id: 'i1', now: 1 },
    )

    // The destination keeps its ids (we do not know where `e1` goes) but loses its delta cursor, so
    // the next reconcile re-queries it in full and picks the message up in the server's order.
    expect((await win('archive-win'))?.ids).toEqual(['e9'])
    expect((await win('archive-win'))?.queryState).toBeNull()
    // A window pinned to a THIRD mailbox is neither source nor destination: nothing about it changed,
    // so it keeps its cheap delta.
    expect((await win('later-win'))?.ids).toEqual(['e9'])
    expect((await win('later-win'))?.queryState).toBe('q-1')
    // The destination is NOT recorded in the undo: nothing was edited there, so a rollback owes it
    // nothing — a re-query of an unedited window returns the truth whatever the server answered.
    expect(await prunedKeys('i1')).toEqual(['inbox-win'])
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
    await putEmails(db, ACC, [inbox('e1'), inbox('e2')])
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
    // The window cannot place the row itself — but it is now marked for a full re-query (as the
    // DESTINATION of the inverse move), which is the only thing that can.
    expect((await win('inbox-win'))?.ids).toEqual(['e2'])
    expect((await win('inbox-win'))?.queryState).toBeNull()

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
