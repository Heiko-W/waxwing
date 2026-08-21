import { describe, expect, it } from 'vitest'
import type { MailboxRow } from '../sync'
import { mailbox as makeMailbox } from '../sync/test-utils'
import {
  ASSIGNABLE_ROLES,
  assignableRoles,
  changedSortOrders,
  dropIndex,
  isStandardFolder,
  mayChangeRole,
  moveItem,
  nextSortOrder,
  orderableSiblings,
  reorderSiblings,
  visibleMailboxes,
} from './folder-order'

function row(id: string, over: Partial<MailboxRow> = {}): MailboxRow {
  return { accountId: 'a', ...makeMailbox(id, over) } as MailboxRow
}

/** The list the way the replica hands it over: `sortOrder`, then name. */
function replica(...rows: MailboxRow[]): MailboxRow[] {
  return [...rows].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
}

describe('assignable roles (M-6)', () => {
  // MEASURED, Stalwart v0.16.18, 21.08.2026: `templates` — a role RFC 8621's world knows — answers
  // `invalidProperties: "Invalid property or value."`. So do `all`, `flagged`, `subscribed`,
  // `notes`, `outbox`, `spam` and `starred`. A picker built from the IANA registry would offer a
  // setting that can only ever dead-letter.
  it('never offers a role this server refuses', () => {
    const mailboxes = replica(row('inbox', { role: 'inbox' }), row('work', { name: 'Work' }))
    const offered = assignableRoles(mailboxes, 'work')

    for (const refused of ['templates', 'all', 'flagged', 'subscribed', 'notes', 'spam']) {
      expect(offered).not.toContain(refused)
    }
    expect(offered).toEqual(['archive', 'important', 'snoozed', 'scheduled', 'memos'])
  })

  // MEASURED: a role is unique per account. `role: "junk"` on a second folder answers
  // `invalidProperties: "A mailbox with role 'junk' already exists."` — and so does a second
  // `archive`, which is the case that matters here because `archive` is one we hand out.
  it('does not offer a role another folder already holds', () => {
    const mailboxes = replica(
      row('inbox', { role: 'inbox' }),
      row('old', { name: 'Old mail', role: 'archive' }),
      row('work', { name: 'Work' }),
    )

    expect(assignableRoles(mailboxes, 'work')).not.toContain('archive')
    // …but the folder that HOLDS it still sees it, or the picker could not show its own state.
    expect(assignableRoles(mailboxes, 'old')).toContain('archive')
  })

  it('leaves the server-owned roles alone and honours mayRename', () => {
    expect(mayChangeRole(row('inbox', { role: 'inbox' }))).toBe(false)
    expect(mayChangeRole(row('trash', { role: 'trash' }))).toBe(false)
    expect(mayChangeRole(row('work'))).toBe(true)
    expect(mayChangeRole(row('mine', { role: 'archive' }))).toBe(true)

    const readOnly = row('theirs', {
      myRights: { ...row('theirs').myRights, mayRename: false },
    })
    expect(mayChangeRole(readOnly)).toBe(false)
  })

  it('offers only roles the constant knows — the constant is the measurement', () => {
    expect([...ASSIGNABLE_ROLES]).toEqual(['archive', 'important', 'snoozed', 'scheduled', 'memos'])
  })
})

