import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { RouterProvider } from '../app/route'
import {
  canonicalContactQueryKey,
  putAddressBooks,
  putContactCards,
  putContactQueryCache,
  type ReplicaDb,
  ReplicaProvider,
} from '../sync'
import { setActiveEngine } from '../sync/engine'
import { addressBook, contactCard, freshDb } from '../sync/test-utils'
import { expectNoA11yViolations } from '../test/axe'
import { ContactsScreen } from './ContactsScreen'

// The photo hook needs a session; not under test here.
vi.mock('./use-contact-photo', () => ({ useContactPhoto: () => undefined }))

// TanStack Virtual viewport stubs (see ContactList.test.tsx).
const rect = { width: 400, height: 600, top: 0, left: 0, right: 400, bottom: 600, x: 0, y: 0 }
class FakeResizeObserver {
  constructor(private readonly cb: ResizeObserverCallback) {}
  observe(target: Element): void {
    this.cb(
      [
        {
          target,
          contentRect: rect,
          borderBoxSize: [{ inlineSize: rect.width, blockSize: rect.height }],
          contentBoxSize: [{ inlineSize: rect.width, blockSize: rect.height }],
          devicePixelContentBoxSize: [{ inlineSize: rect.width, blockSize: rect.height }],
        } as unknown as ResizeObserverEntry,
      ],
      this as unknown as ResizeObserver,
    )
  }
  unobserve(): void {}
  disconnect(): void {}
}

const originalMatchMedia = window.matchMedia

/** Force the phone tier (no `matchMedia` match → `useLayoutTier` returns 'phone'). */
function forcePhone(): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent() {
        return false
      },
    }),
  })
}

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ ...rect, toJSON: () => rect }),
  })
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: () => {} })
})
afterAll(() => vi.unstubAllGlobals())

let db: ReplicaDb

beforeEach(async () => {
  db = freshDb()
  setActiveEngine({
    watchContactQuery: vi.fn(() => 'k'),
    unwatchContactQuery: vi.fn(),
  } as unknown as Parameters<typeof setActiveEngine>[0])
  await putAddressBooks(db, 'a', [addressBook('personal', { name: 'Personal', isDefault: true })])
  await putContactCards(db, 'a', [
    contactCard('c1', { name: { full: 'Alice Anderson' } }),
    contactCard('c2', { name: { full: 'Bob Brown' } }),
  ])
  await putContactQueryCache(db, {
    accountId: 'a',
    key: canonicalContactQueryKey({ filter: { inAddressBook: 'personal' } }),
    ids: ['c1', 'c2'],
    queryState: 'q',
    total: 2,
    upToId: 'c2',
    filter: { inAddressBook: 'personal' },
    sort: null,
    lastUsedAt: 1,
  })
})

afterEach(async () => {
  setActiveEngine(null)
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: originalMatchMedia,
  })
  await db.delete()
})

function renderScreen(path: string) {
  window.history.pushState(null, '', path)
  return render(
    <RouterProvider>
      <ReplicaProvider accountId="a" db={db}>
        <ContactsScreen />
      </ReplicaProvider>
    </RouterProvider>,
  )
}

describe('ContactsScreen', () => {
  it('exposes the three-pane landmarks on a wide screen', async () => {
    renderScreen('/contacts/personal')
    expect(screen.getByRole('navigation', { name: 'Address books' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Contacts' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Contact' })).toBeInTheDocument()
    // Desktop splits list beside detail — the resize separator is present.
    expect(screen.getByRole('separator')).toBeInTheDocument()
    // The list actually mounts.
    await screen.findByRole('option', { name: 'Alice Anderson' })
  })

  it('collapses to the list pane on a phone with no card selected', () => {
    forcePhone()
    renderScreen('/contacts/personal')
    expect(screen.getByRole('region', { name: 'Contacts' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Contact' })).not.toBeInTheDocument()
    expect(screen.queryByRole('separator')).not.toBeInTheDocument()
  })

  it('collapses to the detail pane on a phone when a card is open, with a Back control', () => {
    forcePhone()
    renderScreen('/contacts/personal/c1')
    expect(screen.getByRole('region', { name: 'Contact' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Contacts' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Back to contacts/ })).toBeInTheDocument()
  })

  it('selects a contact through the route (opening one shows it in the detail pane)', async () => {
    const user = userEvent.setup()
    renderScreen('/contacts/personal')
    await user.click(await screen.findByRole('option', { name: 'Alice Anderson' }))
    // Navigation updated the route → the detail pane renders the card's heading.
    expect(await screen.findByRole('heading', { name: 'Alice Anderson' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/contacts/personal/c1')
  })

  it('has no axe violations', async () => {
    const { container } = renderScreen('/contacts/personal')
    await screen.findByRole('option', { name: 'Alice Anderson' })
    await expectNoA11yViolations(container)
  })

  it('opens (and cancels) the create form from the New contact button', async () => {
    const user = userEvent.setup()
    renderScreen('/contacts/personal')
    await screen.findByRole('option', { name: 'Alice Anderson' })

    await user.click(screen.getByRole('button', { name: 'New contact' }))
    expect(screen.getByRole('heading', { name: 'New contact' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('heading', { name: 'New contact' })).not.toBeInTheDocument()
  })

  it('disables New contact in a read-only address book (read-only guard)', async () => {
    await putAddressBooks(db, 'a', [
      addressBook('ro', {
        name: 'Shared',
        myRights: { mayRead: true, mayWrite: false, mayShare: false, mayDelete: false },
      }),
    ])
    renderScreen('/contacts/ro')
    expect(screen.getByRole('button', { name: 'New contact' })).toBeDisabled()
  })

  it('opens the edit form for a card in a writable book', async () => {
    // Re-home c1 into the writable "personal" book so the write guard permits editing.
    await putContactCards(db, 'a', [
      contactCard('c1', { name: { full: 'Alice Anderson' }, addressBookIds: { personal: true } }),
    ])
    const user = userEvent.setup()
    renderScreen('/contacts/personal/c1')

    const edit = await screen.findByRole('button', { name: /Edit/ })
    // The write guard depends on two live queries (the card AND its books). The button appears with
    // the card; wait for the books query to settle before asserting it is enabled, so the assertion
    // does not race the load order under parallel test load.
    await waitFor(() => expect(edit).toBeEnabled())
    await user.click(edit)
    expect(screen.getByRole('heading', { name: 'Edit contact' })).toBeInTheDocument()
  })
})
