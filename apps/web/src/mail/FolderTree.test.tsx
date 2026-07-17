import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RouterProvider } from '../app/route'
import { getPref, putMailboxes, type ReplicaDb, ReplicaProvider } from '../sync'
import { setActiveEngine } from '../sync/engine'
import { freshDb, mailbox } from '../sync/test-utils'
import { ToastProvider } from '../ui'
import { clearActiveDrag, setActiveDrag } from './dnd'
import { FolderTree } from './FolderTree'
import { EMPTY_LIST_STATE, useListStore } from './list-store'
import { EMPTY_SELECTION, selectionReducer } from './message-selection'

let db: ReplicaDb
const dispatch = vi.fn()

beforeEach(async () => {
  db = freshDb()
  dispatch.mockReset()
  setActiveEngine({ dispatch } as unknown as Parameters<typeof setActiveEngine>[0])
  await putMailboxes(db, 'a', [
    mailbox('inbox', { role: 'inbox' }),
    mailbox('work', { name: 'Work' }),
    mailbox('sub', { name: 'Sub', parentId: 'work' }),
  ])
})

afterEach(async () => {
  setActiveEngine(null)
  await db.delete()
})

function renderTree() {
  return render(
    <RouterProvider>
      <ToastProvider>
        <ReplicaProvider accountId="a" db={db}>
          <FolderTree />
        </ReplicaProvider>
      </ToastProvider>
    </RouterProvider>,
  )
}

