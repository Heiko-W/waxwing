/**
 * Message-write permission rules (B34). Each test names the mutation it guards, because every one of
 * these rules has a plausible simpler version that is wrong in a way no type checks.
 */

import { describe, expect, it } from 'vitest'
import type { EmailRow, MailboxRow } from '../sync'
import { mailbox } from '../sync/test-utils'
import { ALL_GRANTED, messageRights, RIGHTS_REASON } from './rights'

const ACC = 'acc'

/** A mailbox row with `over` rights denied/granted on top of the all-granted default. */
function box(id: string, rights: Partial<MailboxRow['myRights']> = {}): MailboxRow {
  const base = mailbox(id) as unknown as MailboxRow
  return {
    ...base,
    accountId: ACC,
    myRights: { ...base.myRights, ...rights },
  }
}

/** An email row that lives in `mailboxIds`. Only that field and the key matter here. */
function email(id: string, mailboxIds: string[]): EmailRow {
  return {
    accountId: ACC,
    id,
    mailboxIds: Object.fromEntries(mailboxIds.map((m) => [m, true])),
    keywords: {},
  } as unknown as EmailRow
}

const input = (over: Partial<Parameters<typeof messageRights>[0]> = {}) =>
  messageRights({
    rows: [email('e1', ['a'])],
    total: 1,
    mailboxes: [box('a')],
    accountReadOnly: false,
    ...over,
  })

