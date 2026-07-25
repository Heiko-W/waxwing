// Types for the JS contacts-suite helpers so the TypeScript contacts spec can import them (Bundler
// resolution: an `import … from './seed-contacts.mjs'` resolves to this declaration file).

import type { JmapClient } from './seed-write.mjs'

export { ACCOUNTS, type JmapClient, jmapAs } from './seed-write.mjs'
export const DOMAIN: string
export const CONTACTS_TOKEN_PREFIX: string

/** A JSContact `Name` (subset the suite reads). */
export interface JsContactName {
  readonly '@type'?: string
  readonly full?: string
  readonly components?: { readonly kind: string; readonly value: string }[]
}

/** A JSContact `EmailAddress` (subset the suite reads). */
export interface JsContactEmail {
  readonly '@type'?: string
  readonly address: string
}

/** A fetched `ContactCard` — a `Partial<ContactCard>`, since a `/get` returns only requested props. */
export interface ContactCardLike {
  readonly id: string
  readonly uid?: string
  readonly kind?: string
  readonly name?: JsContactName
  readonly emails?: Record<string, JsContactEmail>
  /** A group's membership set: JSContact `uid` → `true`. */
  readonly members?: Record<string, boolean>
  readonly addressBookIds?: Record<string, boolean>
  readonly [key: string]: unknown
}

/** An `AddressBook` (subset the suite reasons about). */
export interface AddressBookLike {
  readonly id: string
  readonly name: string
  readonly isDefault?: boolean
  readonly myRights?: { readonly mayWrite?: boolean }
}

/** A seeded member contact: its JMAP id plus the SERVER-assigned JSContact uid a group must reference. */
export interface MemberSeed {
  readonly id: string
  readonly uid?: string
  readonly name?: JsContactName
}

/** A message seeded into the Inbox from a token-tagged sender (the sender-to-contact fixture). */
export interface SeededSenderMessage {
  /** The JMAP id of the seeded message. */
  readonly emailId: string
  /** The sender's address — the email the app writes onto the created card. */
  readonly senderEmail: string
  /** The sender's display name — the reading-pane trigger is named after it. */
  readonly senderName: string
  /** The seeded subject (carries the token, for finding it in the list and for cleanup). */
  readonly subject: string
}

export function contactsToken(kind?: string): string
export function contactsAccountId(client: JmapClient): Promise<string>
export function listAddressBooks(client: JmapClient, accountId: string): Promise<AddressBookLike[]>
export function defaultWritableBook(
  client: JmapClient,
  accountId: string,
): Promise<AddressBookLike | null>
export function readOnlyBook(client: JmapClient, accountId: string): Promise<AddressBookLike | null>
export function findContactsByToken(
  client: JmapClient,
  accountId: string,
  token: string,
  properties?: string[],
): Promise<ContactCardLike[]>
export function findGroupsByMember(
  client: JmapClient,
  accountId: string,
  memberUid: string,
  properties?: string[],
): Promise<ContactCardLike[]>
export function seedMemberContact(
  client: JmapClient,
  accountId: string,
  bookId: string,
  token: string,
): Promise<MemberSeed>
export function seedSenderMessage(client: JmapClient, token: string): Promise<SeededSenderMessage>
export function resetSenderMail(client: JmapClient): Promise<number>
export function resetContacts(client: JmapClient, accountId: string): Promise<number>
