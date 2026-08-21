import type { ContactCard } from '@waxwing/jmap'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type ContactCardRow, type ReplicaDb, recordAddressStats } from '../sync'
import { contactCard, email, freshDb } from '../sync/test-utils'
import { createContactSuggestionSource } from './contact-suggestion-source'
import {
  combineSuggestionSources,
  createRecentsSuggestionSource,
  type RecipientSuggestion,
  suggestionAddresses,
} from './recipient-suggestions'

/**
 * The addresses a list of options would commit to. Read through `suggestionAddresses` rather than
 * off `.email`, because an option is no longer always ONE address: a contact group carries its
 * members instead (A-4).
 */
const emails = (list: readonly RecipientSuggestion[]): string[] =>
  list.flatMap(suggestionAddresses).map((address) => address.email)

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

    expect(emails(await source.query('adam', 6))).toEqual(['alice@x.test'])
    expect(emails(await source.query('BOB@', 6))).toEqual(['bob@y.test'])
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

  it('never offers a group as an address of its own', async () => {
    // A group card can carry an `emails` map (an import may put one there); it is still not a
    // mailbox the server would deliver to. It may only ever appear as a GROUP option.
    const cards = [
      card('g', {
        kind: 'group',
        uid: 'u-g',
        name: { full: 'Team Rocket' },
        emails: { e: { address: 'team@x.test' } },
      }),
      card('p', { name: { full: 'Team Player' }, emails: { e: { address: 'player@x.test' } } }),
    ]
    const result = await createContactSuggestionSource(cards).query('team', 6)
    // The group has no resolvable member, so it is not offered at all — and never as `team@x.test`.
    expect(result.map((s) => s.kind ?? 'address')).toEqual(['address'])
    expect(emails(result)).toEqual(['player@x.test'])
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
    expect(emails(result)).toEqual(['bob@x.test'])
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
    expect(emails(await withUsage.query('x.test', 6))).toEqual([
      'zoe@x.test', // usage beats the alphabetically-earlier Anna
      'anna@x.test',
    ])

    const alphaOnly = createContactSuggestionSource(cards)
    expect(emails(await alphaOnly.query('x.test', 6))).toEqual([
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

/**
 * A-4 of the JMAP gap analysis: a contact GROUP as a recipient.
 *
 * Groups could be created and maintained, and `expandGroup` had been written for exactly this —
 * with no consumer. Typing a list's name into a recipient field matched nothing, which is the whole
 * point of having a list.
 */
describe('a contact group as a recipient option (A-4)', () => {
  const alice = card('a', {
    uid: 'u-alice',
    name: { full: 'Alice Adams' },
    emails: { e: { address: 'alice@x.test' } },
  })
  const bob = card('b', {
    uid: 'u-bob',
    name: { full: 'Bob Baker' },
    emails: { e: { address: 'bob@x.test' } },
  })
  const team = card('g', {
    uid: 'u-team',
    kind: 'group',
    name: { full: 'Rocket Team' },
    members: { 'u-alice': true, 'u-bob': true },
  })

  it('offers the group and expands it to its members', async () => {
    const result = await createContactSuggestionSource([alice, bob, team]).query('rocket', 6)
    expect(result).toHaveLength(1)
    const [group] = result
    expect(group).toMatchObject({ kind: 'group', uid: 'u-team', name: 'Rocket Team' })
    // The expansion is what commits — the addresses, not the group.
    expect(emails(result)).toEqual(['alice@x.test', 'bob@x.test'])
  })

  it('skips a member the replica cannot resolve, and a member with no address', async () => {
    const silent = card('s', { uid: 'u-silent', name: { full: 'Silent Sam' } })
    const partial = card('g2', {
      uid: 'u-partial',
      kind: 'group',
      name: { full: 'Rocket Partial' },
      members: { 'u-alice': true, 'u-silent': true, 'u-nobody': true },
    })
    const result = await createContactSuggestionSource([alice, silent, partial]).query('partial', 6)
    expect(emails(result)).toEqual(['alice@x.test'])
  })

  it('does not offer a group that would add nothing', async () => {
    const empty = card('g3', { uid: 'u-empty', kind: 'group', name: { full: 'Rocket Empty' } })
    expect(await createContactSuggestionSource([empty]).query('rocket', 6)).toEqual([])
  })

  it('lists the group ahead of the people, and still respects the limit', async () => {
    // A group ranked by the usage join would lose to any frequent correspondent and drop off a
    // six-row listbox exactly when it was being typed toward.
    const rocketPerson = card('r', {
      uid: 'u-rocket',
      name: { full: 'Rocket Ronny' },
      emails: { e: { address: 'ronny@x.test' } },
    })
    const source = createContactSuggestionSource([alice, bob, team, rocketPerson])
    const result = await source.query('rocket', 2)
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ kind: 'group', name: 'Rocket Team' })
    expect(result[1]).toMatchObject({ email: 'ronny@x.test' })
  })

  it('matches a group on its NAME, not through its members', async () => {
    // The group card holds `members`, not emails — a needle that matches a member must surface the
    // MEMBER, and not silently drag the whole list in behind them.
    const result = await createContactSuggestionSource([alice, bob, team]).query('alice', 6)
    expect(result.map((s) => s.kind ?? 'address')).toEqual(['address'])
    expect(emails(result)).toEqual(['alice@x.test'])
  })

  it('keeps its identity when sources are merged (dedup is by uid, not by an address it has none of)', async () => {
    const merged = combineSuggestionSources([
      createContactSuggestionSource([alice, bob, team]),
      createContactSuggestionSource([alice, bob, team]),
    ])
    const result = await merged.query('rocket', 6)
    expect(result).toHaveLength(1)
  })
})