describe('reordering (M-5)', () => {
  it('moves a folder among its siblings and restamps that group 1-based', () => {
    const mailboxes = replica(
      row('a1', { name: 'Alpha' }),
      row('b1', { name: 'Beta' }),
      row('c1', { name: 'Gamma' }),
    )

    const next = reorderSiblings(mailboxes, 'c1', 0)

    expect(next.map((m) => m.id)).toEqual(['c1', 'a1', 'b1'])
    expect(next.map((m) => m.sortOrder)).toEqual([1, 2, 3])
  })

  it('never moves a folder out of its own parent', () => {
    const mailboxes = replica(
      row('root', { name: 'Root' }),
      row('kid1', { name: 'One', parentId: 'root' }),
      row('kid2', { name: 'Two', parentId: 'root' }),
      row('other', { name: 'Other' }),
    )

    // Index 9 is past the end of the two-child group; it clamps INSIDE the group.
    const next = reorderSiblings(mailboxes, 'kid1', 9)

    expect(orderableSiblings(next, 'root').map((m) => m.id)).toEqual(['kid2', 'kid1'])
    expect(next.find((m) => m.id === 'kid1')?.parentId).toBe('root')
    expect(next.find((m) => m.id === 'other')?.sortOrder).toBe(0)
  })

  it('is identity when nothing moved, so a plain click writes nothing', () => {
    const mailboxes = replica(row('a1', { name: 'Alpha' }), row('b1', { name: 'Beta' }))
    expect(reorderSiblings(mailboxes, 'a1', 0)).toBe(mailboxes)
    expect(changedSortOrders(mailboxes, mailboxes)).toEqual([])
  })

  it('reports only the sortOrders that changed — that is the request payload', () => {
    const mailboxes = replica(
      row('a1', { name: 'Alpha' }),
      row('b1', { name: 'Beta' }),
      row('c1', { name: 'Gamma' }),
    )
    const next = reorderSiblings(mailboxes, 'a1', 1)

    expect(changedSortOrders(mailboxes, next)).toEqual([
      { id: 'b1', sortOrder: 1 },
      { id: 'a1', sortOrder: 2 },
      { id: 'c1', sortOrder: 3 },
    ])
  })

  it('appends a new folder to a hand-ordered group, and stays out of the way otherwise', () => {
    const untouched = [row('a1', { name: 'Alpha' }), row('b1', { name: 'Beta' })]
    expect(nextSortOrder(untouched)).toBeUndefined()

    const ordered = reorderSiblings(replica(...untouched), 'b1', 0)
    expect(nextSortOrder([...ordered])).toBe(3)
  })

  it('moveItem and dropIndex behave as ADR-026 specified them', () => {
    expect(moveItem([1, 2, 3], 0, 2)).toEqual([2, 3, 1])
    expect(moveItem([1, 2, 3], 1, 1)).toEqual([1, 2, 3])
    // Past the midpoint of the row below = one place down; above the first = index 0.
    expect(dropIndex([10, 30, 50], 5)).toBe(0)
    expect(dropIndex([10, 30, 50], 35)).toBe(2)
    expect(dropIndex([], 100)).toBe(0)
  })
})

describe('visibility (M-5)', () => {
  it('hides an unsubscribed folder and everything under it', () => {
    const mailboxes = replica(
      row('inbox', { role: 'inbox' }),
      row('work', { name: 'Work', isSubscribed: false }),
      row('sub', { name: 'Sub', parentId: 'work' }),
      row('keep', { name: 'Keep' }),
    )

    expect(visibleMailboxes(mailboxes).map((m) => m.id)).toEqual(['inbox', 'keep'])
  })

  it('never hides a standard folder, whatever the flag says', () => {
    const mailboxes = replica(
      row('inbox', { role: 'inbox', isSubscribed: false }),
      row('trash', { role: 'trash', isSubscribed: false }),
      row('work', { name: 'Work' }),
    )

    expect(visibleMailboxes(mailboxes).map((m) => m.id)).toEqual(['inbox', 'trash', 'work'])
  })

  it('never hides the folder that is open, nor the folders it hangs from', () => {
    const mailboxes = replica(
      row('inbox', { role: 'inbox' }),
      row('work', { name: 'Work', isSubscribed: false }),
      row('sub', { name: 'Sub', parentId: 'work', isSubscribed: false }),
    )

    // The list keeps the replica's own order (sortOrder, then name) — "Sub" sorts before "Work".
    expect(visibleMailboxes(mailboxes, 'sub').map((m) => m.id)).toEqual(['inbox', 'sub', 'work'])
  })

  /*
   * MEASURED, and the reason this rule exists at all: on the fixture `alice` holds a share on
   * `carol`'s account, and `Mailbox/get` for that account answers `isSubscribed: false` for carol's
   * Inbox — the only mailbox alice can see there. That is RFC 8621 §2 as written ("SHOULD default
   * to false for Mailboxes in shared accounts"), so `false` there means "granted, not yet opted
   * in", not "the user hid this". Hiding on the flag alone would empty a whole delegated account.
   */
  it('shows everything in an account where nothing is subscribed at all', () => {
    const shared = replica(
      row('a', { name: 'Inbox', role: 'inbox', isSubscribed: false }),
      row('b', { name: 'Team', isSubscribed: false }),
    )

    expect(visibleMailboxes(shared).map((m) => m.id)).toEqual(['a', 'b'])
  })

  it('knows which folders are the standard six', () => {
    expect(isStandardFolder(row('x', { role: 'inbox' }))).toBe(true)
    expect(isStandardFolder(row('x', { role: 'archive' }))).toBe(true)
    // A role we hand out but do not pin — it stays reorderable and hideable.
    expect(isStandardFolder(row('x', { role: 'important' }))).toBe(false)
    expect(isStandardFolder(row('x'))).toBe(false)
  })
})
