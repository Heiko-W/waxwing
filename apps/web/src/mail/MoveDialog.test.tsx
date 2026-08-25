/**
 * The MESSAGE move picker (M1.8, FR-ORG-01) — the one the bulk bar's "Move to…", the row context
 * menu and the `v` chord all open.
 *
 * Written for B21, which found it listing folders flat and alphabetically with nothing but the bare
 * name on each button. JMAP requires a name to be unique only among SIBLINGS, so an account with
 * `Archive › 2024` and `Projects › 2024` got two adjacent buttons reading "2024" — a coin flip for
 * a sighted reader, and two identical announcements for a screen reader. The sibling folder
 * re-parent picker had already solved this; these tests pin that this one does the same thing, and
 * that it goes on refusing the targets a move must not offer.
 */

import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { putMailboxes, type ReplicaDb, ReplicaProvider } from '../sync'
import { FULL_RIGHTS, freshDb, mailbox } from '../sync/test-utils'
import { expectNoA11yViolations } from '../test/axe'
import { MoveDialog } from './MoveDialog'

let db: ReplicaDb

beforeEach(async () => {
  db = freshDb()
  await putMailboxes(db, 'a', [
    mailbox('inbox', { role: 'inbox' }),
    mailbox('archive', { name: 'Archive', role: 'archive' }),
    mailbox('projects', { name: 'Projects' }),
    // The whole point: two folders with the SAME name under different parents.
    mailbox('a2024', { name: '2024', parentId: 'archive' }),
    mailbox('p2024', { name: '2024', parentId: 'projects' }),
    mailbox('readonly', { name: 'Read only', myRights: { ...FULL_RIGHTS, mayAddItems: false } }),
  ])
})

afterEach(async () => {
  await db.delete()
})

function renderDialog(currentMailboxId: string | null = 'inbox') {
  const onMove = vi.fn()
  const result = render(
    <ReplicaProvider accountId="a" db={db}>
      <MoveDialog open currentMailboxId={currentMailboxId} onClose={vi.fn()} onMove={onMove} />
    </ReplicaProvider>,
  )
  return { ...result, onMove }
}

describe('MoveDialog', () => {
  it('tells two same-named folders apart by their path', async () => {
    renderDialog()
    const archived = await screen.findByRole('button', { name: 'Archive › 2024' })

    // The accessible NAME carries the hierarchy; the visible label stays short, so SC 2.5.3 (label
    // in name) still holds — the path contains the visible text.
    const project = screen.getByRole('button', { name: 'Projects › 2024' })
    expect(archived).not.toBe(project)
    expect(archived.textContent).toBe('2024')
    expect(project.textContent).toBe('2024')
  })

  it('reports the id of the one that was clicked, with its short label for the toast', async () => {
    const user = userEvent.setup()
    const { onMove } = renderDialog()

    await user.click(await screen.findByRole('button', { name: 'Projects › 2024' }))
    expect(onMove).toHaveBeenCalledWith('p2024', '2024')
  })

  it('renders in tree order, not alphabetically', async () => {
    // Alphabetical order interleaves the children of different parents ("2024", "2024", "Archive",
    // "Projects"), so the indentation that is supposed to carry the hierarchy for a sighted reader
    // carries nothing at all. The tree order is what makes the indent mean something.
    renderDialog()
    // Wait for the mailbox liveQuery: the empty list renders first, and a `findByRole('list')`
    // would resolve against THAT and then read zero buttons out of it.
    await screen.findByRole('button', { name: 'Archive › 2024' })
    const labels = within(screen.getByRole('list'))
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label'))
    expect(labels).toEqual(['Archive', 'Archive › 2024', 'Projects', 'Projects › 2024'])
  })

  it('leaves out the mailbox we are moving FROM, and any we may not add to', async () => {
    renderDialog('archive')
    await screen.findByRole('button', { name: 'Archive › 2024' })
    const labels = within(screen.getByRole('list'))
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label'))
    expect(labels).not.toContain('Archive')
    expect(labels).not.toContain('Read only')
    // A child of the excluded folder is still a legal target, and still shows its true depth.
    expect(labels).toContain('Archive › 2024')
  })

  it('has no a11y violations', async () => {
    // Against `document.body`: the Dialog portals, so the RTL container is empty.
    renderDialog()
    await screen.findByRole('button', { name: 'Archive › 2024' })
    await expectNoA11yViolations()
  })
})
