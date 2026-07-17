import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { MailboxRow } from '../sync'
import { expectNoA11yViolations } from '../test/axe'
import { FolderTreeView } from './FolderTreeView'
import { buildFolderTree } from './folder-tree'

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

const noop = () => {}

function renderTree(rows: MailboxRow[], props: Partial<Parameters<typeof FolderTreeView>[0]> = {}) {
  return render(
    <FolderTreeView
      tree={buildFolderTree(rows)}
      selectedMailboxId="inbox"
      collapsed={new Set()}
      onToggleCollapse={noop}
      onSelect={noop}
      onRequestCreate={noop}
      onRequestRename={noop}
      onRequestDelete={noop}
      {...props}
    />,
  )
}

describe('FolderTreeView', () => {
  it('keeps exactly one roving tab stop when the selected folder is collapsed away (a11y regression)', () => {
    renderTree(
      [
        row('inbox', { role: 'inbox' }),
        row('work', { name: 'Work' }),
        row('sub', { name: 'Sub', parentId: 'work' }),
      ],
      { selectedMailboxId: 'sub', collapsed: new Set(['work']) },
    )
    // 'sub' is under a collapsed parent, so it is not rendered at all.
    expect(screen.queryByText('Sub')).toBeNull()
    const items = screen.getAllByRole('treeitem')
    const tabbable = items.filter((el) => el.getAttribute('tabindex') === '0')
    // The stale selection must not strand the tab stop — exactly one visible row stays tabbable.
    expect(tabbable).toHaveLength(1)
    expect(within(tabbable[0] as HTMLElement).getByText('Inbox')).toBeInTheDocument()
  })

  it('renders a tree with localized role names and custom folders', () => {
    renderTree([
      row('inbox', { role: 'inbox' }),
      row('sent', { role: 'sent' }),
      row('work', { name: 'Work' }),
    ])
    expect(screen.getByRole('tree')).toBeInTheDocument()
    const items = screen.getAllByRole('treeitem')
    expect(items.map((el) => el.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('Inbox'), expect.stringContaining('Sent')]),
    )
    expect(screen.getByText('Work')).toBeInTheDocument()
  })

  it('marks the selected folder and shows unread counts only when > 0', () => {
    renderTree([
      row('inbox', { role: 'inbox', unreadEmails: 3 }),
      row('sent', { role: 'sent', unreadEmails: 0 }),
    ])
    const inbox = screen.getByRole('treeitem', { name: /Inbox/ })
    expect(inbox).toHaveAttribute('aria-selected', 'true')
    expect(within(inbox).getByText('3')).toBeInTheDocument()
    expect(inbox).toHaveTextContent('3 unread')

    const sent = screen.getByRole('treeitem', { name: /Sent/ })
    expect(sent).toHaveAttribute('aria-selected', 'false')
    expect(sent).not.toHaveTextContent('unread')
  })

  it('gates the action menu by myRights (no Delete when mayDelete is false)', async () => {
    const user = userEvent.setup()
    renderTree([row('inbox', { role: 'inbox', myRights: { ...RIGHTS, mayDelete: false } })])
    await user.click(screen.getByRole('button', { name: 'Folder actions' }))
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).not.toBeInTheDocument()
  })

  it('omits the menu entirely when no action is permitted', () => {
    renderTree([
      row('inbox', {
        role: 'inbox',
        myRights: { ...RIGHTS, mayCreateChild: false, mayRename: false, mayDelete: false },
      }),
    ])
    expect(screen.queryByRole('button', { name: 'Folder actions' })).not.toBeInTheDocument()
  })

  it('toggles collapse when the disclosure chevron is clicked', async () => {
    const user = userEvent.setup()
    const onToggleCollapse = vi.fn()
    renderTree([row('parent'), row('child', { parentId: 'parent' })], {
      selectedMailboxId: undefined,
      onToggleCollapse,
    })
    const parent = screen.getByRole('treeitem', { name: /parent/ })
    expect(parent).toHaveAttribute('aria-expanded', 'true')
    // The chevron is inside the row; clicking it toggles rather than selecting.
    const chevron = parent.querySelector('[data-chevron]')
    expect(chevron).not.toBeNull()
    await user.click(chevron as Element)
    expect(onToggleCollapse).toHaveBeenCalledWith('parent')
  })

  it('moves roving focus with ArrowDown / ArrowUp', async () => {
    const user = userEvent.setup()
    renderTree([row('inbox', { role: 'inbox' }), row('sent', { role: 'sent' })])
    const inbox = screen.getByRole('treeitem', { name: /Inbox/ })
    inbox.focus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('treeitem', { name: /Sent/ })).toHaveFocus()
    await user.keyboard('{ArrowUp}')
    expect(inbox).toHaveFocus()
  })

  it('has no axe violations', async () => {
    const { container } = renderTree([
      row('inbox', { role: 'inbox', unreadEmails: 2 }),
      row('work', { name: 'Work' }),
      row('sub', { name: 'Sub', parentId: 'work' }),
    ])
    await expectNoA11yViolations(container)
  })
})