describe('FolderTree (container)', () => {
  it('renders the folders from the replica', async () => {
    renderTree()
    expect(await screen.findByText('Inbox')).toBeInTheDocument()
    expect(await screen.findByText('Work')).toBeInTheDocument()
    expect(await screen.findByText('Sub')).toBeInTheDocument()
  })

  it('persists collapse state locally', async () => {
    const user = userEvent.setup()
    renderTree()
    const work = await screen.findByRole('treeitem', { name: /Work/ })
    await user.click(work.querySelector('[data-chevron]') as Element)

    await waitFor(async () =>
      expect(await getPref<string[]>(db, 'a', 'folders.collapsed')).toEqual(['work']),
    )
    // The collapsed folder's child is no longer rendered.
    expect(screen.queryByText('Sub')).not.toBeInTheDocument()
  })

  it('selects a folder by navigating the router', async () => {
    const user = userEvent.setup()
    renderTree()
    const work = await screen.findByRole('treeitem', { name: /Work/ })
    await user.click(work)
    await waitFor(() => expect(work).toHaveAttribute('aria-selected', 'true'))
    expect(work).toHaveAttribute('aria-current', 'page')
  })

  it('dispatches a delete intent through the engine after confirmation', async () => {
    const user = userEvent.setup()
    renderTree()
    const work = await screen.findByRole('treeitem', { name: /Work/ })
    // Open the folder's action menu (revealed within the row) and choose Delete.
    await user.click(within(work).getByRole('button', { name: 'Folder actions' }))
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }))
    // Confirm in the destructive dialog.
    await user.click(screen.getByRole('button', { name: 'Delete' }))

    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({ kind: 'deleteMailbox', id: 'work' })
  })

  it('persists a "keep offline" pin to the replica (M3.4)', async () => {
    const user = userEvent.setup()
    renderTree()
    const work = await screen.findByRole('treeitem', { name: /Work/ })

    await user.click(within(work).getByRole('button', { name: 'Folder actions' }))
    await user.click(screen.getByRole('menuitem', { name: 'Keep offline' }))

    await waitFor(async () =>
      expect(await getPref<string[]>(db, 'a', 'offline.pinnedMailboxes')).toEqual(['work']),
    )
    // The row now announces the state, and the action flips to its inverse.
    expect(await screen.findByRole('treeitem', { name: /Work/ })).toHaveTextContent('Kept offline')
    await user.click(within(work).getByRole('button', { name: 'Folder actions' }))
    expect(screen.getByRole('menuitem', { name: 'Stop keeping offline' })).toBeInTheDocument()
  })

  it('creates a top-level folder from the new-folder affordance', async () => {
    const user = userEvent.setup()
    renderTree()
    await user.click(await screen.findByRole('button', { name: 'New folder' }))
    await user.type(screen.getByLabelText('Folder name'), 'Projects')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      kind: 'createMailbox',
      props: { name: 'Projects', parentId: null },
    })
  })

  // Drop targets (M3.9 5b, FR-MBX-03). The drag SOURCE lives in MessageList/FolderTreeView; here we
  // prove the drop routes through the right seam. jsdom fires no real DnD, so a drag is staged in the
  // module state `getActiveDrag` reads and a `drop` event is dispatched at the target row.
  describe('drop', () => {
    beforeEach(() => {
      clearActiveDrag()
      useListStore.setState(EMPTY_LIST_STATE)
    })
    afterEach(() => clearActiveDrag())

    const dataTransfer = (types: string[]) => ({
      types,
      getData: () => '',
      setData: () => {},
      dropEffect: 'none',
    })
    const row = (name: RegExp) => screen.getByRole('treeitem', { name })

    it('a message drop dispatches a move into the target and clears the selection', async () => {
      renderTree()
      await screen.findByText('Work')
      // A message drag from the inbox, two messages, with the list holding a selection.
      act(() => {
        // Build the selection through the real reducer so its full shape is honest.
        let sel = selectionReducer(EMPTY_SELECTION, { type: 'selectOne', id: 'm1' })
        sel = selectionReducer(sel, { type: 'toggle', id: 'm2' })
        useListStore.setState({ selection: sel })
        setActiveDrag({ kind: 'messages', ids: ['m1', 'm2'], from: 'inbox' })
      })

      const work = row(/Work/)
      fireEvent.dragOver(work, { dataTransfer: dataTransfer(['application/x-waxwing-messages']) })
      fireEvent.drop(work, { dataTransfer: dataTransfer(['application/x-waxwing-messages']) })

      // Routed through triage.moveTo → the `move` intent, so it carries the Undo toast.
      expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
        kind: 'move',
        emailIds: ['m1', 'm2'],
        from: 'inbox',
        to: 'work',
      })
      // The tree does not inherit MessageList's clear, so it must do it itself.
      expect(useListStore.getState().selection.selected.size).toBe(0)
    })

    it('names the target by its LOCALIZED role label, not its server name', async () => {
      // Drop onto the Inbox (a role folder). The toast must read "Inbox", not the raw name.
      renderTree()
      await screen.findByText('Work')
      act(() => setActiveDrag({ kind: 'messages', ids: ['m1'], from: 'work' }))

      const inbox = row(/Inbox/)
      fireEvent.dragOver(inbox, { dataTransfer: dataTransfer(['application/x-waxwing-messages']) })
      fireEvent.drop(inbox, { dataTransfer: dataTransfer(['application/x-waxwing-messages']) })

      expect(await screen.findByText('Moved to Inbox')).toBeInTheDocument()
    })

    it('a folder drop onto a legal parent re-parents it', async () => {
      renderTree()
      await screen.findByText('Work')
      // Drag 'sub' — legal targets are inbox and work's siblings, NOT work (its current parent) and
      // NOT itself. Drop onto inbox.
      act(() => setActiveDrag({ kind: 'mailbox', id: 'sub', legal: new Set(['inbox']) }))

      const inbox = row(/Inbox/)
      fireEvent.dragOver(inbox, { dataTransfer: dataTransfer(['application/x-waxwing-mailbox']) })
      fireEvent.drop(inbox, { dataTransfer: dataTransfer(['application/x-waxwing-mailbox']) })

      expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
        kind: 'moveMailbox',
        id: 'sub',
        parentId: 'inbox',
      })
    })

    it('does nothing when the drop target is not in the drag legal set', async () => {
      renderTree()
      await screen.findByText('Work')
      // 'sub' may not move under 'work' (its current parent). The tree must refuse the drop.
      act(() => setActiveDrag({ kind: 'mailbox', id: 'sub', legal: new Set(['inbox']) }))

      const work = row(/Work/)
      fireEvent.dragOver(work, { dataTransfer: dataTransfer(['application/x-waxwing-mailbox']) })
      fireEvent.drop(work, { dataTransfer: dataTransfer(['application/x-waxwing-mailbox']) })

      expect(dispatch).not.toHaveBeenCalled()
    })
  })
})
