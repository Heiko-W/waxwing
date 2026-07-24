import { describe, expect, it } from 'vitest'
import type { CardLike } from './contact-fields'
import { expandGroupMembers, indexCardsByUid } from './expand-group'

const alice: CardLike = {
  uid: 'u-alice',
  name: { full: 'Alice Anderson' },
  emails: { e1: { address: 'alice@x.test' } },
}
// Two emails, the preferred one (pref 1) sorts first regardless of map order.
const bob: CardLike = {
  uid: 'u-bob',
  name: { full: 'Bob Brown' },
  emails: {
    e1: { address: 'bob-work@x.test', pref: 2 },
    e2: { address: 'bob@x.test', pref: 1 },
  },
}
// No email — must be skipped, never emitted with an empty address.
const carol: CardLike = { uid: 'u-carol', name: { full: 'Carol Clark' } }
// No name — yields a null recipient name.
const nameless: CardLike = { uid: 'u-x', emails: { e1: { address: 'x@x.test' } } }

function resolverFor(cards: CardLike[]): (uid: string) => CardLike | undefined {
  const index = indexCardsByUid(cards)
  return (uid) => index.get(uid)
}

describe('expandGroupMembers', () => {
  it('resolves each member uid to its preferred email in the JMAP address shape', () => {
    const resolve = resolverFor([alice, bob])
    expect(expandGroupMembers(['u-alice', 'u-bob'], resolve)).toEqual([
      { name: 'Alice Anderson', email: 'alice@x.test' },
      { name: 'Bob Brown', email: 'bob@x.test' },
    ])
  })

  it('skips a member that has no email', () => {
    const resolve = resolverFor([alice, carol])
    expect(expandGroupMembers(['u-alice', 'u-carol'], resolve)).toEqual([
      { name: 'Alice Anderson', email: 'alice@x.test' },
    ])
  })

  it('ignores a member uid the replica cannot resolve', () => {
    const resolve = resolverFor([alice])
    expect(expandGroupMembers(['u-alice', 'u-ghost'], resolve)).toEqual([
      { name: 'Alice Anderson', email: 'alice@x.test' },
    ])
  })

  it('emits a null name when the member card has none', () => {
    const resolve = resolverFor([nameless])
    expect(expandGroupMembers(['u-x'], resolve)).toEqual([{ name: null, email: 'x@x.test' }])
  })

  it('collapses duplicate emails (case-insensitive), keeping the first', () => {
    const dupe: CardLike = { uid: 'u-dupe', emails: { e1: { address: 'ALICE@x.test' } } }
    const resolve = resolverFor([alice, dupe])
    expect(expandGroupMembers(['u-alice', 'u-dupe'], resolve)).toEqual([
      { name: 'Alice Anderson', email: 'alice@x.test' },
    ])
  })

  it('returns [] for an empty member list', () => {
    expect(expandGroupMembers([], resolverFor([alice]))).toEqual([])
  })
})

describe('indexCardsByUid', () => {
  it('keys cards by their JSContact uid and skips cards without one', () => {
    const index = indexCardsByUid([alice, bob, { name: { full: 'no uid' } } as CardLike])
    expect(index.get('u-alice')).toBe(alice)
    expect(index.get('u-bob')).toBe(bob)
    expect(index.size).toBe(2)
  })
})
