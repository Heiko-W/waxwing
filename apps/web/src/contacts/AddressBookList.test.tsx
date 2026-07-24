import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RouterProvider } from '../app/route'
import { putAddressBooks, type ReplicaDb, ReplicaProvider } from '../sync'
import { addressBook, freshDb } from '../sync/test-utils'
import { expectNoA11yViolations } from '../test/axe'
import { AddressBookList } from './AddressBookList'

let db: ReplicaDb

beforeEach(async () => {
  window.history.pushState(null, '', '/contacts')
  db = freshDb()
  await putAddressBooks(db, 'a', [
    addressBook('personal', { name: 'Personal', isDefault: true }),
    addressBook('team', {
      name: 'Team',
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
