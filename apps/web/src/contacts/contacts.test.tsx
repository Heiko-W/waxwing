import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RouterProvider } from '../app/route'
import { type ReplicaDb, ReplicaProvider } from '../sync'
import { setActiveEngine } from '../sync/engine'
import { freshDb } from '../sync/test-utils'
import ContactsPage from './ContactsPage'

// The list virtualizer + photo hook are exercised in their own suites; here we only assert the lazy
// page wires up the contacts area, so stub what they reach for.
vi.mock('./use-contact-photo', () => ({ useContactPhoto: () => undefined }))
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
)

let db: ReplicaDb

beforeEach(() => {
  window.history.pushState(null, '', '/contacts')
  db = freshDb()
  setActiveEngine({
    watchContactQuery: vi.fn(() => 'k'),
    unwatchContactQuery: vi.fn(),
  } as unknown as Parameters<typeof setActiveEngine>[0])
})

afterEach(async () => {
  setActiveEngine(null)
  await db.delete()
})

describe('ContactsPage', () => {
  it('renders the contacts area (default export → ContactsScreen)', () => {
    render(
      <RouterProvider>
        <ReplicaProvider accountId="a" db={db}>
          <ContactsPage />
        </ReplicaProvider>
      </RouterProvider>,
    )
    expect(screen.getByRole('navigation', { name: 'Address books' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Contacts' })).toBeInTheDocument()
  })
})
