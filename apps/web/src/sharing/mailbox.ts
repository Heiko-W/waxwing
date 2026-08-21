/**
 * What "View / Edit / Manage" mean for a mail folder (S-3), and the two places mail refuses to fit.
 *
 * The ten keys below are MEASURED, not read off RFC 8621 — which lists nine. Against the Stalwart
 * v0.16.18 fixture on 2026-08-21: every one of these was accepted inside `Mailbox/set … shareWith`
 * and echoed back in full, and an invented eleventh (`mayFlibber`) was refused per object with
 * `invalidProperties: 'Invalid permission "mayFlibber"'`. So the list is the server's, and a key
 * added here on the strength of a spec alone would take the grant down with it.
 *
 * ## "View" must switch `maySetSeen` OFF
 *
 * This is the one place the file/address-book role model breaks, and it is not a detail. `$seen`
 * lives on the message, not on the reader: a viewer with `maySetSeen` marks the OWNER's mail as read
 * simply by opening it, and the owner then never sees it as new. A "read-only" grant that silently
 * rewrites the owner's inbox is not read-only, so `viewer` withholds the right — and the UI's
 * explanation says so in words rather than leaving the user to discover it from their colleague.
 *
 * The cost is real and is the honest trade: with `maySetSeen: false` a viewer's own unread counts
 * never move, so every message in the shared folder stays bold for them for ever. "Edit" is the role
 * for someone who is actually working the folder, and it grants `maySetSeen`.
 *
 * ## `maySubmit` is `false` in ALL THREE roles
 *
 * ADR-020: Stalwart advertises `urn:ietf:params:jmap:submission` on every delegated account and then
 * answers both `Identity/get` and `EmailSubmission/set` with `forbidden — "You are not an owner"`.
 * Waxwing does not offer send-as from a foreign account, so granting a right that cannot be
 * exercised would put a promise in the dialog that the server breaks. It is left out of `manager`
 * too, deliberately: "Manage" manages the FOLDER.
 *
 * ## `mayCreateChild` / `mayRename` / `mayDelete` are about the folder, not the post
 *
 * They rename and destroy the container. Someone filing and flagging mail ("Edit") has no business
 * being able to delete the folder out from under its owner, so all three sit in "Manage" alongside
 * `mayShare`.
 */

import type { Id, MailboxRights } from '@waxwing/jmap'
import { makeRoleModel, type RoleSpec } from './roles'

/** The all-false grant. Its keys are the ten the server accepts — see the module note. */
const NONE: MailboxRights = {
  mayReadItems: false,
  mayAddItems: false,
  mayRemoveItems: false,
  maySetSeen: false,
  maySetKeywords: false,
  mayCreateChild: false,
  mayRename: false,
  mayDelete: false,
  maySubmit: false,
  mayShare: false,
}

const SPEC: RoleSpec<MailboxRights> = {
  none: NONE,
  roles: {
    /** Read the mail and nothing else — explicitly NOT `maySetSeen`. */
    viewer: { ...NONE, mayReadItems: true },
    /** Work the folder: read, file in, file out, mark read, flag and label. */
    editor: {
      ...NONE,
      mayReadItems: true,
      mayAddItems: true,
      mayRemoveItems: true,
      maySetSeen: true,
      maySetKeywords: true,
    },
    /** Everything Edit grants, plus the folder itself — and the right to hand it on. */
    manager: {
      ...NONE,
      mayReadItems: true,
      mayAddItems: true,
      mayRemoveItems: true,
      maySetSeen: true,
      maySetKeywords: true,
      mayCreateChild: true,
      mayRename: true,
      mayDelete: true,
      mayShare: true,
    },
  },
}

export const mailboxRoles = makeRoleModel(SPEC)

/** The ten permission keys this server accepts, for anything that needs to check its own literal. */
export const MAILBOX_RIGHT_KEYS = Object.keys(NONE) as readonly (keyof MailboxRights)[]

/**
 * Whether this folder can be shared at all.
 *
 * `myRights.mayShare` is the server's answer for the CURRENT user — an owner has it, a grantee
 * usually does not. Offering the affordance anyway would produce a refusal the user cannot act on.
 *
 * Defensive about a missing value rather than trusting the type: `myRights` is stored in the replica
 * by spreading whatever `Mailbox/get` returned, so a row written by an older build, or by a server
 * without the sharing extension, has no `mayShare` at all. `=== true` reads that as "no".
 */
export function mayShareMailbox(rights: Partial<MailboxRights> | null | undefined): boolean {
  return rights?.mayShare === true
}

/** A grant map as the wire wants it: every principal carrying all ten keys. */
export type MailboxShareWith = Record<Id, MailboxRights>
