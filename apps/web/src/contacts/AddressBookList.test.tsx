import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RouterProvider } from '../app/route'
import { putAddressBooks, type ReplicaDb, ReplicaProvider } from '../sync'
import { setActiveEngine } from '../sync/engine'
import type { OutboxIntent } from '../sync/engine/outbox'
import { addressBook, freshDb } from '../sync/test-utils'
import { expectNoA11yViolations } from '../test/axe'
import { AddressBookList } from './AddressBookList'

let db: ReplicaDb
/** Every intent the fake engine was handed — B-5 is about which of these ever get dispatched. */
let dispatched: OutboxIntent[]

beforeEach(async () => {
  window.history.pushState(null, '', '/contacts')
  db = freshDb()
  dispatched = []
  setActiveEngine({
    dispatch: async (intent: OutboxIntent) => {
      dispatched.push(intent)
    },
  } as unknown as Parameters<typeof setActiveEngine>[0])
  await putAddressBooks(db, 'a', [
    addressBook('personal', { name: 'Personal', isDefault: true }),
    addressBook('team', {
      name: 'Team',
      myRights: { mayRead: true, mayWrite: true, mayShare: false, mayDelete: true },
      shareWith: {
        principalX: { mayRead: true, mayWrite: true, mayShare: false, mayDelete: false },
      },
    }),
    addressBook('archive', {
      name: 'Archive',
      myRights: { mayRead: true, mayWrite: false, mayShare: false, mayDelete: false },
    }),
  ])
})

afterEach(async () => {
  setActiveEngine(null)
  vi.restoreAllMocks()
  await db.delete()
})

function renderList(selectedBookId?: string) {
  return render(
    <RouterProvider>
      <ReplicaProvider accountId="a" db={db}>
        <AddressBookList selectedBookId={selectedBookId} />
      </ReplicaProvider>
    </RouterProvider>,
  )
}

describe('AddressBookList', () => {
  it('lists the books with an All Contacts entry', async () => {
    renderList()
    expect(screen.getByRole('link', { name: /All Contacts/ })).toBeInTheDocument()
    // The books resolve from the replica asynchronously; wait for one before reading the rest.
    expect(await screen.findByRole('link', { name: /Personal/ })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Team/ })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Archive/ })).toBeInTheDocument()
  })

  it('marks the default and shared books', async () => {
    renderList()
    const personal = await screen.findByRole('link', { name: /Personal/ })
    expect(personal).toHaveTextContent('Default')
    const team = screen.getByRole('link', { name: /Team/ })
    expect(team).toHaveTextContent('Shared')
  })

  it('shows a read-only marker on a book the user cannot write to', async () => {
    renderList()
    const archive = await screen.findByRole('link', { name: /Archive/ })
    expect(archive).toHaveTextContent('Read only')
    // A writable book carries no such marker.
    expect(screen.getByRole('link', { name: /Personal/ })).not.toHaveTextContent('Read only')
  })

  it('marks the selected book with aria-current', async () => {
    renderList('team')
    const team = await screen.findByRole('link', { name: /Team/ })
    expect(team).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: /Personal/ })).not.toHaveAttribute('aria-current')
  })

  it('has no axe violations', async () => {
    const { container } = renderList()
    await screen.findByRole('link', { name: /Personal/ })
    await expectNoA11yViolations(container)
  })
})

/**
 * B-5 of the JMAP gap analysis: managing address books.
 *
 * `enqueueCreateAddressBook` was implemented, tested and exported at M4.2 stage 5a and had NO UI
 * caller — this list was the whole of the feature and it was read-only. Update and destroy did not
 * exist in the outbox at all. Each test below asserts on the INTENT that reaches the engine, which
 * is where the gap was: the machinery worked, nothing called it.
 */
describe('managing address books (B-5)', () => {
  async function openMenu(user: ReturnType<typeof userEvent.setup>, name: string) {
    await user.click(await screen.findByRole('button', { name: `Actions for ${name}` }))
  }

  it('creates a book from the rail', async () => {
    const user = userEvent.setup()
    renderList()
    await screen.findByRole('link', { name: /Personal/ })

    await user.click(screen.getByRole('button', { name: 'New address book' }))
    await user.type(await screen.findByLabelText('Name'), 'Clients')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    expect(dispatched).toEqual([
      { kind: 'createAddressBook', creationId: expect.any(String), props: { name: 'Clients' } },
    ])
  })

  it('refuses a name that is blank or already taken, before anything is queued', async () => {
    const user = userEvent.setup()
    renderList()
    await screen.findByRole('link', { name: /Personal/ })

    await user.click(screen.getByRole('button', { name: 'New address book' }))
    await user.click(screen.getByRole('button', { name: 'Create' }))
    expect(screen.getByText('Enter a name.')).toBeInTheDocument()

    await user.type(screen.getByLabelText('Name'), 'personal') // case-insensitive clash
    await user.click(screen.getByRole('button', { name: 'Create' }))
    expect(screen.getByText('An address book with that name already exists.')).toBeInTheDocument()
    expect(dispatched).toEqual([])
  })

  it('renames a book', async () => {
    const user = userEvent.setup()
    renderList()
    await openMenu(user, 'Team')
    await user.click(await screen.findByRole('menuitem', { name: 'Rename' }))

    const input = await screen.findByLabelText('Name')
    expect(input).toHaveValue('Team')
    await user.clear(input)
    await user.type(input, 'Team B')
    await user.click(screen.getByRole('button', { name: 'Rename' }))

    expect(dispatched).toEqual([
      { kind: 'updateAddressBook', id: 'team', props: { name: 'Team B' } },
    ])
  })

  it('deletes a book, after saying what goes with it', async () => {
    const user = userEvent.setup()
    renderList()
    await openMenu(user, 'Team')
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }))

    // `onDestroyRemoveContents` is not optional on the wire, so the consequence is stated first.
    expect(
      screen.getByText('Contacts that are only in this address book are deleted with it.'),
    ).toBeInTheDocument()
    expect(dispatched).toEqual([]) // …and nothing is queued until it is confirmed.

    await user.click(screen.getByRole('button', { name: 'Delete' }))
    expect(dispatched).toEqual([{ kind: 'deleteAddressBook', id: 'team' }])
  })

  it('offers nothing at all on a book the user may neither write to nor delete', async () => {
    renderList()
    await screen.findByRole('link', { name: /Archive/ })
    // A menu whose every item is withheld is not an empty menu — it is not there.
    expect(screen.queryByRole('button', { name: 'Actions for Archive' })).not.toBeInTheDocument()
  })

  it('offers no delete on the default book — the server would refuse it', async () => {
    const user = userEvent.setup()
    renderList()
    await openMenu(user, 'Personal')
    expect(await screen.findByRole('menuitem', { name: 'Rename' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).not.toBeInTheDocument()
  })
})
