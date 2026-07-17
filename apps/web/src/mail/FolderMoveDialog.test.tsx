/**
 * The folder move picker (M3.9, FR-MBX-03). `moveMailbox` had zero callers before this dialog, so
 * nothing here is "reused and proven" — the legality rules are pinned in `folder-tree.test.ts`, and
 * these tests pin that the dialog ASKS them, renders their answer, and survives an absent session.
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { putMailboxes, type ReplicaDb, ReplicaProvider } from '../sync'
import { freshDb, mailbox } from '../sync/test-utils'
import { expectNoA11yViolations } from '../test/axe'
import { FolderMoveDialog } from './FolderMoveDialog'

let db: ReplicaDb

beforeEach(async () => {
  db = freshDb()
  await putMailboxes(db, 'a', [
    mailbox('inbox', { role: 'inbox' }),
    mailbox('work', { name: 'Work' }),
    mailbox('sub', { name: 'Sub', parentId: 'work' }),
    mailbox('other', { name: 'Other' }),
  ])
})

afterEach(async () => {
  await db.delete()
})

/** Mounted WITHOUT a SessionProvider on purpose — the folder tree runs that way in tests, and
 *  `useSession` would throw. An absent session must mean "no known limits", not "no moves". */
function renderDialog(subjectId: string, onMove = vi.fn()) {
  const subject = {
    accountId: 'a',
    id: subjectId,
    name: subjectId === 'work' ? 'Work' : 'Sub',
    parentId: subjectId === 'sub' ? 'work' : null,
    role: null,
    sortOrder: 0,
    totalEmails: 0,
    unreadEmails: 0,
    totalThreads: 0,
    unreadThreads: 0,
    myRights: {
      mayReadItems: true,
      mayAddItems: true,
      mayRemoveItems: true,
      maySetSeen: true,
      maySetKeywords: true,
      mayCreateChild: true,
      mayRename: true,
      mayDelete: true,
      maySubmit: true,
    },
    isSubscribed: true,
  }
  const result = render(
    <ReplicaProvider accountId="a" db={db}>
      <FolderMoveDialog mailbox={subject} onClose={vi.fn()} onMove={onMove} />
    </ReplicaProvider>,
  )
  return { ...result, onMove }
}

describe('FolderMoveDialog', () => {
  it('offers the legal targets and reports the chosen parent id', async () => {
    const user = userEvent.setup()
    const { onMove } = renderDialog('sub')

    const target = await screen.findByRole('button', { name: 'Other' })
    await user.click(target)
    expect(onMove).toHaveBeenCalledWith('other')
  })

  it('offers Top level, and reports it as null — the target MoveDialog cannot express', async () => {
    const user = userEvent.setup()
    const { onMove } = renderDialog('sub')

    await user.click(await screen.findByRole('button', { name: 'Top level' }))
    expect(onMove).toHaveBeenCalledWith(null)
  })

  it('never offers the subject itself or its own descendants', async () => {
    renderDialog('work')
    await screen.findByRole('button', { name: 'Other' })
    // 'work' is the subject; 'sub' is its child — moving into either detaches the subtree, and the
    // optimistic apply would render that as success.
    // Query by the FULL path: a nested target's accessible name is its path, so `name: 'Sub'` would
    // match nothing whether or not the row is there, and the assertion would pass for free.
    expect(screen.queryByRole('button', { name: 'Work' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Work › Sub' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Sub/ })).not.toBeInTheDocument()
  })

  it('does not offer the parent the folder is already in', async () => {
    renderDialog('sub')
    await screen.findByRole('button', { name: 'Other' })
    expect(screen.queryByRole('button', { name: 'Work' })).not.toBeInTheDocument()
  })

  it('shows the empty state when nothing is a legal target', async () => {
    await db.mailboxes.clear()
    await putMailboxes(db, 'a', [mailbox('work', { name: 'Work' })])
    renderDialog('work')
    await waitFor(() =>
      expect(screen.getByText('There is no folder this one can move into.')).toBeInTheDocument(),
    )
  })

  it('names two same-named folders apart by their path', async () => {
    // JMAP requires names to be unique among SIBLINGS only, so `Archive › 2024` and `Projects › 2024`
    // are both legal and both render a button reading "2024". The indentation separates them on
    // screen; without the path in the accessible name a screen reader hears the same target twice —
    // and a folder move, unlike a message move, has no Undo to catch the wrong pick.
    await db.mailboxes.clear()
    await putMailboxes(db, 'a', [
      mailbox('arch', { name: 'Archive' }),
      mailbox('a24', { name: '2024', parentId: 'arch' }),
      mailbox('proj', { name: 'Projects' }),
      mailbox('p24', { name: '2024', parentId: 'proj' }),
      mailbox('work', { name: 'Work' }),
      mailbox('sub', { name: 'Sub', parentId: 'work' }),
    ])
    const onMove = vi.fn()
    renderDialog('sub', onMove)

    const first = await screen.findByRole('button', { name: 'Archive › 2024' })
    expect(await screen.findByRole('button', { name: 'Projects › 2024' })).toBeInTheDocument()
    // The visible text stays short — the path lives in the name, not on screen.
    expect(first).toHaveTextContent('2024')

    await userEvent.setup().click(first)
    expect(onMove).toHaveBeenCalledWith('a24')
  })

  it('has no axe violations', async () => {
    renderDialog('sub')
    await screen.findByRole('button', { name: 'Other' })
    // The Dialog portals out of the RTL container, so scan the document (axe.ts's default).
    await expectNoA11yViolations()
  })
})
