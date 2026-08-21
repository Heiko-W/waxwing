/**
 * What "View / Edit / Manage" mean for an address book (S-2, RFC 9610 §2).
 *
 * **This is the type the three roles were made for.** `AddressBookRights` has exactly four keys and
 * they nest: `mayRead` ⊂ `mayRead + mayWrite` ⊂ everything. There is no `maySetSeen` trap as on a
 * mail folder and no fourth level as on a calendar, so the spec below is the shortest one in this
 * directory and has nothing to explain but the split at the top:
 *
 * `mayDelete` and `mayShare` are both in **Manage**, not in Edit. `mayShare` because it is the right
 * that hands out rights — a grantee who has it can widen access the owner never approved, with no
 * notification back. `mayDelete` because it is the BOOK, not the cards in it: RFC 9610 §2 gives
 * `mayWrite` the cards ("create, modify or move ContactCards") and `mayDelete` the container. Which
 * of the two the server really enforces is the one thing here that is **not** measured — the gap
 * analysis lists "was löschen `AddressBook.mayDelete` — den Container oder den Inhalt?" as open —
 * and Manage is the conservative reading: if it turns out to delete only the container, nothing that
 * has been granted becomes wider than it looked.
 *
 * ## The load path is the mail folder's, not the file node's
 *
 * `AddressBook/get` is sent by the sync engine (`sync/engine/port.ts`) with **no `properties`**, and
 * whether this server volunteers `shareWith` in that answer is unmeasured — for `Mailbox` and
 * `Calendar` the measured answers are "no" and "only on request" respectively. So the replica's
 * `AddressBookRow.shareWith` may well be `undefined` for every row on every server, and a dialog
 * that seeded itself from it would show "Only you" over a book two people can read and then write
 * that back. `addressbook-client.ts` fetches the map explicitly instead.
 */

import type { AddressBookRights, Id } from '@waxwing/jmap'
import { type BasicShareRole, makeRoleModel, type RoleSpec, SHARE_ROLES } from './roles'

/** The all-false grant. Its four keys are the four RFC 9610 defines and Stalwart accepts. */
const NONE: AddressBookRights = {
  mayRead: false,
  mayWrite: false,
  mayShare: false,
  mayDelete: false,
}

const SPEC: RoleSpec<AddressBookRights, BasicShareRole> = {
  none: NONE,
  order: SHARE_ROLES,
  roles: {
    /** Read the cards. Nothing else — and unlike a mail folder, reading leaves no trace. */
    viewer: { ...NONE, mayRead: true },
    /** Read, add, change and move the cards in it. Not the book itself. */
    editor: { ...NONE, mayRead: true, mayWrite: true },
    /** The cards, plus the book itself — and the right to hand it on. */
    manager: { mayRead: true, mayWrite: true, mayShare: true, mayDelete: true },
  },
}

export const addressBookRoles = makeRoleModel(SPEC)

/** The four permission keys, for anything that needs to check its own literal. */
export const ADDRESS_BOOK_RIGHT_KEYS = Object.keys(NONE) as readonly (keyof AddressBookRights)[]

/**
 * Whether this book can be shared at all.
 *
 * `myRights.mayShare` is the server's answer for the CURRENT user — an owner has it, a grantee
 * usually does not. Offering the affordance anyway produces a refusal the user cannot act on.
 *
 * `=== true` rather than a truthiness check, and defensively rather than trusting the type: a row
 * written by an older build, or fetched from a server without the sharing extension, has no
 * `mayShare` at all, and "absent" must read as "no".
 */
export function mayShareAddressBook(
  rights: Partial<AddressBookRights> | null | undefined,
): boolean {
  return rights?.mayShare === true
}

/** A grant map as the wire wants it: every principal carrying all four keys. */
export type AddressBookShareWith = Record<Id, AddressBookRights>
