import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearAccount, type ReplicaDb } from './db'
import { recordAddressStats, suggestAddresses } from './repo'
import { email, freshDb } from './test-utils'

let db: ReplicaDb
beforeEach(() => {
  db = freshDb()
})
afterEach(async () => {
  await db.delete()
})

const from = (name: string | null, addr: string) => [{ name, email: addr }]

describe('recordAddressStats', () => {
  it('harvests from/to/cc for a received message and increments counts', async () => {
    await recordAddressStats(db, 'a', [
      email('e1', {
        from: from('Al', 'al@x.com'),
        to: [{ name: null, email: 'me@x.com' }],
        cc: [{ name: 'C', email: 'c@x.com' }],
        receivedAt: '2026-07-01T00:00:00Z',
      }),
    ])
    const al = await db.addressStats.get(['a', 'al@x.com'])
    expect(al?.receivedCount).toBe(1)
    expect(al?.name).toBe('Al')
    expect(await db.addressStats.get(['a', 'c@x.com'])).toBeDefined()
    expect(await db.addressStats.get(['a', 'me@x.com'])).toBeDefined()
  })

  it('keeps lastSeenAt monotonic while counts accumulate on re-run', async () => {
    const newer = email('e1', {
      from: from(null, 'al@x.com'),
      to: [],
      cc: [],
      receivedAt: '2026-07-05T00:00:00Z',
    })
    await recordAddressStats(db, 'a', [newer])
    const older = email('e2', {
      from: from(null, 'al@x.com'),
      to: [],
      cc: [],
      receivedAt: '2026-07-01T00:00:00Z',
    })
    await recordAddressStats(db, 'a', [older])
    const row = await db.addressStats.get(['a', 'al@x.com'])
    expect(row?.lastSeenAt).toBe(Date.parse('2026-07-05T00:00:00Z'))
    expect(row?.receivedCount).toBe(2)
  })

  it('classifies sent when the user is the sender', async () => {
    await recordAddressStats(
      db,
      'a',
      [
        email('e1', {
          from: from(null, 'me@x.com'),
          to: [{ name: null, email: 'them@y.com' }],
          cc: [],
          receivedAt: '2026-07-01T00:00:00Z',
        }),
      ],
      new Set(['me@x.com']),
    )
    const them = await db.addressStats.get(['a', 'them@y.com'])
    expect(them?.sentCount).toBe(1)
    expect(them?.receivedCount).toBe(0)
    expect(await db.addressStats.get(['a', 'me@x.com'])).toBeUndefined()
  })
})

describe('suggestAddresses', () => {
  it('returns recency-ordered, prefix-filtered candidates', async () => {
    await recordAddressStats(db, 'a', [
      email('e1', {
        from: from(null, 'alice@x.com'),
        to: [],
        cc: [],
        receivedAt: '2026-07-01T00:00:00Z',
      }),
      email('e2', {
        from: from(null, 'bob@x.com'),
        to: [],
        cc: [],
        receivedAt: '2026-07-02T00:00:00Z',
      }),
    ])
    const all = await suggestAddresses(db, 'a', '')
    expect(all[0]?.emailLower).toBe('bob@x.com')
    expect((await suggestAddresses(db, 'a', 'ali')).map((r) => r.emailLower)).toEqual([
      'alice@x.com',
    ])
  })
})

describe('addressStats schema (v2)', () => {
  it('opens at schema version ≥ 2 with the addressStats store', async () => {
    await db.open()
    expect(db.verno).toBeGreaterThanOrEqual(2)
    expect(db.tables.some((table) => table.name === 'addressStats')).toBe(true)
  })

  it('clearAccount removes the account addressStats', async () => {
    await recordAddressStats(db, 'a', [
      email('e1', {
        from: from(null, 'x@x.com'),
        to: [],
        cc: [],
        receivedAt: '2026-07-01T00:00:00Z',
      }),
    ])
    expect(await db.addressStats.count()).toBe(1)
    await clearAccount(db, 'a')
    expect(await db.addressStats.count()).toBe(0)
  })
})
