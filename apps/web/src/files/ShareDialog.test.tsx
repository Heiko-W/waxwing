/**
 * The share dialog (M5.18).
 *
 * The assertions that carry weight are about what a write SENDS, not what the screen shows.
 * `FileNode/set` replaces the whole `shareWith` map, so every one of these edits has to prove it
 * carried the other grantees across — a bug there silently revokes someone's access, and nothing
 * on screen would say so.
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { FileNode } from '@waxwing/jmap'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { expectNoA11yViolations } from '../test/axe'
import type { FilesClient } from './files-client'
import { ShareDialog } from './ShareDialog'
import { rightsFor } from './sharing'

const BOB = { id: 'p-bob', type: 'individual' as const, name: 'Bob Baker', email: 'bob@x.test' }
const CAROL = { id: 'p-carol', type: 'individual' as const, name: 'Carol Chen', email: 'c@x.test' }

const setShareWith = vi.fn(async () => {})
const searchPrincipals = vi.fn(async () => [BOB, CAROL])
const onChanged = vi.fn()

const client = {
  list: async () => [],
  upload: async () => null,
  createFolder: async () => {},
  rename: async () => {},
  destroy: async () => {},
  download: async () => null,
  searchPrincipals,
  setShareWith,
} as unknown as FilesClient

function node(shareWith: FileNode['shareWith']): FileNode {
  return {
    id: 'n1',
    parentId: null,
    nodeType: 'directory',
    blobId: null,
    target: null,
    size: 0,
    name: 'Reports',
    type: null,
    created: '2026-08-01T00:00:00Z',
    modified: '2026-08-01T00:00:00Z',
    accessed: '2026-08-01T00:00:00Z',
    changed: '2026-08-01T00:00:00Z',
    executable: false,
    isSubscribed: true,
    myRights: {
      mayRead: true,
      mayAddChildren: true,
      mayRename: true,
      mayDelete: true,
      mayModifyContent: true,
      mayShare: true,
    },
    shareWith,
    role: null,
  }
}

function renderDialog(shareWith: FileNode['shareWith'] = {}) {
  return render(
    <ShareDialog node={node(shareWith)} client={client} onClose={() => {}} onChanged={onChanged} />,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  searchPrincipals.mockResolvedValue([BOB, CAROL])
})

describe('who is offered', () => {
  it('lists candidates once the search returns', async () => {
    renderDialog()
    expect(await screen.findByText('Bob Baker')).toBeInTheDocument()
    expect(screen.getByText('Carol Chen')).toBeInTheDocument()
  })

  it('does not offer someone who already has access', async () => {
    renderDialog({ 'p-bob': rightsFor('viewer') })
    await screen.findByText('Carol Chen')
    // Bob appears once — in the current-access list — and not as a candidate to add again.
    expect(screen.queryByRole('button', { name: /Give Bob Baker access/i })).not.toBeInTheDocument()
  })

  it('says so when nobody matches instead of showing an empty box', async () => {
    searchPrincipals.mockResolvedValue([])
    renderDialog()
    expect(await screen.findByText(/Nobody matches/i)).toBeInTheDocument()
  })
})

describe('granting', () => {
  it('sends the chosen role', async () => {
    renderDialog()
    await screen.findByText('Bob Baker')
    await userEvent.click(screen.getByRole('button', { name: /Give Bob Baker access/i }))
    await waitFor(() => expect(setShareWith).toHaveBeenCalled())
    expect(setShareWith).toHaveBeenCalledWith('n1', { 'p-bob': rightsFor('viewer') })
  })

  it('KEEPS everyone else in the map', async () => {
    // The bug this exists to catch: sending only the new grant revokes every existing one, because
    // `FileNode/set` replaces the property rather than merging into it.
    renderDialog({ 'p-dave': rightsFor('editor') })
    await screen.findByText('Bob Baker')
    await userEvent.click(screen.getByRole('button', { name: /Give Bob Baker access/i }))
    await waitFor(() => expect(setShareWith).toHaveBeenCalled())
    expect(setShareWith).toHaveBeenCalledWith('n1', {
      'p-dave': rightsFor('editor'),
      'p-bob': rightsFor('viewer'),
    })
  })

  it('grants the role selected before the click, not the default', async () => {
    renderDialog()
    await screen.findByText('Bob Baker')
    await userEvent.selectOptions(screen.getByLabelText('They may'), 'manager')
    await userEvent.click(screen.getByRole('button', { name: /Give Bob Baker access/i }))
    await waitFor(() => expect(setShareWith).toHaveBeenCalled())
    expect(setShareWith).toHaveBeenCalledWith('n1', { 'p-bob': rightsFor('manager') })
  })

  it('spells out what the role means, including that a manager can re-share', async () => {
    renderDialog()
    await screen.findByText('Bob Baker')
    await userEvent.selectOptions(screen.getByLabelText('They may'), 'manager')
    expect(screen.getByText(/sharing it with other people/i)).toBeInTheDocument()
  })
})

describe('changing and revoking', () => {
  it('replaces the role rather than merging into it', async () => {
    renderDialog({ 'p-bob': rightsFor('manager') })
    await screen.findByText('Bob Baker')
    await userEvent.selectOptions(screen.getByLabelText('What Bob Baker may do'), 'viewer')
    await waitFor(() => expect(setShareWith).toHaveBeenCalled())
    // mayShare must be GONE, not left behind from the old role.
    expect(setShareWith).toHaveBeenCalledWith('n1', { 'p-bob': rightsFor('viewer') })
  })

  it('removes only the one revoked', async () => {
    renderDialog({ 'p-bob': rightsFor('viewer'), 'p-carol': rightsFor('editor') })
    await screen.findByText('Bob Baker')
    await userEvent.click(screen.getByRole('button', { name: /Remove Bob Baker/i }))
    await waitFor(() => expect(setShareWith).toHaveBeenCalled())
    expect(setShareWith).toHaveBeenCalledWith('n1', { 'p-carol': rightsFor('editor') })
  })

  it('tells the page to reload, so the row behind the dialog stops lying', async () => {
    renderDialog()
    await screen.findByText('Bob Baker')
    await userEvent.click(screen.getByRole('button', { name: /Give Bob Baker access/i }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })
})

describe('rights this client did not set', () => {
  it('shows them as custom rather than picking a role for them', async () => {
    renderDialog({ 'p-bob': { mayRead: true, mayShare: true } })
    await screen.findByText('Bob Baker')
    expect(screen.getByText(/Custom access/i)).toBeInTheDocument()
    // No role picker: choosing one would overwrite a grant this client cannot describe.
    expect(screen.queryByLabelText('What Bob Baker may do')).not.toBeInTheDocument()
  })

  it('still allows revoking, which is unambiguous', async () => {
    renderDialog({ 'p-bob': { mayRead: true, mayShare: true } })
    await screen.findByText('Bob Baker')
    await userEvent.click(screen.getByRole('button', { name: /Remove Bob Baker/i }))
    await waitFor(() => expect(setShareWith).toHaveBeenCalledWith('n1', {}))
  })
})

describe('when the write fails', () => {
  it('says so and keeps showing what the server still has', async () => {
    setShareWith.mockRejectedValueOnce(new Error('nope'))
    renderDialog({ 'p-carol': rightsFor('editor') })
    await screen.findByText('Bob Baker')
    await userEvent.click(screen.getByRole('button', { name: /Give Bob Baker access/i }))

    expect(await screen.findByText(/was not saved/i)).toBeInTheDocument()
    // Bob must still be offered as a candidate: he was never actually granted anything.
    expect(screen.getByRole('button', { name: /Give Bob Baker access/i })).toBeInTheDocument()
    expect(onChanged).not.toHaveBeenCalled()
  })
})

describe('accessibility', () => {
  it('has no violations with grantees and candidates on screen', async () => {
    // Scanned against document.body: the dialog renders through a portal, so the RTL container is
    // empty.
    renderDialog({ 'p-dave': rightsFor('editor') })
    await screen.findByText('Bob Baker')
    await expectNoA11yViolations()
  })
})
