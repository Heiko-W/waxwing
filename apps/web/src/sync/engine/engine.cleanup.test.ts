import type { Session } from '@waxwing/jmap'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ReplicaDb } from '../db'
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
    config: { cacheDays: 30, maxStorageMB: 512 },
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
