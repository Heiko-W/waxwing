import type { Session } from '@waxwing/jmap'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ReplicaDb } from '../db'
import { putQueryCache } from '../repo'
import { freshDb } from '../test-utils'
import { SyncEngine, type SyncEngineDeps } from './engine'
import type { EmailQuerySpec, JmapPort, QueryResult } from './types'

const ACC = 'acc'

/** A session advertising a small `maxObjectsInSet` so chunking is observable with few ids. */
function sessionWithCap(maxObjectsInSet: number): Session {
  return {
    capabilities: {
      'urn:ietf:params:jmap:core': {
        maxSizeRequest: 1,
        maxCallsInRequest: 1,
        maxObjectsInGet: 1,
        maxObjectsInSet,
      },
    },
  } as unknown as Session
}

function makeEngine(
  db: ReplicaDb,
  ids: string[],
  cap: number,
  pageSize?: number,
): { engine: SyncEngine; queries: EmailQuerySpec[] } {
  const queries: EmailQuerySpec[] = []
  const port = {
    accountId: ACC,
    async queryEmails(spec: EmailQuerySpec): Promise<QueryResult> {
      queries.push(spec)
      const position = spec.position ?? 0
      // `pageSize` (when set) caps the page BELOW the requested `limit`, simulating a server that
      // returns fewer than asked while more results match — the total-driven paging must not stop.
      const limit = pageSize ?? spec.limit ?? ids.length
      const page = ids.slice(position, position + limit)
      return { ids: page, queryState: 'q', canCalculateChanges: true, position, total: ids.length }
    },
  } as unknown as JmapPort

  const deps: SyncEngineDeps = {
    db,
    port,
    session: sessionWithCap(cap),
    auth: { scheme: 'bearer', authorization: () => 'x' },
    config: () => ({ cacheDays: 30, maxStorageMB: 512 }),
    clock: { now: () => 1, setTimeout: () => 0, clearTimeout: () => {} },
    locks: { request: () => Promise.resolve() } as unknown as SyncEngineDeps['locks'],
    createBus: () => ({ postMessage() {}, close() {}, onmessage: null }),
    createPush: () => ({}) as unknown as ReturnType<SyncEngineDeps['createPush']>,
    isOnline: () => true,
    onOnlineChange: () => () => {},
  }
  return { engine: new SyncEngine(deps), queries }
}

let db: ReplicaDb
beforeEach(() => {
  db = freshDb()
})
afterEach(async () => {
  await db.delete()
})

describe('SyncEngine cleanup — destroyMatching', () => {
  it('empties a mailbox as chunked destroyEmails intents, each ≤ maxObjectsInSet, never ifInState', async () => {
    const { engine, queries } = makeEngine(db, ['e1', 'e2', 'e3', 'e4', 'e5'], 2)

    const result = await engine.emptyMailbox('inbox')
    expect(result).toEqual({ scheduled: 5 })

    // The query pages oldest-first over the target mailbox.
    expect(queries[0]?.filter).toEqual({ inMailbox: 'inbox' })
    expect(queries[0]?.sort).toEqual([{ property: 'receivedAt', isAscending: true }])

    const rows = await db.outbox.where('accountId').equals(ACC).toArray()
    expect(rows).toHaveLength(3) // 5 ids / cap 2 → [2,2,1]
    for (const row of rows) {
      expect(row.type).toBe('destroyEmails')
      expect(row.ifInState).toBeNull()
      const payload = row.payload as { kind: string; emailIds: string[] }
      expect(payload.kind).toBe('destroyEmails')
      expect(payload.emailIds.length).toBeLessThanOrEqual(2)
    }
    const scheduledIds = rows.flatMap((row) => (row.payload as { emailIds: string[] }).emailIds)
    expect(new Set(scheduledIds)).toEqual(new Set(['e1', 'e2', 'e3', 'e4', 'e5']))
  })

  it('collects ALL ids across short pages (server returns fewer than limit) — total-driven', async () => {
    // Each page returns only 2 ids though `limit` is 500 and total is 5; must NOT stop at page 1.
    const { engine, queries } = makeEngine(db, ['e1', 'e2', 'e3', 'e4', 'e5'], 500, 2)

    const result = await engine.emptyMailbox('inbox')

    expect(result).toEqual({ scheduled: 5 })
    expect(queries.length).toBe(3) // 2 + 2 + 1
    const rows = await db.outbox.where('accountId').equals(ACC).toArray()
    const scheduledIds = rows.flatMap((row) => (row.payload as { emailIds: string[] }).emailIds)
    expect(new Set(scheduledIds)).toEqual(new Set(['e1', 'e2', 'e3', 'e4', 'e5']))
  })

  it('deleteOlderThan builds an AND(inMailbox, before) filter', async () => {
    const { engine, queries } = makeEngine(db, ['e1'], 500)
    await engine.deleteOlderThan('inbox', '2026-01-01T00:00:00.000Z')
    expect(queries.at(-1)?.filter).toEqual({
      operator: 'AND',
      conditions: [{ inMailbox: 'inbox' }, { before: '2026-01-01T00:00:00.000Z' }],
    })
  })

  it('trashOlderThan MOVES matched messages to the Trash (move intents, from→to), never destroys', async () => {
    const { engine, queries } = makeEngine(db, ['e1', 'e2', 'e3'], 2)

    const result = await engine.trashOlderThan('inbox', 'trash', '2026-01-01T00:00:00.000Z')

    expect(result).toEqual({ scheduled: 3 })
    expect(queries.at(-1)?.filter).toEqual({
      operator: 'AND',
      conditions: [{ inMailbox: 'inbox' }, { before: '2026-01-01T00:00:00.000Z' }],
    })
    const rows = await db.outbox.where('accountId').equals(ACC).toArray()
    expect(rows).toHaveLength(2) // 3 ids / cap 2
    for (const row of rows) {
      expect(row.type).toBe('move')
      expect(row.ifInState).toBeNull()
      const payload = row.payload as { kind: string; from: string; to: string; emailIds: string[] }
      expect(payload.kind).toBe('move')
      expect(payload.from).toBe('inbox')
      expect(payload.to).toBe('trash')
    }
  })
})

