import { describe, expect, it } from 'vitest'
import type { MailboxRow } from '../sync'
import { buildFolderTree, type FolderNode, visibleRows } from './folder-tree'

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
