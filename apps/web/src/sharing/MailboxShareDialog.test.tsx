/**
 * Sharing a mail folder, end to end through the dialog (S-3).
 *
 * The generic surface is covered by `files/ShareDialog.test.tsx`, which was written before this
 * existed and passes unchanged against the lifted component. What is asserted here is what only a
 * MAILBOX can get wrong: the load that must happen before anything is shown, the wording that has
 * to warn about `maySetSeen`, and the ten-key map that goes on the wire.
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Id, MailboxRights, Principal } from '@waxwing/jmap'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { expectNoA11yViolations } from '../test/axe'
import { MailboxShareDialog } from './MailboxShareDialog'
import { mailboxRoles } from './mailbox'
import type { MailboxSharingClient } from './mailbox-client'

const BOB: Principal = { id: 'p-bob', type: 'individual', name: 'Bob Baker', email: 'bob@x.test' }

const load = vi.fn<(id: Id) => Promise<Record<Id, MailboxRights>>>()
const setShareWith = vi.fn<(id: Id, shareWith: Record<Id, MailboxRights>) => Promise<void>>()
const searchPrincipals = vi.fn<(query: string) => Promise<Principal[]>>()

const client: MailboxSharingClient = { load, setShareWith, searchPrincipals }

function renderDialog() {
  return render(
    <MailboxShareDialog mailboxId="a" name="Projekt" client={client} onClose={() => {}} />,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  load.mockResolvedValue({})
  setShareWith.mockResolvedValue(undefined)
  searchPrincipals.mockResolvedValue([BOB])
})

describe('the load that has to come first', () => {
  it('fetches the grant map before showing anything about access', async () => {
    /*
     * `Mailbox/get` omits `shareWith` unless it is named in `properties` (measured), so unlike a
     * file node the folder's grant map is NOT on hand when the dialog opens. Rendering "Only you"
     * over an unloaded map would be a lie, and the first edit made from that view would write `{}`
     * back over everyone's access.
     */
    let resolve: (value: Record<Id, MailboxRights>) => void = () => {}
    load.mockReturnValue(
      new Promise<Record<Id, MailboxRights>>((r) => {
        resolve = r
      }),
    )
    renderDialog()
    expect(screen.queryByText('Only you.')).not.toBeInTheDocument()
    resolve({})
    expect(await screen.findByText('Only you.')).toBeInTheDocument()
  })

  it('refuses to edit rather than guess when the load fails', async () => {
    load.mockRejectedValue(new Error('nope'))
    renderDialog()
    expect(await screen.findByText(/could not be loaded/i)).toBeInTheDocument()
    expect(screen.queryByLabelText('They may')).not.toBeInTheDocument()
  })

  it('names the folder in the title', async () => {
    renderDialog()
    expect(await screen.findByRole('heading', { name: /Projekt/ })).toBeInTheDocument()
  })
})

describe('what the roles say, in words', () => {
  it('warns that View will NOT mark the owner’s mail as read', async () => {
    /*
     * The one place mail breaks the three-role model, and the consequence has to be in the dialog:
     * "View" withholds `maySetSeen` so the reader cannot mark the owner's post read — which also
     * means their own unread count never moves. A user who is not told discovers it as a bug.
     */
    renderDialog()
    await screen.findByText('Bob Baker')
    expect(screen.getByText(/will not mark it read for you/i)).toBeInTheDocument()
  })

  it('says Manage can re-share without telling you', async () => {
    renderDialog()
    await screen.findByText('Bob Baker')
    await userEvent.selectOptions(screen.getByLabelText('They may'), 'manager')
    expect(screen.getByText(/without telling you/i)).toBeInTheDocument()
  })

  it('offers the three roles as names, never as permission keys', async () => {
    renderDialog()
    await screen.findByText('Bob Baker')
    const picker = screen.getByLabelText('They may') as HTMLSelectElement
    expect([...picker.options].map((option) => option.text)).toEqual(['View', 'Edit', 'Manage'])
  })
})

describe('what goes on the wire', () => {
  it('sends the full ten-key map for the chosen role', async () => {
    renderDialog()
    await screen.findByText('Bob Baker')
    await userEvent.click(screen.getByRole('button', { name: /Give Bob Baker access/i }))
    await waitFor(() => expect(setShareWith).toHaveBeenCalled())
    expect(setShareWith).toHaveBeenCalledWith('a', { 'p-bob': mailboxRoles.rightsFor('viewer') })
    // The measured shape: ten keys, `maySetSeen` and `maySubmit` explicitly false.
    const sent = setShareWith.mock.calls[0]?.[1] ?? {}
    expect(Object.keys(sent['p-bob'] ?? {})).toHaveLength(10)
    expect(sent['p-bob']?.maySetSeen).toBe(false)
    expect(sent['p-bob']?.maySubmit).toBe(false)
  })

  it('KEEPS everyone else in the map', async () => {
    // `Mailbox/set` replaces the property rather than merging into it, so a write that carried only
    // the new grant would silently revoke every existing one.
    load.mockResolvedValue({ 'p-dave': mailboxRoles.rightsFor('editor') })
    renderDialog()
    await screen.findByText('Bob Baker')
    await userEvent.click(screen.getByRole('button', { name: /Give Bob Baker access/i }))
    await waitFor(() => expect(setShareWith).toHaveBeenCalled())
    expect(setShareWith).toHaveBeenCalledWith('a', {
      'p-dave': mailboxRoles.rightsFor('editor'),
      'p-bob': mailboxRoles.rightsFor('viewer'),
    })
  })

  it('keeps showing what the server still has when a write fails', async () => {
    setShareWith.mockRejectedValueOnce(new Error('forbidden'))
    renderDialog()
    await screen.findByText('Bob Baker')
    await userEvent.click(screen.getByRole('button', { name: /Give Bob Baker access/i }))
    expect(await screen.findByText(/was not saved/i)).toBeInTheDocument()
    // Bob is still a candidate: he was never granted anything.
    expect(screen.getByRole('button', { name: /Give Bob Baker access/i })).toBeInTheDocument()
  })
})

describe('accessibility', () => {
  it('has no violations with a grantee and a candidate on screen', async () => {
    load.mockResolvedValue({ 'p-dave': mailboxRoles.rightsFor('editor') })
    renderDialog()
    await screen.findByText('Bob Baker')
    // Scanned against document.body: the dialog renders through a portal.
    await expectNoA11yViolations()
  })
})
