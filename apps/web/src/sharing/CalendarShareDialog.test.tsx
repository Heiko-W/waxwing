/**
 * Sharing a calendar, end to end through the dialog (S-2).
 *
 * The generic surface is covered by `files/ShareDialog.test.tsx` and the mailbox one by
 * `MailboxShareDialog.test.tsx`. What only a CALENDAR can get wrong is the count and the default:
 *
 *  - **four roles are offered, not three.** The dialog used to iterate a module-level list of three,
 *    and against this model that would silently hide "Availability only" — the one role in the app
 *    that lets a colleague plan around you without reading a word of your diary.
 *  - **the picker opens on the LEAST of them.** Whatever Add grants to somebody who never touched
 *    the role select is the grant most people will actually make.
 *  - **what reaches the wire for that role is one `true`.**
 */

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { CalendarRights, Id, Principal } from '@waxwing/jmap'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { expectNoA11yViolations } from '../test/axe'
import { CalendarShareDialog } from './CalendarShareDialog'
import { calendarRoles } from './calendar-roles'
import type { CalendarSharingClient } from './calendar-share-client'

const BOB: Principal = { id: 'p-bob', type: 'individual', name: 'Bob Baker', email: 'bob@x.test' }

const setShareWith = vi.fn<(id: Id, shareWith: Record<Id, CalendarRights>) => Promise<void>>()
const searchPrincipals = vi.fn<(query: string) => Promise<Principal[]>>()
const client: CalendarSharingClient = { setShareWith, searchPrincipals }

function renderDialog(shareWith: Record<Id, CalendarRights> | null = null) {
  return render(
    <CalendarShareDialog
      calendarId="c1"
      name="Projekt"
      shareWith={shareWith}
      client={client}
      onClose={() => {}}
      onChanged={() => {}}
    />,
  )
}

/** The role `<Select>` in the "give access to someone" half. */
function rolePicker(): HTMLSelectElement {
  return screen.getByLabelText('They may') as HTMLSelectElement
}

beforeEach(() => {
  vi.clearAllMocks()
  setShareWith.mockResolvedValue(undefined)
  searchPrincipals.mockResolvedValue([BOB])
})

describe('the four roles', () => {
  it('offers all four, and names availability among them', async () => {
    renderDialog()
    await waitFor(() => expect(searchPrincipals).toHaveBeenCalled())
    const options = within(rolePicker())
      .getAllByRole('option')
      .map((option) => option.textContent)
    expect(options).toEqual(['Availability only', 'View', 'Edit', 'Manage'])
  })

  it('opens on the LEAST of them, so the safe grant is the unconsidered one', async () => {
    renderDialog()
    await waitFor(() => expect(searchPrincipals).toHaveBeenCalled())
    expect(rolePicker().value).toBe('freeBusy')
  })

  it('explains it in the calendar’s own terms, not a generic sentence', async () => {
    renderDialog()
    await waitFor(() => expect(searchPrincipals).toHaveBeenCalled())
    // The promise the role makes, spelled out: times, never titles.
    expect(screen.getByText(/never what you are doing/i)).toBeInTheDocument()
  })
})

describe('the grant that reaches the client', () => {
  it('writes `mayReadFreeBusy` and nothing else for the default role', async () => {
    renderDialog()
    await screen.findByRole('button', { name: 'Give Bob Baker access' })
    await userEvent.click(screen.getByRole('button', { name: 'Give Bob Baker access' }))

    await waitFor(() => expect(setShareWith).toHaveBeenCalled())
    const [, shareWith] = setShareWith.mock.calls[0] ?? []
    expect(shareWith?.['p-bob']).toEqual(calendarRoles.rightsFor('freeBusy'))
    expect(shareWith?.['p-bob']?.mayReadItems).toBe(false)
  })

  it('carries an existing grantee across, so a second share does not revoke the first', async () => {
    renderDialog({ 'p-carol': calendarRoles.rightsFor('manager') })
    await screen.findByRole('button', { name: 'Give Bob Baker access' })
    await userEvent.click(screen.getByRole('button', { name: 'Give Bob Baker access' }))

    await waitFor(() => expect(setShareWith).toHaveBeenCalled())
    const [, shareWith] = setShareWith.mock.calls[0] ?? []
    expect(Object.keys(shareWith ?? {}).sort()).toEqual(['p-bob', 'p-carol'])
  })

  it('sends the calendar’s OWN id, not the account’s', async () => {
    renderDialog()
    await screen.findByRole('button', { name: 'Give Bob Baker access' })
    await userEvent.click(screen.getByRole('button', { name: 'Give Bob Baker access' }))
    await waitFor(() => expect(setShareWith).toHaveBeenCalledWith('c1', expect.anything()))
  })
})

describe('what is already granted', () => {
  it('shows an availability-only grantee as such, not as a viewer', async () => {
    renderDialog({ 'p-bob': calendarRoles.rightsFor('freeBusy') })
    // By NAME, not by id: the dialog resolves the id through the principal search, so waiting for
    // this label is also the wait for that search.
    const row = (await screen.findByLabelText('What Bob Baker may do')) as HTMLSelectElement
    expect(row.value).toBe('freeBusy')
  })

  it('opens straight into the lists — a calendar needs no load', () => {
    renderDialog({ 'p-bob': calendarRoles.rightsFor('viewer') })
    // No spinner, no "could not be loaded": the map came with the object.
    expect(screen.getByText('Who has access')).toBeInTheDocument()
  })
})

describe('accessibility', () => {
  it('has no violations with a grantee on screen', async () => {
    renderDialog({ 'p-bob': calendarRoles.rightsFor('editor') })
    await screen.findByLabelText('What Bob Baker may do')
    // Scanned against document.body: the dialog renders through a portal.
    await expectNoA11yViolations()
  })
})
