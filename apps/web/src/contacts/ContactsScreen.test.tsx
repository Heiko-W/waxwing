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
import type { OutboxIntent } from '../sync/engine/outbox'
import { setActiveEngine } from '../sync/engine'
import { deleteContactCards } from '../sync/repo'
import { addressBook, contactCard, freshDb } from '../sync/test-utils'
import { expectNoA11yViolations } from '../test/axe'
import { clickButton } from '../test/interact'
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
/** Every intent the fake engine was handed, so a test can read the creation id back out of it. */
let dispatched: OutboxIntent[]

beforeEach(async () => {
  db = freshDb()
  dispatched = []
  setActiveEngine({
    watchContactQuery: vi.fn(() => 'k'),
    unwatchContactQuery: vi.fn(),
    // Just the optimistic half of the real `dispatch`: write the card under its creation id, which
    // is what makes the create/reconcile sequence reproducible here.
    dispatch: async (intent: OutboxIntent) => {
      dispatched.push(intent)
      if (intent.kind === 'createContactCard') await putContactCards(db, 'a', [intent.card])
    },
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

  /**
   * Every save used to land on "This contact is not available.", over a contact that had been
   * created perfectly: the route was pointed at the CREATION id, and the acknowledgement re-files
   * the row under the id the server chose. This drives the whole sequence — optimistic write, then
   * the reconcile — and asserts the route ends up on the server's id.
   */
  it('follows a newly created contact from its creation id to the id the server gave it', async () => {
    const user = userEvent.setup()
    renderScreen('/contacts/personal')
    await screen.findByRole('option', { name: 'Alice Anderson' })

    await clickButton(user, 'New contact')
    await user.type(screen.getByLabelText('First name'), 'Zoe')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    const intent = dispatched.find((entry) => entry.kind === 'createContactCard')
    if (intent?.kind !== 'createContactCard') throw new Error('no create was dispatched')
    const creationId = intent.creationId
    // Until the server answers there is no other id to use, and the optimistic row IS there.
    await waitFor(() => expect(window.location.pathname).toBe(`/contacts/personal/${creationId}`))
    expect(await screen.findByRole('heading', { name: 'Zoe' })).toBeInTheDocument()

    // What `reconcileContactCardCreate` does on the acknowledgement: the temp row goes, the same
    // card comes back under the server's id.
    await deleteContactCards(db, 'a', [creationId])
    await putContactCards(db, 'a', [{ ...intent.card, id: 'srv-9' }])

    await waitFor(() => expect(window.location.pathname).toBe('/contacts/personal/srv-9'))
    // …and the detail pane settles on the card, not on the dead end the old route led to.
    await waitFor(() =>
      expect(screen.queryByText('This contact is not available.')).not.toBeInTheDocument(),
    )
    expect(screen.getByRole('heading', { name: 'Zoe' })).toBeInTheDocument()
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

    // Same shape as B46: `New contact` is disabled until `useAddressBooks()` resolves. The wait for
    // Alice above usually covers it — two liveQueries over one replica — but "usually" is what B46
    // turned out to mean, and nothing here makes the two resolve in order.
    await clickButton(user, 'New contact')
    expect(screen.getByRole('heading', { name: 'New contact' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('heading', { name: 'New contact' })).not.toBeInTheDocument()
  })

  describe('address-book drawer on a phone', () => {
    it('closes on a second press of the toggle it opened with', async () => {
      // It only ever opened: the handler was `setBooksOpen(true)`, and the label stayed "Show
      // address books" while `aria-expanded` said `true`. Escape and a backdrop tap were the only
      // ways out, and neither is something a reader can see.
      forcePhone()
      const user = userEvent.setup()
      renderScreen('/contacts/personal')

      const toggle = screen.getByRole('button', { name: 'Show address books' })
      await user.click(toggle)
      expect(toggle).toHaveAttribute('aria-expanded', 'true')
      expect(toggle).toHaveAccessibleName('Hide address books')

      await user.click(toggle)
      expect(toggle).toHaveAttribute('aria-expanded', 'false')
      expect(toggle).toHaveAccessibleName('Show address books')
    })

    it('closes once a book has been chosen, so the list under it is usable', async () => {
      forcePhone()
      const user = userEvent.setup()
      renderScreen('/contacts')

      const toggle = screen.getByRole('button', { name: 'Show address books' })
      await user.click(toggle)
      await user.click(screen.getByRole('link', { name: /Personal/ }))

      expect(toggle).toHaveAttribute('aria-expanded', 'false')
      expect(window.location.pathname).toBe('/contacts/personal')
    })
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
