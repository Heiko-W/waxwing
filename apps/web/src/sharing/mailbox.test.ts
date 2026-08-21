/**
 * What "View / Edit / Manage" grant on a MAIL FOLDER (S-3).
 *
 * The generic role machinery is exercised through the Files suite, which was already green before
 * this existed and stayed green through the lift. What is tested here is the part that is NOT
 * generic: mail is the object type where the three roles stop fitting, and every assertion below
 * pins one of the places they break.
 *
 * The ten permission keys are measured against Stalwart v0.16.18 (2026-08-21): all ten accepted in
 * `Mailbox/set … shareWith`, an eleventh refused per object with
 * `invalidProperties: 'Invalid permission "mayFlibber"'`.
 */

import type { MailboxRights } from '@waxwing/jmap'
import { describe, expect, it } from 'vitest'
import { MAILBOX_RIGHT_KEYS, mailboxRoles, mayShareMailbox } from './mailbox'
import { SHARE_ROLES } from './roles'

describe('“View” must not mark the owner’s mail as read', () => {
  /*
   * THE assertion of this file. `$seen` lives on the MESSAGE, not on the reader: a viewer with
   * `maySetSeen` marks the owner's mail read simply by opening it, and the owner then never sees it
   * as new. A grant sold as read-only that silently rewrites someone's inbox is not read-only.
   */
  it('withholds maySetSeen from viewer', () => {
    expect(mailboxRoles.rightsFor('viewer').maySetSeen).toBe(false)
  })

  it('grants it to editor, who is actually working the folder', () => {
    expect(mailboxRoles.rightsFor('editor').maySetSeen).toBe(true)
  })

  it('gives viewer nothing else either — read, and only read', () => {
    const viewer = mailboxRoles.rightsFor('viewer')
    expect(viewer.mayReadItems).toBe(true)
    const others = MAILBOX_RIGHT_KEYS.filter((key) => key !== 'mayReadItems')
    expect(others.filter((key) => viewer[key])).toEqual([])
  })
})

describe('nobody may send from someone else’s account, in any role', () => {
  /*
   * ADR-020, measured: Stalwart advertises `urn:ietf:params:jmap:submission` on every delegated
   * account and then answers `Identity/get` and `EmailSubmission/set` with
   * `forbidden — "You are not an owner"`. Granting `maySubmit` would put a promise in the dialog
   * that the server breaks — including in "Manage", which manages the FOLDER.
   */
  it('leaves maySubmit false in all three roles', () => {
    for (const role of SHARE_ROLES) {
      expect(mailboxRoles.rightsFor(role).maySubmit, role).toBe(false)
    }
  })
})

describe('the folder itself belongs to Manage', () => {
  it('keeps rename, delete and create-child out of Edit', () => {
    const editor = mailboxRoles.rightsFor('editor')
    expect(editor.mayCreateChild).toBe(false)
    expect(editor.mayRename).toBe(false)
    // `mayDelete` deletes the FOLDER, not the mail in it — `mayRemoveItems` is the message right,
    // and Edit does have that.
    expect(editor.mayDelete).toBe(false)
    expect(editor.mayRemoveItems).toBe(true)
  })

  it('gives Manage the folder rights and the right to re-share', () => {
    const manager = mailboxRoles.rightsFor('manager')
    expect(manager.mayCreateChild).toBe(true)
    expect(manager.mayRename).toBe(true)
    expect(manager.mayDelete).toBe(true)
    expect(manager.mayShare).toBe(true)
  })

  it('gives mayShare to Manage alone', () => {
    expect(mailboxRoles.rightsFor('viewer').mayShare).toBe(false)
    expect(mailboxRoles.rightsFor('editor').mayShare).toBe(false)
  })
})

describe('every role sends all ten measured keys', () => {
  /*
   * A partial grant is accepted (the server fills the rest with `false`), but sending the whole map
   * is what makes the write say exactly what was meant — and it is what `roleOf` needs to read a
   * grant back as a role rather than as `custom`.
   */
  it('names the ten the server takes, and no eleventh', () => {
    expect([...MAILBOX_RIGHT_KEYS].sort()).toEqual(
      [
        'mayAddItems',
        'mayCreateChild',
        'mayDelete',
        'mayReadItems',
        'mayRemoveItems',
        'mayRename',
        'maySetKeywords',
        'maySetSeen',
        'mayShare',
        'maySubmit',
      ].sort(),
    )
  })

  it('fills every key in every role', () => {
    for (const role of SHARE_ROLES) {
      expect(Object.keys(mailboxRoles.rightsFor(role)).sort(), role).toEqual(
        [...MAILBOX_RIGHT_KEYS].sort(),
      )
    }
  })
})

describe('reading a grant back', () => {
  it('recognises its own roles', () => {
    for (const role of SHARE_ROLES) {
      expect(mailboxRoles.roleOf(mailboxRoles.rightsFor(role)), role).toBe(role)
    }
  })

  it('calls a combination it cannot express “custom”, and does not snap it to a role', () => {
    // A grant another client could have made: read plus send, which is no role here. Rewriting it
    // as the "closest" role would change what someone else may do without saying so.
    const foreign: MailboxRights = {
      ...mailboxRoles.rightsFor('viewer'),
      maySubmit: true,
    }
    expect(mailboxRoles.roleOf(foreign)).toBe('custom')
  })

  it('treats a PARTIAL map the way the server’s normalisation implies', () => {
    // `{ mayReadItems: true }` reads back from the server as all ten keys with the rest false —
    // measured — which is exactly `viewer`.
    expect(mailboxRoles.roleOf({ mayReadItems: true })).toBe('viewer')
  })

  it('answers `custom` for nothing at all rather than guessing', () => {
    expect(mailboxRoles.roleOf(null)).toBe('custom')
    expect(mailboxRoles.roleOf(undefined)).toBe('custom')
  })
})

describe('carrying the other grantees across', () => {
  it('keeps everyone else when one grant changes — a Mailbox/set REPLACES the map', () => {
    const before = { 'p-dave': mailboxRoles.rightsFor('editor') }
    const after = mailboxRoles.withGrant(before, 'p-bob', 'viewer')
    expect(Object.keys(after).sort()).toEqual(['p-bob', 'p-dave'])
    expect(after['p-dave']).toEqual(mailboxRoles.rightsFor('editor'))
  })

  it('removes only the one revoked', () => {
    const before = {
      'p-bob': mailboxRoles.rightsFor('viewer'),
      'p-dave': mailboxRoles.rightsFor('editor'),
    }
    expect(Object.keys(mailboxRoles.withoutGrant(before, 'p-bob'))).toEqual(['p-dave'])
  })
})

describe('mayShareMailbox — whether to offer the affordance at all', () => {
  it('is true only when the server said so', () => {
    expect(mayShareMailbox(mailboxRoles.rightsFor('manager'))).toBe(true)
    expect(mayShareMailbox(mailboxRoles.rightsFor('editor'))).toBe(false)
  })

  it('reads a MISSING mayShare as no', () => {
    // A replica row written before the property was modelled, or by a server without the sharing
    // extension, has nine keys. `undefined` must not become an offer the server then refuses.
    expect(mayShareMailbox({ mayReadItems: true })).toBe(false)
    expect(mayShareMailbox(null)).toBe(false)
    expect(mayShareMailbox(undefined)).toBe(false)
  })
})
