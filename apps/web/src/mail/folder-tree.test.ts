import { describe, expect, it } from 'vitest'
import type { MailboxRow } from '../sync'
import {
  buildFolderTree,
  type FolderNode,
  isSelfOrDescendant,
  legalParents,
  type MoveLimits,
  subtreeDepth,
  visibleRows,
} from './folder-tree'

const RIGHTS = {
  mayReadItems: true,
  mayAddItems: true,
  mayRemoveItems: true,
  maySetSeen: true,
  maySetKeywords: true,
  mayCreateChild: true,
  mayRename: true,
  mayDelete: true,
  maySubmit: true,
}

function row(id: string, over: Partial<MailboxRow> = {}): MailboxRow {
  return {
    accountId: 'a',
    id,
    name: id,
    parentId: null,
    role: null,
    sortOrder: 0,
    totalEmails: 0,
    unreadEmails: 0,
    totalThreads: 0,
    unreadThreads: 0,
    myRights: RIGHTS,
    isSubscribed: true,
    ...over,
  }
}

const ids = (nodes: FolderNode[]): string[] => nodes.map((node) => node.mailbox.id)

describe('buildFolderTree', () => {
  it('pins role mailboxes at the top in canonical order, custom folders after', () => {
    // Incoming order is arbitrary; the tree must reorder the roots.
    const tree = buildFolderTree([
      row('work', { role: null }),
      row('trash', { role: 'trash' }),
      row('inbox', { role: 'inbox' }),
      row('sent', { role: 'sent' }),
    ])
    expect(ids(tree)).toEqual(['inbox', 'sent', 'trash', 'work'])
  })

  it('nests children under their parent with increasing depth', () => {
    const tree = buildFolderTree([
      row('inbox', { role: 'inbox' }),
      row('parent'),
      row('child', { parentId: 'parent' }),
      row('grandchild', { parentId: 'child' }),
    ])
    const parent = tree.find((node) => node.mailbox.id === 'parent')
    expect(parent?.depth).toBe(0)
    expect(ids(parent?.children ?? [])).toEqual(['child'])
    expect(parent?.children[0]?.depth).toBe(1)
    expect(parent?.children[0]?.children[0]?.mailbox.id).toBe('grandchild')
    expect(parent?.children[0]?.children[0]?.depth).toBe(2)
  })

  it('surfaces a child whose parent is not synced yet as a root', () => {
    const tree = buildFolderTree([row('orphan', { parentId: 'not-here' })])
    expect(ids(tree)).toEqual(['orphan'])
    expect(tree[0]?.depth).toBe(0)
  })

  it('does not loop on a parentId cycle', () => {
    const tree = buildFolderTree([row('a', { parentId: 'b' }), row('b', { parentId: 'a' })])
    // Both resolve to each other; the guard keeps each rendered exactly once without recursing forever.
    const flat = visibleRows(tree, () => false)
    expect(flat.map((node) => node.mailbox.id).sort()).toEqual(['a', 'b'])
  })
})

describe('visibleRows', () => {
  it('hides the subtree of a collapsed folder', () => {
    const tree = buildFolderTree([
      row('inbox', { role: 'inbox' }),
      row('parent'),
      row('child', { parentId: 'parent' }),
    ])
    const collapsed = new Set(['parent'])
    const rows = visibleRows(tree, (id) => collapsed.has(id))
    expect(rows.map((node) => node.mailbox.id)).toEqual(['inbox', 'parent'])

    const expanded = visibleRows(tree, () => false)
    expect(expanded.map((node) => node.mailbox.id)).toEqual(['inbox', 'parent', 'child'])
  })
})

// The move guards (M3.9, FR-MBX-03). `moveMailbox` patches `parentId` optimistically and
// unconditionally, and `buildFolderTree` re-surfaces a detached subtree as orphan roots — so an
// illegal move renders FINE and only comes back as a generic `invalid` conflict after a round-trip.
// These are preconditions, not hints, and this is the only place they are proven.

const UNLIMITED: MoveLimits = { maxMailboxDepth: null, mayCreateTopLevelMailbox: true }

/** parent → child → grandchild, plus an unrelated sibling and the Inbox. */
const CHAIN = [
  row('inbox', { role: 'inbox' }),
  row('parent'),
  row('child', { parentId: 'parent' }),
  row('grandchild', { parentId: 'child' }),
  row('other'),
]

describe('isSelfOrDescendant', () => {
  it('is true for the subject itself, its child and its grandchild — false for a sibling', () => {
    expect(isSelfOrDescendant(CHAIN, 'parent', 'parent')).toBe(true)
    expect(isSelfOrDescendant(CHAIN, 'parent', 'child')).toBe(true)
    expect(isSelfOrDescendant(CHAIN, 'parent', 'grandchild')).toBe(true)
    expect(isSelfOrDescendant(CHAIN, 'parent', 'other')).toBe(false)
    // Upwards is not downwards: the parent is not a descendant of its child.
    expect(isSelfOrDescendant(CHAIN, 'child', 'parent')).toBe(false)
  })

  it('terminates on a parentId cycle instead of looping', () => {
    // buildFolderTree tolerates this (a replica mid-sync may be briefly impossible), so must this.
    const cyclic = [row('a', { parentId: 'b' }), row('b', { parentId: 'a' }), row('x')]
    expect(isSelfOrDescendant(cyclic, 'x', 'a')).toBe(false)
    expect(isSelfOrDescendant(cyclic, 'a', 'b')).toBe(true)
  })
})

