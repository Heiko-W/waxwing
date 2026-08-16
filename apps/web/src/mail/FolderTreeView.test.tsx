import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { MailboxRow } from '../sync'
import { expectNoA11yViolations } from '../test/axe'
import { MESSAGES_MIME } from './dnd'
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
    await user.click(screen.getByRole('button', { name: /^Folder actions/ }))
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
    expect(screen.queryByRole('button', { name: /^Folder actions/ })).not.toBeInTheDocument()
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

    await user.click(screen.getByRole('button', { name: /^Folder actions/ }))
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

    await user.click(screen.getByRole('button', { name: /^Folder actions/ }))
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
    await user.click(screen.getByRole('button', { name: /^Folder actions/ }))
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
  // B20.5: every row rendered a menu button called exactly "Folder actions", so a tree of eight
  // folders exposed eight indistinguishable buttons — a screen-reader rotor shows a column of
  // identical entries, and voice control ("click Folder actions") has nothing to pick between.
  it('names each row menu after its folder, so no two are alike', async () => {
    renderTree([row('inbox', { role: 'inbox' }), row('work', { name: 'Work' })])

    const names = screen
      .getAllByRole('button', { name: /^Folder actions/ })
      .map((button) => button.getAttribute('aria-label'))
    expect(names).toEqual(['Folder actions: Inbox', 'Folder actions: Work'])
    expect(new Set(names).size, 'two menu buttons share a name').toBe(names.length)
  })

  it('offers Move to… and raises it with the clicked mailbox', async () => {
    const user = userEvent.setup()
    const onRequestMove = vi.fn()
    const rows = [row('inbox', { role: 'inbox' }), row('work', { name: 'Work' })]
    renderTree(rows, { onRequestMove })

    const menus = screen.getAllByRole('button', { name: /^Folder actions/ })
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
    await user.click(screen.getByRole('button', { name: /^Folder actions/ }))
    expect(screen.queryByRole('menuitem', { name: 'Move to…' })).not.toBeInTheDocument()
  })

  it('hides Move to… when no handler is passed', async () => {
    const user = userEvent.setup()
    renderTree([row('inbox', { role: 'inbox' })])
    await user.click(screen.getByRole('button', { name: /^Folder actions/ }))
    expect(screen.queryByRole('menuitem', { name: 'Move to…' })).not.toBeInTheDocument()
  })
})

// Drop target + the live region (M3.9 5b). axe cannot see any of this — it verifies structure, never
// that a region announces — so these are the tests that catch the single most likely 5b defect: a
// region mounted only during a drag, which is silent on NVDA/JAWS.
describe('FolderTreeView — drag & drop target', () => {
  const dataTransfer = (types: string[]) => ({
    types,
    getData: () => '',
    setData: () => {},
    dropEffect: 'none',
  })

  it('the live region exists and is EMPTY before any drag (the always-mounted invariant)', () => {
    // Mounted only while dragging → silent on NVDA/JAWS. This is the assertion that catches that.
    const { container } = renderTree([row('inbox', { role: 'inbox' })])
    const region = container.querySelector('[aria-live="polite"]')
    expect(region).not.toBeNull()
    expect(region).toBeEmptyDOMElement()
  })

  it('dragging a droppable message over a legal target rings it and announces the target', () => {
    const { container } = renderTree(
      [row('inbox', { role: 'inbox' }), row('work', { name: 'Work' })],
      {
        canDropOn: () => true,
      },
    )
    const work = screen.getByRole('treeitem', { name: /Work/ })
    fireEvent.dragOver(work, { dataTransfer: dataTransfer([MESSAGES_MIME]) })

    expect(work.className).toMatch(/dropTarget/)
    expect(container.querySelector('[aria-live="polite"]')).toHaveTextContent('Drop on Work')
  })

  it('does not accept or announce a drag over an ILLEGAL target', () => {
    const { container } = renderTree(
      [row('inbox', { role: 'inbox' }), row('work', { name: 'Work' })],
      {
        canDropOn: () => false,
      },
    )
    const work = screen.getByRole('treeitem', { name: /Work/ })
    const event = new Event('dragover', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer([MESSAGES_MIME]) })
    fireEvent(work, event)

    expect(event.defaultPrevented).toBe(false) // the drop is refused
    expect(work.className).not.toMatch(/dropTarget/)
    expect(container.querySelector('[aria-live="polite"]')).toBeEmptyDOMElement()
  })

  it('ignores a drag whose type is not one of ours (a file drag passes through)', () => {
    const { container } = renderTree([row('inbox', { role: 'inbox' })], { canDropOn: () => true })
    const inbox = screen.getByRole('treeitem', { name: /Inbox/ })
    const event = new Event('dragover', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer(['Files']) })
    fireEvent(inbox, event)

    expect(event.defaultPrevented).toBe(false)
    expect(container.querySelector('[aria-live="polite"]')).toBeEmptyDOMElement()
  })

  it('keeps the highlight when dragleave crosses into a child span, clears when it truly leaves', () => {
    renderTree([row('inbox', { role: 'inbox' }), row('work', { name: 'Work' })], {
      canDropOn: () => true,
    })
    const work = screen.getByRole('treeitem', { name: /Work/ })
    fireEvent.dragOver(work, { dataTransfer: dataTransfer([MESSAGES_MIME]) })
    expect(work.className).toMatch(/dropTarget/)

    // `fireEvent.dragLeave(node, { relatedTarget })` does NOT put relatedTarget on the synthetic
    // event (jsdom falls back to a plain Event whose relatedTarget stays null), so build the event
    // by hand — the same technique the illegal-drag tests above use for dataTransfer.
    const leaveTo = (related: Node | null) => {
      const event = new Event('dragleave', { bubbles: true })
      Object.defineProperty(event, 'relatedTarget', { value: related })
      fireEvent(work, event)
    }

    // relatedTarget is a descendant → the cursor is still inside the row: keep the ring.
    leaveTo(work.querySelector('span'))
    expect(work.className).toMatch(/dropTarget/)

    // relatedTarget outside the row → really left: clear it.
    leaveTo(document.body)
    expect(work.className).not.toMatch(/dropTarget/)
  })

  it('a mailbox with mayRename is draggable; one without is not', () => {
    renderTree(
      [
        row('inbox', { role: 'inbox' }),
        row('locked', { name: 'Locked', myRights: { ...RIGHTS, mayRename: false } }),
      ],
      { onDragStartMailbox: noop },
    )
    expect(screen.getByRole('treeitem', { name: /Inbox/ })).toHaveAttribute('draggable', 'true')
    expect(screen.getByRole('treeitem', { name: /Locked/ })).toHaveAttribute('draggable', 'false')
  })
})
