import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONTACTS_ALL_BOOKS, RouterProvider } from '../app/route'
import {
  canonicalContactQueryKey,
  putContactCards,
  putContactQueryCache,
  type ReplicaDb,
  ReplicaProvider,
} from '../sync'
import { setActiveEngine } from '../sync/engine'
import { contactCard, freshDb } from '../sync/test-utils'
import { expectNoA11yViolations } from '../test/axe'
import { ContactList } from './ContactList'

// TanStack Virtual needs a measurable viewport; jsdom has none, so stub the primitives it reads
// (mirrors MessageList.test.tsx). A no-op observer would leave the viewport at 0 → zero rows.
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

function bookKey(bookId: string): string {
  return canonicalContactQueryKey({ filter: { inAddressBook: bookId } })
}

beforeEach(async () => {
  window.history.pushState(null, '', '/contacts/book1')
  db = freshDb()
  setActiveEngine({
    watchContactQuery: vi.fn(() => 'k'),
    unwatchContactQuery: vi.fn(),
  } as unknown as Parameters<typeof setActiveEngine>[0])
  await putContactCards(db, 'a', [
    contactCard('c1', { name: { full: 'Bob Brown' } }),
    contactCard('c2', { name: { full: 'Alice Anderson' } }),
  ])
  await putContactQueryCache(db, {
    accountId: 'a',
    key: bookKey('book1'),
    ids: ['c1', 'c2'],
    queryState: 'q',
    total: 2,
    upToId: 'c2',
    filter: { inAddressBook: 'book1' },
    sort: null,
    lastUsedAt: 1,
  })
  // The unconstrained window — what "All Contacts" reads (`buildFilter` yields `null` with no book).
  await putContactQueryCache(db, {
    accountId: 'a',
    key: canonicalContactQueryKey({ filter: null }),
    ids: ['c1', 'c2'],
    queryState: 'q',
    total: 2,
    upToId: 'c2',
    filter: null,
    sort: null,
    lastUsedAt: 1,
  })
  // An empty book (window present, no ids) for the empty-state case.
  await putContactQueryCache(db, {
    accountId: 'a',
    key: bookKey('empty'),
    ids: [],
    queryState: 'q',
    total: 0,
    upToId: null,
    filter: { inAddressBook: 'empty' },
    sort: null,
    lastUsedAt: 1,
  })
})

afterEach(async () => {
  setActiveEngine(null)
  await db.delete()
})

function renderContactList(bookId: string | undefined, selectedCardId?: string) {
  return render(
    <RouterProvider>
      <ReplicaProvider accountId="a" db={db}>
        <ContactList bookId={bookId} selectedCardId={selectedCardId} />
      </ReplicaProvider>
    </RouterProvider>,
  )
}

describe('ContactList', () => {
  it('renders the window cards alphabetically as listbox options', async () => {
    renderContactList('book1')
    await screen.findByRole('option', { name: 'Alice Anderson' })
    const listbox = screen.getByRole('listbox', { name: 'Contacts' })
    const options = within(listbox).getAllByRole('option')
    expect(options.map((option) => option.getAttribute('aria-label'))).toEqual([
      'Alice Anderson',
      'Bob Brown',
    ])
  })

  it('marks the selected card', async () => {
    renderContactList('book1', 'c1')
    const selected = await screen.findByRole('option', { name: 'Bob Brown' })
    expect(selected).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('option', { name: 'Alice Anderson' })).toHaveAttribute(
      'aria-selected',
      'false',
    )
  })

  it('shows an empty state for a book with no contacts', async () => {
    renderContactList('empty')
    expect(await screen.findByText(/No contacts yet/)).toBeInTheDocument()
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  /**
   * The "All Contacts" view is the app's default contacts route and the phone's only one, and every
   * row in it opened nothing: the list built its target with `contactsPath(undefined, card.id)`,
   * which dropped the card and returned `/contacts` — the page the reader was already on.
   *
   * The assertion is the URL rather than a navigate() spy on purpose: the defect was not a missing
   * call, it was a call to the wrong place, and only the resulting location shows that.
   */
  it('opens a card from All Contacts, where there is no book to name', async () => {
    const user = userEvent.setup()
    window.history.pushState(null, '', '/contacts')
    renderContactList(undefined)
    await user.click(await screen.findByRole('option', { name: 'Alice Anderson' }))
    expect(window.location.pathname).toBe(`/contacts/${CONTACTS_ALL_BOOKS}/c2`)
  })

  it('opens a card from a book by naming that book', async () => {
    const user = userEvent.setup()
    renderContactList('book1')
    await user.click(await screen.findByRole('option', { name: 'Bob Brown' }))
    expect(window.location.pathname).toBe('/contacts/book1/c1')
  })

  it('has no axe violations', async () => {
    const { container } = renderContactList('book1')
    await screen.findByRole('option', { name: 'Alice Anderson' })
    await expectNoA11yViolations(container)
  })

  // The EMPTY state needed its own scan, and the populated one above is why: the search box carries
  // `aria-controls` pointing at the listbox, and the empty branch renders a <p> instead of that
  // listbox. Scanning only the populated tree checks the one case where the IDREF resolves. The
  // browser sweep (e2e/tests/a11y.spec.ts) found it as `aria-valid-attr-value` — critical — in the
  // state a brand-new account starts in.
  it('has no axe violations while EMPTY (the dangling aria-controls case)', async () => {
    const { container } = renderContactList('empty')
    await screen.findByText(/No contacts yet/)
    await expectNoA11yViolations(container)
  })
})
