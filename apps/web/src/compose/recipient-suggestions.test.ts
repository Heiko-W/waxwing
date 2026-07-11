import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type ReplicaDb, recordAddressStats } from '../sync'
import { email, freshDb } from '../sync/test-utils'
import {
  combineSuggestionSources,
  createRecentsSuggestionSource,
  EMPTY_SUGGESTION_SOURCE,
  scoreAddressStat,
} from './recipient-suggestions'

let db: ReplicaDb
beforeEach(() => {
  db = freshDb()
})
afterEach(async () => {
  await db.delete()
})

const NOW = 1_760_000_000_000
const stat = (over: Partial<Parameters<typeof scoreAddressStat>[0]>) => ({
  accountId: 'a',
  emailLower: 'x@x.com',
  email: 'x@x.com',
  name: null,
  sentCount: 0,
  receivedCount: 0,
  lastSeenAt: NOW,
  ...over,
})

describe('scoreAddressStat', () => {
  it('weights sent higher than received', () => {
    expect(scoreAddressStat(stat({ sentCount: 1 }), NOW)).toBeGreaterThan(
      scoreAddressStat(stat({ receivedCount: 1 }), NOW),
    )
  })

  it('recent beats old at equal frequency', () => {
    const recent = stat({ receivedCount: 5 })
    const old = stat({ receivedCount: 5, lastSeenAt: NOW - 90 * 86_400_000 })
    expect(scoreAddressStat(recent, NOW)).toBeGreaterThan(scoreAddressStat(old, NOW))
  })
})

describe('createRecentsSuggestionSource', () => {
  it('prefix-matches on email + name, ranks by recency, caps to limit', async () => {
    await recordAddressStats(db, 'a', [
      email('e1', {
        from: [{ name: 'Alice', email: 'alice@x.com' }],
        to: [],
        cc: [],
        receivedAt: '2026-07-01T00:00:00Z',
      }),
      email('e2', {
        from: [{ name: 'Albert', email: 'albert@y.com' }],
        to: [],
        cc: [],
        receivedAt: '2026-07-05T00:00:00Z',
      }),
      email('e3', {
        from: [{ name: 'Bob', email: 'bob@z.com' }],
        to: [],
        cc: [],
        receivedAt: '2026-07-02T00:00:00Z',
      }),
    ])
    const source = createRecentsSuggestionSource(db, 'a')

    const byEmail = await source.query('al', 10)
    expect(byEmail.map((a) => a.email)).toEqual(
      expect.arrayContaining(['alice@x.com', 'albert@y.com']),
    )
    expect(byEmail[0]?.email).toBe('albert@y.com') // more recent → ranked first

    const byName = await source.query('bob', 10)
    expect(byName.map((a) => a.email)).toContain('bob@z.com')

    expect(await source.query('', 2)).toHaveLength(2)
  })
})

describe('combineSuggestionSources', () => {
  it('merges + dedups by lowercased email, caps to limit', async () => {
    const s1 = {
      query: async () => [
        { name: null, email: 'a@x.com' },
        { name: null, email: 'b@x.com' },
      ],
    }
    const s2 = {
      query: async () => [
        { name: 'A', email: 'A@X.com' },
        { name: null, email: 'c@x.com' },
      ],
    }
    const result = await combineSuggestionSources([s1, s2]).query('', 10)
    expect(result.map((a) => a.email)).toEqual(['a@x.com', 'b@x.com', 'c@x.com'])
  })

  it('EMPTY_SUGGESTION_SOURCE yields nothing', async () => {
    expect(await EMPTY_SUGGESTION_SOURCE.query('x', 5)).toEqual([])
  })
})
