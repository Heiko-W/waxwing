import type { ContactCard } from '@waxwing/jmap'
import { describe, expect, it } from 'vitest'
import type { CardLike } from '../contacts/contact-fields'
import {
  findCardByEmail,
  pickWritableBook,
  senderToContactCard,
  type WritableBookLike,
} from './sender-contact'

const card = (over: Partial<CardLike> & Pick<CardLike, 'emails'>): CardLike => over

describe('findCardByEmail', () => {
  const cards: CardLike[] = [
    { emails: { e1: { address: 'alice@x.test' } } },
    { emails: { e1: { address: 'bob@x.test', pref: 1 }, e2: { address: 'bob@work.test' } } },
  ]

  it('matches case-insensitively over any address on the card, not just the primary', () => {
    expect(findCardByEmail(cards, 'ALICE@X.TEST')).toBe(cards[0])
    // The second address on the card still matches, though it is not the preferred one.
    expect(findCardByEmail(cards, 'Bob@Work.Test')).toBe(cards[1])
  })

  it('trims surrounding whitespace before comparing', () => {
    expect(findCardByEmail(cards, '  alice@x.test  ')).toBe(cards[0])
  })

  it('returns undefined when nothing matches or the needle is empty', () => {
    expect(findCardByEmail(cards, 'carol@x.test')).toBeUndefined()
    expect(findCardByEmail(cards, '')).toBeUndefined()
    expect(findCardByEmail([card({ emails: {} })], 'alice@x.test')).toBeUndefined()
  })
})

describe('pickWritableBook', () => {
  const book = (
    over: Partial<WritableBookLike> & Pick<WritableBookLike, 'id'>,
  ): WritableBookLike => ({
    isDefault: false,
    myRights: { mayWrite: true },
    ...over,
  })

  it('is undefined while the books are still loading', () => {
    expect(pickWritableBook(undefined)).toBeUndefined()
  })

  it('prefers the writable default, then the first writable book', () => {
    const def = book({ id: 'b2', isDefault: true })
    expect(pickWritableBook([book({ id: 'b1' }), def])).toBe(def)
    // A read-only default is skipped for the first writable one.
    expect(
      pickWritableBook([
        book({ id: 'b1', isDefault: true, myRights: { mayWrite: false } }),
        book({ id: 'b2' }),
      ])?.id,
    ).toBe('b2')
  })

  it('is undefined when no book is writable', () => {
    expect(pickWritableBook([book({ id: 'b1', myRights: { mayWrite: false } })])).toBeUndefined()
  })
})

describe('senderToContactCard', () => {
  it('builds a minimal individual seed with the name and one email, filed in the target book', () => {
    const seed = senderToContactCard({ name: 'Alice Anderson', email: 'alice@x.test' }, 'book1')
    expect(seed).toMatchObject({
      '@type': 'Card',
      version: '1.0',
      kind: 'individual',
      name: { full: 'Alice Anderson' },
      emails: { e1: { '@type': 'EmailAddress', address: 'alice@x.test' } },
      addressBookIds: { book1: true },
    })
  })

  it('never mints an id or a uid — the create seam and the server own those', () => {
    const seed = senderToContactCard(
      { name: 'Alice', email: 'alice@x.test' },
      'book1',
    ) as Partial<ContactCard>
    expect(seed.id).toBeUndefined()
    expect(seed.uid).toBeUndefined()
  })

  it('omits the name entirely when the sender sent none', () => {
    const seed = senderToContactCard(
      { name: null, email: 'bare@x.test' },
      'book1',
    ) as Partial<ContactCard>
    expect(seed.name).toBeUndefined()
    expect(seed.emails).toEqual({ e1: { '@type': 'EmailAddress', address: 'bare@x.test' } })
  })
})