describe('messageRights (B34)', () => {
  it('governs $seen by maySetSeen alone', () => {
    // Guards: swapping the two ACL letters. Stalwart maps both onto one ACL, so a server round-trip
    // would not catch it — only a client that reads them separately can.
    const rights = input({ mailboxes: [box('a', { maySetSeen: false })] })
    expect(rights.maySetSeen).toBe(false)
    expect(rights.maySetKeywords).toBe(true)
    expect(rights.reason('seen')).toBe(RIGHTS_REASON.seen)
  })

  it('governs flags and labels by maySetKeywords alone', () => {
    const rights = input({ mailboxes: [box('a', { maySetKeywords: false })] })
    expect(rights.maySetKeywords).toBe(false)
    expect(rights.maySetSeen).toBe(true)
  })

  it('requires the right in EVERY mailbox the message is in', () => {
    // Guards: `some` instead of `every`, and — the real-world mistake — gating on the list's
    // `sourceMailboxId` instead of joining `mailboxIds`. The message is in a granted folder AND a
    // denied one; reading only the folder on screen would permit the write.
    const rights = input({
      rows: [email('e1', ['a', 'b'])],
      mailboxes: [box('a'), box('b', { maySetKeywords: false })],
    })
    expect(rights.maySetKeywords).toBe(false)
  })

  it('requires mayRemoveItems in every mailbox to destroy', () => {
    // Guards: adopting Stalwart's ANY semantics, which would offer a destroy other servers reject.
    const rights = input({
      rows: [email('e1', ['a', 'b'])],
      mailboxes: [box('a'), box('b', { mayRemoveItems: false })],
    })
    expect(rights.mayDestroy).toBe(false)
    expect(rights.reason('destroy')).toBe(RIGHTS_REASON.destroy)
  })

  it('gates a move on the SOURCE mayRemoveItems and the TARGET mayAddItems', () => {
    // Guards: dropping either half. The source half is the total gap B34 names — every existing
    // check in the app looks at the target only, so moving OUT of a read-only folder was offered.
    const rights = input({
      mailboxes: [box('a', { mayRemoveItems: false }), box('t')],
    })
    expect(rights.removeReason('a')).toBe(RIGHTS_REASON.remove)
    expect(rights.addReason('t')).toBeNull()
    expect(rights.moveReason('a', 't')).toBe(RIGHTS_REASON.remove)

    const target = input({ mailboxes: [box('a'), box('t', { mayAddItems: false })] })
    expect(target.removeReason('a')).toBeNull()
    expect(target.addReason('t')).toBe(RIGHTS_REASON.add)
    expect(target.moveReason('a', 't')).toBe(RIGHTS_REASON.add)
  })

  it('treats from === null as a copy: the target right alone', () => {
    // Guards: applying the source rule to a copy, which would kill trash-from-a-search — the one
    // case where there is no single source folder to remove from.
    const rights = input({ mailboxes: [box('a', { mayRemoveItems: false }), box('t')] })
    expect(rights.moveReason(null, 't')).toBeNull()
  })

  it('refuses an unhydrated subject when SOME mailbox in the account denies', () => {
    // Guards: copying the fail-OPEN shape the label predicates use. An id we cannot see could be in
    // the denied folder, so the honest answer is refusal.
    const rights = input({
      rows: [undefined],
      total: 1,
      mailboxes: [box('a'), box('b', { maySetKeywords: false })],
    })
    expect(rights.maySetKeywords).toBe(false)
    expect(rights.unknown).toBe(true)
    expect(rights.reason('keywords')).toBe(RIGHTS_REASON.unknown)
  })

  it('ALLOWS an unhydrated subject when every mailbox grants the right', () => {
    // Guards: deleting the account-floor clause. This is the single-account no-regression pin — on
    // the user's own account the server grants everything everywhere, so a select-all reaching past
    // the loaded window must stay fully operable. Without the floor it goes dead.
    const rights = input({
      rows: [undefined, undefined],
      total: 5,
      mailboxes: [box('a'), box('b')],
    })
    expect(rights.maySetSeen).toBe(true)
    expect(rights.maySetKeywords).toBe(true)
    expect(rights.mayDestroy).toBe(true)
    expect(rights.unknown).toBe(false)
  })

  it('is optimistic while the mailbox query is unresolved', () => {
    // Guards: returning false there, which makes every control flicker "unavailable" on mount.
    const rights = input({ mailboxes: undefined, rows: undefined, total: 1 })
    expect(rights.maySetSeen).toBe(true)
    expect(rights.removeReason('a')).toBeNull()
    expect(rights.addReason('t')).toBeNull()
  })

  it('counts a mailbox the replica does not hold as denied — once the floor does not settle it', () => {
    // The account floor is checked FIRST and deliberately wins: where every known mailbox grants the
    // right, an unknown one is assumed to as well (that assumption is what keeps the user's own
    // account fully operable). So the unknown-mailbox rule only bites in a MIXED-rights account —
    // which is exactly where it matters, and this pins that it does.
    const mixed = [box('a'), box('locked', { maySetSeen: false })]
    expect(
      messageRights({
        rows: [email('e1', ['ghost'])],
        total: 1,
        mailboxes: mixed,
        accountReadOnly: false,
      }).maySetSeen,
    ).toBe(false)

    // And the floor case, stated as the deliberate trade it is.
    expect(input({ rows: [email('e1', ['ghost'])], mailboxes: [box('a')] }).maySetSeen).toBe(true)
  })

  it('refuses everything on a read-only account, and that reason wins', () => {
    const rights = input({ accountReadOnly: true })
    expect(rights.maySetSeen).toBe(false)
    expect(rights.maySetKeywords).toBe(false)
    expect(rights.mayDestroy).toBe(false)
    expect(rights.reason('seen')).toBe(RIGHTS_REASON.accountReadOnly)
    expect(rights.removeReason('a')).toBe(RIGHTS_REASON.accountReadOnly)
    expect(rights.addReason('t')).toBe(RIGHTS_REASON.accountReadOnly)
    // Not "unknown": the account flag is a real denial, not a gap in what we know.
    expect(rights.unknown).toBe(false)
  })

  it('grants everything in the degrade used outside a provider', () => {
    expect(ALL_GRANTED.maySetSeen).toBe(true)
    expect(ALL_GRANTED.reason('destroy')).toBeNull()
    expect(ALL_GRANTED.moveReason('a', 't')).toBeNull()
  })

  it('reports no reason for an absent move target — that is not a rights question', () => {
    expect(input().addReason(undefined)).toBeNull()
  })

  it('treats a SINGLE named mailbox the replica lacks as a knowledge gap, not a denial', () => {
    // The deliberate asymmetry against the `mailboxIds` join above, and it is load-bearing: refusing
    // here would block ordinary moves whenever the folder tree has not synced yet, and would make
    // this predicate contradict the surfaces that DO hold the row. There, an unknown mailbox is a
    // real risk (the message might be in a folder that denies); here the caller named one folder and
    // not holding its row says nothing about the rights on it.
    const rights = input({ mailboxes: [box('a')] })
    expect(rights.removeReason('not-synced-yet')).toBeNull()
    expect(rights.addReason('not-synced-yet')).toBeNull()
    // A KNOWN denial still refuses — the gap clause must not swallow that.
    const known = input({ mailboxes: [box('a'), box('locked', { mayAddItems: false })] })
    expect(known.addReason('locked')).toBe(RIGHTS_REASON.add)
  })
})
