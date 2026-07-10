import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ReplicaDb } from '../db'
import { getQueryCache, getSyncState } from '../repo'
import { email, freshDb, thread } from '../test-utils'
import { backfillMailbox, loadMore, windowFilter } from './backfill'
import type { JmapPort, QueryResult } from './types'

let db: ReplicaDb
const ACC = 'acc'
const NOW = Date.UTC(2026, 6, 10) // 2026-07-10T00:00:00Z

beforeEach(() => {
  db = freshDb()
})

afterEach(async () => {
  await db.delete()
})

/** A JmapPort whose methods throw unless overridden — backfill only uses three. */
function fakePort(overrides: Partial<JmapPort>): JmapPort {
  const unimplemented = (name: string) => (): never => {
    throw new Error(`not implemented: ${name}`)
  }
  return {
    accountId: ACC,
    mailboxChanges: unimplemented('mailboxChanges'),
    threadChanges: unimplemented('threadChanges'),
    emailChanges: unimplemented('emailChanges'),
    getMailboxes: unimplemented('getMailboxes'),
    getThreads: unimplemented('getThreads'),
    getEmailEnvelopes: unimplemented('getEmailEnvelopes'),
    queryEmails: unimplemented('queryEmails'),
    queryEmailChanges: unimplemented('queryEmailChanges'),
    setEmails: unimplemented('setEmails'),
    setMailboxes: unimplemented('setMailboxes'),
    ...overrides,
  } as JmapPort
}

const query = (ids: string[], queryState: string, total: number): QueryResult => ({
  ids,
  queryState,
  canCalculateChanges: true,
  position: 0,
  total,
})

describe('windowFilter', () => {
  it('builds an AND(inMailbox, after) recent window', () => {
    expect(windowFilter('inbox', 30, NOW)).toEqual({
      operator: 'AND',
      conditions: [
        { inMailbox: 'inbox' },
        { after: new Date(NOW - 30 * 86_400_000).toISOString() },
      ],
    })
  })
})

describe('backfillMailbox', () => {
  it('seeds the query window, emails, threads and Email sync state', async () => {
    const port = fakePort({
      queryEmails: async () => query(['e1', 'e2'], 'qs1', 2),
      getEmailEnvelopes: async (ids) => ({
        list: ids.map((id) => email(id)),
        notFound: [],
        state: 'estate1',
      }),
      getThreads: async (ids) => ({
        list: ids.map((id) => thread(id, [])),
        notFound: [],
        state: 'ts1',
      }),
    })

    const res = await backfillMailbox(port, db, ACC, 'inbox', {
      cacheDays: 30,
      limit: 50,
      now: NOW,
    })

    expect(res.ids).toEqual(['e1', 'e2'])
    const row = await getQueryCache(db, ACC, res.key)
    expect(row?.ids).toEqual(['e1', 'e2'])
    expect(row?.queryState).toBe('qs1')
    expect(row?.upToId).toBe('e2')
    expect(row?.total).toBe(2)
    expect(await db.emails.count()).toBe(2)
    // e1/e2 default to threads t-e1/t-e2 → two distinct threads fetched.
    expect(await db.threads.count()).toBe(2)
    expect(await getSyncState(db, ACC, 'Email')).toBe('estate1')
  })

  it('does not overwrite an existing Email sync state', async () => {
    const port = fakePort({
      queryEmails: async () => query(['e1'], 'qs', 1),
      getEmailEnvelopes: async (ids) => ({
        list: ids.map((id) => email(id)),
        notFound: [],
        state: 'fresh',
      }),
      getThreads: async (ids) => ({
        list: ids.map((id) => thread(id, [])),
        notFound: [],
        state: 'ts',
      }),
    })
    // Pretend delta already advanced the Email state.
    await db.syncState.put({ accountId: ACC, type: 'Email', state: 'already', updatedAt: 1 })

    await backfillMailbox(port, db, ACC, 'inbox', { cacheDays: 30, limit: 50, now: NOW })

    expect(await getSyncState(db, ACC, 'Email')).toBe('already')
  })
})

describe('loadMore', () => {
  it('appends the next page, dedupes overlap and extends upToId', async () => {
    let call = 0
    const port = fakePort({
      queryEmails: async () => {
        call += 1
        return call === 1 ? query(['e1', 'e2'], 'qs1', 5) : query(['e2', 'e3', 'e4'], 'qs2', 5)
      },
      getEmailEnvelopes: async (ids) => ({
        list: ids.map((id) => email(id)),
        notFound: [],
        state: 'st',
      }),
      getThreads: async (ids) => ({
        list: ids.map((id) => thread(id, [])),
        notFound: [],
        state: 'ts',
      }),
    })

    const { key } = await backfillMailbox(port, db, ACC, 'inbox', {
      cacheDays: 30,
      limit: 2,
      now: NOW,
    })
    const res = await loadMore(port, db, ACC, key, { limit: 2, now: NOW + 1 })

    expect(res.added).toBe(2) // e3, e4 (e2 deduped)
    const row = await getQueryCache(db, ACC, key)
    expect(row?.ids).toEqual(['e1', 'e2', 'e3', 'e4'])
    expect(row?.upToId).toBe('e4')
    expect(row?.queryState).toBe('qs2')
  })
})
