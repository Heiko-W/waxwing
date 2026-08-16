import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { UserEvent } from '@testing-library/user-event'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '../app/config'
import { ConfigProvider } from '../app/config-context'
import { RouterProvider } from '../app/route'
import de from '../i18n/locales/de/common.json'
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

// ConfigProvider is part of the minimum stack because the cleanup dialogs name the product in their
// retention caution (`useConfig().branding.productName`).
function renderTree() {
  return render(
    <RouterProvider>
      <ConfigProvider config={DEFAULT_CONFIG}>
        <ToastProvider>
          <ReplicaProvider accountId="a" db={db}>
            <FolderTree />
          </ReplicaProvider>
        </ToastProvider>
      </ConfigProvider>
    </RouterProvider>,
  )
}

describe('FolderTree (container)', () => {
  // B20.8. The liveQuery starts `undefined` and the tree used to render `null` for it — so on every
  // cold start the sidebar was blank and silent, indistinguishable from an account with no folders,
  // while the message list beside it showed a spinner for the same wait.
  it('says it is loading before the liveQuery lands, rather than showing nothing', async () => {
    renderTree()

    expect(screen.getByRole('status')).toHaveTextContent('Loading folders')
    expect(screen.queryByText('Your folders will appear here.')).toBeNull()

    // …and it goes away once there is something to show, rather than sitting there forever.
    expect(await screen.findByText('Inbox')).toBeInTheDocument()
    expect(screen.queryByRole('status')).toBeNull()
  })

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
    await user.click(within(work).getByRole('button', { name: /^Folder actions/ }))
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

    await user.click(within(work).getByRole('button', { name: /^Folder actions/ }))
    await user.click(screen.getByRole('menuitem', { name: 'Keep offline' }))

    await waitFor(async () =>
      expect(await getPref<string[]>(db, 'a', 'offline.pinnedMailboxes')).toEqual(['work']),
    )
    // The row now announces the state, and the action flips to its inverse.
    expect(await screen.findByRole('treeitem', { name: /Work/ })).toHaveTextContent('Kept offline')
    await user.click(within(work).getByRole('button', { name: /^Folder actions/ }))
    expect(screen.getByRole('menuitem', { name: 'Stop keeping offline' })).toBeInTheDocument()
  })

  /**
   * Cleanup is the ONE destructive path in this tree that is not outbox-backed end to end: the
   * engine has to page the matching ids with a live `Email/query` (`collectMatchingIds`) before it
   * enqueues anything, so offline — or on any server error — the promise rejects with nothing
   * queued and nothing for `use-outbox-problems.ts` to surface. It was fired floating (`void …`), so
   * the dialog closed over silence and the user was left believing a folder had been emptied.
   *
   * Every test here therefore asserts the same one thing from a different direction: the user LEARNS
   * that it did not happen.
   */
  describe('a cleanup that never reaches the server', () => {
    async function seedTrash(): Promise<void> {
      await putMailboxes(db, 'a', [mailbox('trash', { name: 'Trash', role: 'trash' })])
    }

    /** Open a folder's action menu and pick one of its cleanup entries. */
    async function chooseCleanup(user: UserEvent, folder: RegExp, item: string): Promise<void> {
      const row = await screen.findByRole('treeitem', { name: folder })
      await user.click(within(row).getByRole('button', { name: /^Folder actions/ }))
      await user.click(await screen.findByRole('menuitem', { name: item }))
    }

    it('reports a rejected "Empty folder" instead of closing the dialog over silence', async () => {
      const user = userEvent.setup()
      const emptyMailbox = vi.fn().mockRejectedValue(new Error('offline'))
      setActiveEngine({ dispatch, emptyMailbox } as unknown as Parameters<
        typeof setActiveEngine
      >[0])
      await seedTrash()
      renderTree()

      await chooseCleanup(user, /Trash/, 'Empty Trash')
      await user.click(screen.getByRole('button', { name: 'Empty folder' }))

      expect(emptyMailbox).toHaveBeenCalledWith('trash')
      expect(await screen.findByText('Couldn’t clean up “Trash”')).toBeInTheDocument()
    })

    it('reports a rejected "Delete older than…" the same way', async () => {
      const user = userEvent.setup()
      const deleteOlderThan = vi.fn().mockRejectedValue(new Error('boom'))
      setActiveEngine({ dispatch, deleteOlderThan } as unknown as Parameters<
        typeof setActiveEngine
      >[0])
      renderTree()

      // No Trash mailbox is seeded, so `olderMode` resolves to the permanent-destroy arm.
      await chooseCleanup(user, /Work/, 'Delete older than…')
      await user.click(screen.getByRole('button', { name: 'Delete permanently' }))

      expect(deleteOlderThan).toHaveBeenCalled()
      expect(await screen.findByText('Couldn’t clean up “Work”')).toBeInTheDocument()
    })

    it('reports the recoverable (move-to-Trash) cleanup arm too', async () => {
      const user = userEvent.setup()
      const trashOlderThan = vi.fn().mockRejectedValue(new Error('boom'))
      setActiveEngine({ dispatch, trashOlderThan } as unknown as Parameters<
        typeof setActiveEngine
      >[0])
      await seedTrash()
      renderTree()

      await chooseCleanup(user, /Work/, 'Delete older than…')
      await user.click(screen.getByRole('button', { name: 'Move to Trash' }))

      // `useCleanupActions` converts the day count to the engine's UTC-midnight `before` bound.
      expect(trashOlderThan).toHaveBeenCalledWith(
        'work',
        'trash',
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/),
      )
      expect(await screen.findByText('Couldn’t clean up “Work”')).toBeInTheDocument()
    })

    // `useCleanupActions` returns `undefined` when no engine serves this account (`getEngineFor(…)?.`).
    // From the user's side that is the same outcome — the folder was not emptied — so it owes the
    // same report; a bare `void undefined` is exactly as silent as a swallowed rejection.
    it('reports a cleanup that could not even start (no engine running)', async () => {
      const user = userEvent.setup()
      setActiveEngine(null)
      await seedTrash()
      renderTree()

      await chooseCleanup(user, /Trash/, 'Empty Trash')
      await user.click(screen.getByRole('button', { name: 'Empty folder' }))

      expect(await screen.findByText('Couldn’t clean up “Trash”')).toBeInTheDocument()
    })

    // The report must not fire on the happy path — a success toast reading "couldn't clean up"
    // would be its own lie, and a `.catch` attached to the wrong end produces exactly that.
    it('says nothing when the cleanup is accepted', async () => {
      const user = userEvent.setup()
      const emptyMailbox = vi.fn().mockResolvedValue({ scheduled: 12 })
      setActiveEngine({ dispatch, emptyMailbox } as unknown as Parameters<
        typeof setActiveEngine
      >[0])
      await seedTrash()
      renderTree()

      await chooseCleanup(user, /Trash/, 'Empty Trash')
      await user.click(screen.getByRole('button', { name: 'Empty folder' }))

      await waitFor(() => expect(emptyMailbox).toHaveBeenCalled())
      expect(screen.queryByText('Couldn’t clean up “Trash”')).toBeNull()
    })

    // The German bundle is never exercised by the assertions above (the test i18n instance runs
    // `en`), and this app's German is the formal register — a failure message is precisely where an
    // informal "Du" slips in unnoticed.
    it('names the failure in German too, in the formal register', () => {
      expect(de.cleanup.failed.title).toContain('{{name}}')
      expect(de.cleanup.failed.body).toMatch(/Prüfen Sie/)
      expect(`${de.cleanup.failed.title} ${de.cleanup.failed.body}`).not.toMatch(/\b[Dd]ein|\bDu\b/)
    })
  })

  /**
   * `olderMode` — WHICH arm "Delete older than…" takes, per folder. The cases pinned below are the
   * recoverable arm (a normal folder with a Trash), the no-Trash-exists fallback (in the cleanup
   * block above), and both purge folders. Junk and Trash each arrived here after a mutation
   * survived the suite: the `role === 'junk'` term had no test at all, and Trash's two terms are
   * redundant one at a time and only fall to a composite mutation (see that test).
   *
   * Junk sits with Trash here on purpose, and the authority is not this function: FR-ORG-04 names
   * "Empty-trash / empty-junk" as one feature, `FolderTreeView` puts one Empty entry on BOTH purge
   * roles and labels it by role, and `Engine.deleteOlderThan` is documented "for Trash/Junk
   * cleanup". This is the FOLDER-PURGE family, and it is permanent in both purge folders.
   *
   * What it is NOT is a rule about a hand-picked selection — see the bulk bar's own Junk test in
   * `MessageList.test.tsx`, which pins the opposite answer for the opposite kind of action.
   */
  describe('“Delete older than…” in the purge folders', () => {
    async function seedBoth(): Promise<void> {
      await putMailboxes(db, 'a', [
        mailbox('trash', { name: 'Trash', role: 'trash' }),
        mailbox('junk', { name: 'Junk', role: 'junk' }),
      ])
    }

    async function chooseDeleteOlder(user: UserEvent, folder: RegExp): Promise<void> {
      const row = await screen.findByRole('treeitem', { name: folder })
      await user.click(within(row).getByRole('button', { name: /^Folder actions/ }))
      await user.click(await screen.findByRole('menuitem', { name: 'Delete older than…' }))
    }

    // The load-bearing case: a Trash mailbox EXISTS, so the recoverable arm is available — and Junk
    // still takes the permanent one. Without the `role === 'junk'` term this folder would silently
    // get "Move to Trash" instead, which is the whole difference the term encodes.
    it('destroys permanently from Junk even though a Trash exists to move to', async () => {
      const user = userEvent.setup()
      const deleteOlderThan = vi.fn().mockResolvedValue({ scheduled: 3 })
      const trashOlderThan = vi.fn().mockResolvedValue({ scheduled: 3 })
      setActiveEngine({ dispatch, deleteOlderThan, trashOlderThan } as unknown as Parameters<
        typeof setActiveEngine
      >[0])
      await seedBoth()
      renderTree()

      await chooseDeleteOlder(user, /Junk/)
      // The dialog names the outcome before it happens: permanence is offered, not recovery.
      expect(screen.getByRole('button', { name: 'Delete permanently' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Move to Trash' })).toBeNull()

      await user.click(screen.getByRole('button', { name: 'Delete permanently' }))
      await waitFor(() => expect(deleteOlderThan).toHaveBeenCalled())
      expect(deleteOlderThan.mock.calls[0]?.[0]).toBe('junk')
      expect(trashOlderThan).not.toHaveBeenCalled()
    })

    /**
     * The OTHER purge folder — the one this describe block was named for, plural, and had no
     * fixture. Trash reaches `'destroy'` through two terms that are individually redundant for a
     * well-formed account (exactly one mailbox carries the trash role, so `role === 'trash'` and
     * `trash.id === mailbox.id` select the same folder), which is why deleting either one alone
     * leaves the suite green and why no single-term mutation proves this test is load-bearing.
     *
     * The mutation this test exists to fail is therefore a COMPOSITE one — drop the `role ===
     * 'trash'` term AND the `trash.id === mailbox.id` term together and `olderMode` returns
     * `'trash'` for the Trash folder itself, i.e. "Delete older than…" in Trash offers to MOVE
     * Trash mail to Trash. That is verified: with both terms removed the assertions below go red.
     *
     * General lesson, since this recurs: a guard built from mutually-redundant terms is only
     * pinned by mutating them jointly. Trying each term on its own reports "unkillable" and is
     * wrong about it.
     */
    it('destroys permanently from Trash rather than moving Trash mail to Trash', async () => {
      const user = userEvent.setup()
      const deleteOlderThan = vi.fn().mockResolvedValue({ scheduled: 5 })
      const trashOlderThan = vi.fn().mockResolvedValue({ scheduled: 5 })
      setActiveEngine({ dispatch, deleteOlderThan, trashOlderThan } as unknown as Parameters<
        typeof setActiveEngine
      >[0])
      await seedBoth()
      renderTree()

      await chooseDeleteOlder(user, /Trash/)
      expect(screen.getByRole('button', { name: 'Delete permanently' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Move to Trash' })).toBeNull()

      await user.click(screen.getByRole('button', { name: 'Delete permanently' }))
      await waitFor(() => expect(deleteOlderThan).toHaveBeenCalled())
      expect(deleteOlderThan.mock.calls[0]?.[0]).toBe('trash')
      expect(trashOlderThan).not.toHaveBeenCalled()
    })

    // The contrast that gives the assertion above its meaning: with the SAME two mailboxes seeded, a
    // normal folder takes the recoverable arm. So "permanent" is a property of the purge folders,
    // not of this dialog.
    it('still moves to Trash from a normal folder with the same mailboxes seeded', async () => {
      const user = userEvent.setup()
      const deleteOlderThan = vi.fn().mockResolvedValue({ scheduled: 3 })
      const trashOlderThan = vi.fn().mockResolvedValue({ scheduled: 3 })
      setActiveEngine({ dispatch, deleteOlderThan, trashOlderThan } as unknown as Parameters<
        typeof setActiveEngine
      >[0])
      await seedBoth()
      renderTree()

      await chooseDeleteOlder(user, /Work/)
      await user.click(screen.getByRole('button', { name: 'Move to Trash' }))

      await waitFor(() => expect(trashOlderThan).toHaveBeenCalled())
      expect(trashOlderThan.mock.calls[0]?.slice(0, 2)).toEqual(['work', 'trash'])
      expect(deleteOlderThan).not.toHaveBeenCalled()
    })

    // The reason Junk belongs to the folder-purge family: FR-ORG-04's "empty-junk" is an
    // unconditional destroy of the whole folder, with no recoverable arm to choose — the same entry
    // Trash gets, under a role-picked label. A "Delete older than…" that moved to Trash from this
    // same menu would contradict the entry directly above it.
    it('empties Junk through the same permanent path as Trash', async () => {
      const user = userEvent.setup()
      const emptyMailbox = vi.fn().mockResolvedValue({ scheduled: 7 })
      setActiveEngine({ dispatch, emptyMailbox } as unknown as Parameters<
        typeof setActiveEngine
      >[0])
      await seedBoth()
      renderTree()

      const row = await screen.findByRole('treeitem', { name: /Junk/ })
      await user.click(within(row).getByRole('button', { name: /^Folder actions/ }))
      await user.click(await screen.findByRole('menuitem', { name: 'Empty Junk' }))
      await user.click(screen.getByRole('button', { name: 'Empty folder' }))

      expect(emptyMailbox).toHaveBeenCalledWith('junk')
    })
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
        setActiveDrag({ kind: 'messages', accountId: 'a', ids: ['m1', 'm2'], from: 'inbox' })
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
      act(() => setActiveDrag({ kind: 'messages', accountId: 'a', ids: ['m1'], from: 'work' }))

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
      act(() =>
        setActiveDrag({ kind: 'mailbox', accountId: 'a', id: 'sub', legal: new Set(['inbox']) }),
      )

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
      act(() =>
        setActiveDrag({ kind: 'mailbox', accountId: 'a', id: 'sub', legal: new Set(['inbox']) }),
      )

      const work = row(/Work/)
      fireEvent.dragOver(work, { dataTransfer: dataTransfer(['application/x-waxwing-mailbox']) })
      fireEvent.drop(work, { dataTransfer: dataTransfer(['application/x-waxwing-mailbox']) })

      expect(dispatch).not.toHaveBeenCalled()
    })
  })
})
