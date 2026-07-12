import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RouterProvider } from '../app/route'
import { getPref, putMailboxes, type ReplicaDb, ReplicaProvider } from '../sync'
import { setActiveEngine } from '../sync/engine'
import { freshDb, mailbox } from '../sync/test-utils'
import { FolderTree } from './FolderTree'

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
      <ReplicaProvider accountId="a" db={db}>
        <FolderTree />
      </ReplicaProvider>
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
})
