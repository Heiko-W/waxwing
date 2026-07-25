/**
 * Sender → contact glue for the reading pane (M4.3-b, FR-CON-05). Pure and DOM-free, so it unit-tests
 * directly: given the account's cards it decides whether a message's sender is already a contact, picks
 * the book a new card should land in, and turns an unknown sender into a minimal create seed.
 *
 * Reuses ONLY the contacts area's pure helpers (`preferred` from `contact-fields`, which imports
 * `@waxwing/jscontact` type-only) — no Contacts UI and no jscontact runtime enter the mail graph.
 */

import type { ContactCard, Id } from '@waxwing/jmap'
import { type CardLike, preferred } from '../contacts/contact-fields'

/** The sender identity a reading-pane header carries — the first `from` mailbox. */
export interface SenderIdentity {
  /** Display name, or `null` when the sender sent none. */
  readonly name: string | null
  /** The sender's address — required, there is nothing to add or search on without one. */
  readonly email: string
}

/**
 * The card whose emails include `email`, matched case-insensitively over EVERY address on the card
 * (not just the primary), or `undefined`. Generic so it works against a hand-built {@link CardLike} in
 * a test and a real `ContactCardRow` in the app alike.
 */
export function findCardByEmail<T extends CardLike>(
  cards: readonly T[],
  email: string,
): T | undefined {
  const needle = email.trim().toLowerCase()
  if (needle === '') return undefined
  return cards.find((card) =>
    preferred(card.emails).some((entry) => entry.address.trim().toLowerCase() === needle),
  )
}

/** The minimum an address book must expose for {@link pickWritableBook} to choose it. */
export interface WritableBookLike {
  readonly id: Id
  readonly isDefault: boolean
  readonly myRights: { readonly mayWrite: boolean }
}

/**
 * The book a new contact from the reader should be created in: the writable default, else the first
 * writable one, else `undefined` (books still loading, or none writable). Mirrors the `pickTargetBook`
 * default branch in the Contacts screen — the reader has no "selected book" context, so there is no
 * per-selection preference to honour here.
 */
export function pickWritableBook<T extends WritableBookLike>(
  books: readonly T[] | undefined,
): T | undefined {
  if (books === undefined) return undefined
  return (
    books.find((book) => book.isDefault && book.myRights.mayWrite) ??
    books.find((book) => book.myRights.mayWrite)
  )
}

/**
 * A minimal ContactCard seed for `useContactActions().create()` from an unknown sender. Neither a JMAP
 * `id` nor a JSContact `uid` is minted here: `create` overwrites `id` with the outbox creation id
 * before dispatch, and the SERVER assigns the `uid` (RFC 9553 — a client omits it on create so the
 * server owns it). Guessing either is the M4.2 lesson this avoids; the cast re-adds only those two
 * server-owned identity fields the type nominally requires.
 */
export function senderToContactCard(from: SenderIdentity, bookId: Id): ContactCard {
  const name = from.name?.trim()
  const seed = {
    '@type': 'Card',
    version: '1.0',
    kind: 'individual',
    emails: { e1: { '@type': 'EmailAddress', address: from.email } },
    addressBookIds: { [bookId]: true },
    ...(name !== undefined && name !== '' ? { name: { '@type': 'Name', full: name } } : {}),
  } satisfies Omit<ContactCard, 'id' | 'uid'>
  return seed as unknown as ContactCard
}