/**
 * `collectQueryIds` — "select all in folder" (FR-LST-04, R-08 stage 2).
 *
 * The same paginator the cleanup above uses, pointed at a WATCHED WINDOW instead of a filter, so the
 * list can hand the whole query's ids to the selection. Two properties carry the weight: the spec
 * comes off the cached window row (a re-derived one would select a different set from the one on
 * screen — `collapseThreads` alone changes which id per thread comes back), and a query bigger than
 * the caller's cap is reported as INCOMPLETE rather than silently truncated.
 */
describe('SyncEngine collectQueryIds — select-all over the query', () => {
  const SPEC = {
    filter: { operator: 'AND' as const, conditions: [{ inMailbox: 'inbox' }] },
    sort: [{ property: 'receivedAt' as const, isAscending: false }],
    collapseThreads: true,
  }

  async function seedWindow(ids: string[]): Promise<void> {
    await putQueryCache(db, {
      accountId: ACC,
      key: 'w',
      ids: ids.slice(0, 2),
      queryState: 'q',
      total: ids.length,
      upToId: ids[1] ?? null,
      filter: SPEC.filter,
      sort: SPEC.sort,
      collapseThreads: SPEC.collapseThreads,
      lastUsedAt: 1,
    })
  }

  it('pages the window’s OWN filter, sort and threading — not a re-derived query', async () => {
    const { engine, queries } = makeEngine(db, ['e1', 'e2', 'e3'], 500)
    await seedWindow(['e1', 'e2', 'e3'])

    const result = await engine.collectQueryIds('w', { max: 100 })

    expect(result).toEqual({ ids: ['e1', 'e2', 'e3'], complete: true })
    expect(queries[0]?.filter).toEqual(SPEC.filter)
    expect(queries[0]?.sort).toEqual(SPEC.sort)
    expect(queries[0]?.collapseThreads).toBe(true)
    // Ids only: the envelopes arrive when the list pages them in, not because 300 rows were ticked.
    expect(queries[0]?.calculateTotal).toBe(true)
  })

  it('walks short pages to the total, and de-duplicates what a shifting query repeats', async () => {
    // A message arriving mid-paging shifts the tail right, so the same id can come back on two
    // pages. It must count once — `ids.length` is what the bar then says out loud.
    const seen: number[] = []
    const port = {
      accountId: ACC,
      async queryEmails(spec: EmailQuerySpec): Promise<QueryResult> {
        const position = spec.position ?? 0
        seen.push(position)
        const pages: Record<number, string[]> = { 0: ['e1', 'e2'], 2: ['e2', 'e3'], 4: [] }
        return {
          ids: pages[position] ?? [],
          queryState: 'q',
          canCalculateChanges: true,
          position,
          total: 4,
        }
      },
    } as unknown as JmapPort
    const { engine } = makeEngine(db, [], 500)
    ;(engine as unknown as { port: JmapPort }).port = port
    await seedWindow(['e1', 'e2'])

    const result = await engine.collectQueryIds('w', { max: 100 })

    // Three ids for a `total` of four, and that is the honest answer rather than a bug: paging by
    // position across a query that is being edited can repeat an id, and the selection then holds
    // one fewer than the folder claims. The bar states the size it HOLDS, so nothing over-promises.
    expect(result).toEqual({ ids: ['e1', 'e2', 'e3'], complete: true })
    // Two requests, not three: paging stops on the server's own `total` (positions consumed), so a
    // repeat does not buy an extra round trip.
    expect(seen).toEqual([0, 2])
  })

  it('stops at the cap and says the answer is INCOMPLETE', async () => {
    const { engine } = makeEngine(db, ['e1', 'e2', 'e3', 'e4', 'e5'], 500, 2)
    await seedWindow(['e1', 'e2'])

    expect(await engine.collectQueryIds('w', { max: 3 })).toEqual({
      ids: ['e1', 'e2', 'e3'],
      complete: false,
    })
  })

  it('refuses a key it has no window for', async () => {
    const { engine } = makeEngine(db, ['e1'], 500)
    await expect(engine.collectQueryIds('nope', { max: 10 })).rejects.toThrow(/no query cache/)
  })
})
