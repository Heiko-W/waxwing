/**
 * The address-book role model (S-2).
 *
 * The type the three roles fit exactly, so this file is mostly about proving that claim rather than
 * defending an exception: four keys, three nested roles, no `maySetSeen` trap and no fourth level.
 *
 * The two assertions that would catch a real mistake:
 *
 * - **the key set is the address book's own.** `AddressBook/set` was measured to refuse a MAILBOX
 *   key offered to it — `shareWith.<id> = { mayReadItems: true }` came back
 *   `invalidProperties: 'Invalid permission "mayReadItems".'` — so a spec that borrowed from the
 *   neighbouring file would fail every grant, at run time, on a screen.
 * - **`mayShare` is Manage's alone.** It is the right that hands out rights, and there is no
 *   notification back to the owner when it is used.
 */

import type { AddressBookRights } from '@waxwing/jmap'
import { describe, expect, it } from 'vitest'
import { ADDRESS_BOOK_RIGHT_KEYS, addressBookRoles, mayShareAddressBook } from './addressbook-roles'
import { SHARE_ROLES } from './roles'

/** The four keys RFC 9610 §2 defines and Stalwart v0.16.18 was measured to accept. */
const MEASURED_KEYS = [
  'mayRead',
  'mayWrite',
  'mayShare',
  'mayDelete',
] as const satisfies readonly (keyof AddressBookRights)[]

describe('the address-book rights vocabulary', () => {
  it('is exactly the four measured keys — not the mail folder’s ten', () => {
    expect([...ADDRESS_BOOK_RIGHT_KEYS].sort()).toEqual([...MEASURED_KEYS].sort())
  })

  it('has no `mayReadItems`, which this server refuses by name', () => {
    expect(ADDRESS_BOOK_RIGHT_KEYS).not.toContain('mayReadItems')
  })

  it('writes every key on every role, so a grant is never partial', () => {
    for (const role of SHARE_ROLES) {
      expect(Object.keys(addressBookRoles.rightsFor(role)).sort()).toEqual(
        [...MEASURED_KEYS].sort(),
      )
    }
  })
})

describe('the three roles', () => {
  it('offers exactly three — an address book has no "availability only"', () => {
    expect(addressBookRoles.roles).toEqual(['viewer', 'editor', 'manager'])
  })

  it('lets View read and nothing else', () => {
    expect(addressBookRoles.rightsFor('viewer')).toEqual({
      mayRead: true,
      mayWrite: false,
      mayShare: false,
      mayDelete: false,
    })
  })

  it('lets Edit change the cards but not the list itself', () => {
    expect(addressBookRoles.rightsFor('editor')).toEqual({
      mayRead: true,
      mayWrite: true,
      mayShare: false,
      mayDelete: false,
    })
  })

  it('gives Manage everything', () => {
    expect(addressBookRoles.rightsFor('manager')).toEqual({
      mayRead: true,
      mayWrite: true,
      mayShare: true,
      mayDelete: true,
    })
  })

  it('keeps `mayShare` in Manage alone', () => {
    for (const role of SHARE_ROLES) {
      expect(addressBookRoles.rightsFor(role).mayShare).toBe(role === 'manager')
    }
  })

  it('keeps `mayDelete` in Manage alone, the conservative reading', () => {
    for (const role of SHARE_ROLES) {
      expect(addressBookRoles.rightsFor(role).mayDelete).toBe(role === 'manager')
    }
  })

  it('returns a fresh object, so an edit cannot reach the spec', () => {
    const first = addressBookRoles.rightsFor('viewer')
    first.mayWrite = true
    expect(addressBookRoles.rightsFor('viewer').mayWrite).toBe(false)
  })
})

describe('reading rights back', () => {
  it('names each role from the rights it produces', () => {
    for (const role of SHARE_ROLES) {
      expect(addressBookRoles.roleOf(addressBookRoles.rightsFor(role))).toBe(role)
    }
  })

  it('never answers `freeBusy` — a role this type does not offer', () => {
    for (const role of SHARE_ROLES) {
      expect(addressBookRoles.roleOf(addressBookRoles.rightsFor(role))).not.toBe('freeBusy')
    }
  })

  it('calls a combination none of the three produces `custom`', () => {
    // Delete without write: legal on the wire, nonsense as a role, and not this client's to rewrite.
    expect(addressBookRoles.roleOf({ mayRead: true, mayDelete: true })).toBe('custom')
  })

  it('calls absent rights `custom` rather than guessing', () => {
    expect(addressBookRoles.roleOf(null)).toBe('custom')
    expect(addressBookRoles.roleOf(undefined)).toBe('custom')
  })
})

describe('carrying the other grantees across', () => {
  it('keeps everyone else when one grant changes', () => {
    const before = { alice: addressBookRoles.rightsFor('viewer') }
    const after = addressBookRoles.withGrant(before, 'bob', 'editor')
    expect(Object.keys(after).sort()).toEqual(['alice', 'bob'])
    expect(after.alice).toEqual(addressBookRoles.rightsFor('viewer'))
  })

  it('keeps everyone else when one grant is revoked', () => {
    const before = {
      alice: addressBookRoles.rightsFor('viewer'),
      bob: addressBookRoles.rightsFor('manager'),
    }
    expect(Object.keys(addressBookRoles.withoutGrant(before, 'bob'))).toEqual(['alice'])
  })
})

describe('whether the affordance is offered at all', () => {
  it('refuses without `mayShare`', () => {
    expect(mayShareAddressBook({ mayShare: false })).toBe(false)
  })

  it('refuses when the property was never fetched', () => {
    expect(mayShareAddressBook(undefined)).toBe(false)
    expect(mayShareAddressBook(null)).toBe(false)
    expect(mayShareAddressBook({})).toBe(false)
  })

  it('allows with `mayShare`', () => {
    expect(mayShareAddressBook({ mayShare: true })).toBe(true)
  })
})
