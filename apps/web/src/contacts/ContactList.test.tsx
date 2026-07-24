import { render, screen, within } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { RouterProvider } from '../app/route'
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

function renderContactList(bookId: string, selectedCardId?: string) {
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
    expect(await screen.findByText('No contacts.')).toBeInTheDocument()
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('has no axe violations', async () => {
    const { container } = renderContactList('book1')
    await screen.findByRole('option', { name: 'Alice Anderson' })
    await expectNoA11yViolations(container)
  })
})