describe('subtreeDepth', () => {
  it('measures the HEIGHT below the subject, not the subject own depth', () => {
    // The distinction the depth budget rides on: moving `parent` moves its grandchild too, and it is
    // the DEEPEST descendant that hits the ceiling first.
    expect(subtreeDepth(CHAIN, 'grandchild')).toBe(0)
    expect(subtreeDepth(CHAIN, 'child')).toBe(1)
    expect(subtreeDepth(CHAIN, 'parent')).toBe(2)
    expect(subtreeDepth(CHAIN, 'other')).toBe(0)
  })

  it('terminates on a cycle', () => {
    const cyclic = [row('a', { parentId: 'b' }), row('b', { parentId: 'a' })]
    expect(subtreeDepth(cyclic, 'a')).toBeLessThanOrEqual(2)
  })
})

describe('legalParents', () => {
  it('excludes the subject, every descendant and the current parent', () => {
    const targets = legalParents(CHAIN, 'child', UNLIMITED)
    expect(targets).not.toContain('child') // itself
    expect(targets).not.toContain('grandchild') // its own descendant — would detach the subtree
    expect(targets).not.toContain('parent') // where it already is: a no-op, not a move
    expect(targets).toContain('other')
    expect(targets).toContain('inbox')
    expect(targets).toContain(null) // to top level
  })

  it('refuses everything when the subject may not be renamed', () => {
    // A re-parent is a Mailbox/set update on the subject; there is no `mayMove` right.
    const locked = CHAIN.map((mailbox) =>
      mailbox.id === 'child' ? { ...mailbox, myRights: { ...RIGHTS, mayRename: false } } : mailbox,
    )
    expect(legalParents(locked, 'child', UNLIMITED)).toEqual([])
  })

  it('reads mayCreateChild on the TARGET, never on the subject', () => {
    // The target is the one gaining a child. Asking the subject would be the easy mistake, and it
    // would let a move into a read-only folder through while blocking legal ones.
    const noChildren = CHAIN.map((mailbox) =>
      mailbox.id === 'other'
        ? { ...mailbox, myRights: { ...RIGHTS, mayCreateChild: false } }
        : mailbox,
    )
    expect(legalParents(noChildren, 'child', UNLIMITED)).not.toContain('other')

    const subjectCannot = CHAIN.map((mailbox) =>
      mailbox.id === 'child'
        ? { ...mailbox, myRights: { ...RIGHTS, mayCreateChild: false } }
        : mailbox,
    )
    expect(legalParents(subjectCannot, 'child', UNLIMITED)).toContain('other')
  })

  it('budgets the depth limit for the subject whole subtree', () => {
    // maxMailboxDepth is 1-based (RFC 8621 §1.4): a top-level mailbox has depth 1. Under top-level
    // `other`, a leaf lands at 2 — but `child` drags `grandchild` to 3.
    const shallow: MoveLimits = { maxMailboxDepth: 2, mayCreateTopLevelMailbox: true }
    expect(legalParents(CHAIN, 'grandchild', shallow)).toContain('other')
    expect(legalParents(CHAIN, 'child', shallow)).not.toContain('other')
  })

  it('treats maxMailboxDepth null as UNLIMITED, never as zero', () => {
    // The test that catches a `?? 0` or a truthiness check — both would block every move on the
    // commonest server config.
    expect(legalParents(CHAIN, 'child', UNLIMITED)).toContain('other')
    expect(legalParents(CHAIN, 'grandchild', UNLIMITED)).toContain('other')
  })

  it('offers top level only when the account may create one — and never for a subject already there', () => {
    expect(legalParents(CHAIN, 'child', UNLIMITED)).toContain(null)
    expect(
      legalParents(CHAIN, 'child', { maxMailboxDepth: null, mayCreateTopLevelMailbox: false }),
    ).not.toContain(null)
    // `other` is already top level: offering it would be a no-op.
    expect(legalParents(CHAIN, 'other', UNLIMITED)).not.toContain(null)
  })

  it('excludes a target that already holds a same-named child, case-insensitively', () => {
    // The rule the rename dialog already enforces (mailbox.error.nameTaken); the server would reject
    // the move, and the optimistic patch would have shown it as done.
    const clash = [
      row('inbox', { role: 'inbox' }),
      row('src'),
      row('subject', { name: 'Work', parentId: 'src' }),
      row('dest'),
      row('existing', { name: 'work', parentId: 'dest' }),
    ]
    expect(legalParents(clash, 'subject', UNLIMITED)).not.toContain('dest')
    expect(legalParents(clash, 'subject', UNLIMITED)).toContain('inbox')
  })
})
