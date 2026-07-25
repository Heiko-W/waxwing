import type { ContactCard } from '@waxwing/jmap'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type ContactCardRow, type ReplicaDb, recordAddressStats } from '../sync'
import { contactCard, email, freshDb } from '../sync/test-utils'
import { createContactSuggestionSource } from './contact-suggestion-source'
import { combineSuggestionSources, createRecentsSuggestionSource } from './recipient-suggestions'

const NOW = 1_760_000_000_000

/** A contact card in the replica-row shape the source consumes (only the read fields matter here). */
function card(id: string, over: Partial<ContactCard>): ContactCardRow {
  return { ...contactCard(id, over), accountId: 'a', abk: [] } as ContactCardRow
}

let db: ReplicaDb
beforeEach(() => {
  db = freshDb()
})
afterEach(async () => {
  await db.delete()
})

describe('createContactSuggestionSource', () => {
  it('matches on name and on email (substring, case-insensitive)', async () => {
    const cards = [
      card('a', { name: { full: 'Alice Adams' }, emails: { e: { address: 'alice@x.test' } } }),
      card('b', { name: { full: 'Bob Baker' }, emails: { e: { address: 'bob@y.test' } } }),
    ]
    const source = createContactSuggestionSource(cards)

    expect((await source.query('adam', 6)).map((s) => s.email)).toEqual(['alice@x.test'])
    expect((await source.query('BOB@', 6)).map((s) => s.email)).toEqual(['bob@y.test'])
    expect(await source.query('zzz', 6)).toEqual([])
  })

  it('carries the display name and the contact photo media through to the suggestion', async () => {
    const cards = [
      card('a', {
        name: { full: 'Ada Lovelace' },
        emails: { e: { address: 'ada@x.test' } },
        media: { m: { kind: 'photo', blobId: 'blob-1' } },
      }),
    ]
    const [suggestion] = await createContactSuggestionSource(cards).query('ada', 6)
    expect(suggestion).toEqual({
      name: 'Ada Lovelace',
      email: 'ada@x.test',
      photo: { kind: 'photo', blobId: 'blob-1' },
    })
  })

  it('excludes group cards even when they match the needle', async () => {
    const cards = [
      card('g', {
        kind: 'group',
        name: { full: 'Team Rocket' },
        emails: { e: { address: 'team@x.test' } },
      }),
      card('p', { name: { full: 'Team Player' }, emails: { e: { address: 'player@x.test' } } }),
    ]
    const result = await createContactSuggestionSource(cards).query('team', 6)
    expect(result.map((s) => s.email)).toEqual(['player@x.test'])
  })

  it('yields exactly one suggestion per address', async () => {
    // One card matched on BOTH its name and its email → still one row; two cards sharing an address
    // collapse to one.
    const cards = [
      card('a', { name: { full: 'Bob Bob' }, emails: { e: { address: 'bob@x.test' } } }),
      card('b', { name: { full: 'Bobby Clone' }, emails: { e: { address: 'bob@x.test' } } }),
    ]
    const result = await createContactSuggestionSource(cards).query('bob', 6)
    expect(result).toHaveLength(1)
    expect(result[0]?.email).toBe('bob@x.test')
  })

  it('ranks by usage (addressStats) and falls back to alphabetical without a replica', async () => {
    const cards = [
      card('a', { name: { full: 'Anna' }, emails: { e: { address: 'anna@x.test' } } }),
      card('z', { name: { full: 'Zoe' }, emails: { e: { address: 'zoe@x.test' } } }),
    ]
    // Zoe is a frequent correspondent; Anna is not in addressStats at all.
    await db.addressStats.put({
      accountId: 'a',
      emailLower: 'zoe@x.test',
      email: 'zoe@x.test',
      name: 'Zoe',
      sentCount: 10,
      receivedCount: 0,
      lastSeenAt: NOW,
    })

    const withUsage = createContactSuggestionSource(cards, {
      db,
      accountId: 'a',
      now: () => NOW,
    })
    expect((await withUsage.query('x.test', 6)).map((s) => s.email)).toEqual([
      'zoe@x.test', // usage beats the alphabetically-earlier Anna
      'anna@x.test',
    ])

    const alphaOnly = createContactSuggestionSource(cards)
    expect((await alphaOnly.query('x.test', 6)).map((s) => s.email)).toEqual([
      'anna@x.test', // no replica → pure alphabetical
      'zoe@x.test',
    ])
  })
})

describe('contacts merged with recents', () => {
  it('a contact beats a stale recent for the same address (name + order)', async () => {
    // A recent harvested a bare "Bob" for bob@work.test…
    await recordAddressStats(db, 'a', [
      email('e1', {
        from: [{ name: 'Bob', email: 'bob@work.test' }],
        to: [],
        cc: [],
        receivedAt: '2026-07-01T00:00:00Z',
      }),
    ])
    // …while the address book knows the full name.
    const cards = [
      card('c', { name: { full: 'Robert Smith' }, emails: { e: { address: 'bob@work.test' } } }),
    ]

    const merged = combineSuggestionSources([
      createContactSuggestionSource(cards, { db, accountId: 'a', now: () => NOW }),
      createRecentsSuggestionSource(db, 'a'),
    ])

    const result = await merged.query('bob', 6)
    // Deduped to a single row for the shared address, and the contact (first source) wins.
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ name: 'Robert Smith', email: 'bob@work.test' })
  })
})