describe('FolderTreeView — keep offline (M3.4)', () => {
  it('offers "Keep offline" on an unpinned folder and toggles it', async () => {
    const user = userEvent.setup()
    const onTogglePin = vi.fn()
    renderTree([row('inbox', { role: 'inbox' })], { pinned: new Set(), onTogglePin })

    await user.click(screen.getByRole('button', { name: 'Folder actions' }))
    await user.click(screen.getByRole('menuitem', { name: 'Keep offline' }))

    expect(onTogglePin).toHaveBeenCalledTimes(1)
    expect(onTogglePin.mock.calls[0]?.[0]).toMatchObject({ id: 'inbox' })
  })

  it('flips the action label on a pinned folder (a menu item has no checked state)', async () => {
    const user = userEvent.setup()
    renderTree([row('inbox', { role: 'inbox' })], {
      pinned: new Set(['inbox']),
      onTogglePin: noop,
    })

    await user.click(screen.getByRole('button', { name: 'Folder actions' }))
    expect(screen.getByRole('menuitem', { name: 'Stop keeping offline' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Keep offline' })).not.toBeInTheDocument()
  })

  it('announces the pinned state on the row itself', () => {
    renderTree([row('inbox', { role: 'inbox' }), row('work', { name: 'Work' })], {
      pinned: new Set(['work']),
      onTogglePin: noop,
    })
    expect(screen.getByRole('treeitem', { name: /Work/ })).toHaveTextContent('Kept offline')
    expect(screen.getByRole('treeitem', { name: /Inbox/ })).not.toHaveTextContent('Kept offline')
  })

  it('hides the entry on a folder the user may not read', async () => {
    const user = userEvent.setup()
    renderTree([row('inbox', { role: 'inbox', myRights: { ...RIGHTS, mayReadItems: false } })], {
      pinned: new Set(),
      onTogglePin: noop,
    })
    await user.click(screen.getByRole('button', { name: 'Folder actions' }))
    expect(screen.queryByRole('menuitem', { name: 'Keep offline' })).not.toBeInTheDocument()
  })

  it('has no axe violations with a pinned folder', async () => {
    const { container } = renderTree([row('inbox', { role: 'inbox', unreadEmails: 2 })], {
      pinned: new Set(['inbox']),
      onTogglePin: noop,
    })
    await expectNoA11yViolations(container)
  })

  // "Move to…" (M3.9, FR-MBX-03) — the keyboard route to a re-parent, and the one WCAG 2.2 SC 2.5.7
  // makes a prerequisite of the drag rather than a companion to it.
  it('offers Move to… and raises it with the clicked mailbox', async () => {
    const user = userEvent.setup()
    const onRequestMove = vi.fn()
    const rows = [row('inbox', { role: 'inbox' }), row('work', { name: 'Work' })]
    renderTree(rows, { onRequestMove })

    const menus = screen.getAllByRole('button', { name: 'Folder actions' })
    await user.click(menus[1] as HTMLElement)
    await user.click(screen.getByRole('menuitem', { name: 'Move to…' }))
    expect(onRequestMove).toHaveBeenCalledWith(expect.objectContaining({ id: 'work' }))
  })

  it('hides Move to… when the folder may not be renamed', async () => {
    // A re-parent IS a rename-class update on the mailbox — there is no separate `mayMove` right.
    const user = userEvent.setup()
    renderTree([row('inbox', { role: 'inbox', myRights: { ...RIGHTS, mayRename: false } })], {
      onRequestMove: noop,
    })
    await user.click(screen.getByRole('button', { name: 'Folder actions' }))
    expect(screen.queryByRole('menuitem', { name: 'Move to…' })).not.toBeInTheDocument()
  })

  it('hides Move to… when no handler is passed', async () => {
    const user = userEvent.setup()
    renderTree([row('inbox', { role: 'inbox' })])
    await user.click(screen.getByRole('button', { name: 'Folder actions' }))
    expect(screen.queryByRole('menuitem', { name: 'Move to…' })).not.toBeInTheDocument()
  })
})
