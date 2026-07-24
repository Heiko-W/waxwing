import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  canonicalContactQueryKey,
  putContactCards,
  putContactQueryCache,
  type ReplicaDb,
  ReplicaProvider,
} from '../sync'
import { setActiveEngine } from '../sync/engine'
import { contactCard, freshDb } from '../sync/test-utils'
import { contactDisplayName } from './contact-fields'
import { useContactSearch } from './use-contact-search'

let db: ReplicaDb
const watchContactQuery = vi.fn((_spec: { filter?: { text?: string } | null }) => 'k')

function key(filter: Record<string, string>): string {
  return canonicalContactQueryKey({ filter })
}

beforeEach(async () => {
  db = freshDb()
  watchContactQuery.mockClear()
  setActiveEngine({
    watchContactQuery,
    unwatchContactQuery: vi.fn(),
  } as unknown as Parameters<typeof setActiveEngine>[0])
  await putContactCards(db, 'a', [
    contactCard('c1', { name: { full: 'Bob Brown' }, emails: {} }),
    contactCard('c2', { name: { full: 'Alice Anderson' } }),
    // Only in the SERVER search window (not the base book window) — the partially-replicated case.
    contactCard('c9', { name: { full: 'Zed Zephyr' } }),
  ])
  // Base window: the whole book.
  await putContactQueryCache(db, {
    accountId: 'a',
    key: key({ inAddressBook: 'book1' }),
    ids: ['c1', 'c2'],
    queryState: 'q',
    total: 2,
    upToId: 'c2',
    filter: { inAddressBook: 'book1' },
    sort: null,
    lastUsedAt: 1,
  })
  // Server search window for the text "zed" — surfaces c9, which the local pass cannot see.
  await putContactQueryCache(db, {
    accountId: 'a',
    key: key({ inAddressBook: 'book1', text: 'zed' }),
    ids: ['c9'],
    queryState: 'q',
    total: 1,
    upToId: 'c9',
    filter: { inAddressBook: 'book1', text: 'zed' },
    sort: null,
    lastUsedAt: 1,
  })
})

afterEach(async () => {
  setActiveEngine(null)
  await db.delete()
})

function Harness({ bookId }: { bookId?: string }) {
  const { query, setQuery, cards, searching } = useContactSearch(bookId)
  return (
    <div>
      <input aria-label="q" value={query} onChange={(event) => setQuery(event.target.value)} />
      <span data-testid="searching">{String(searching)}</span>
      <ul aria-label="results">
        {(cards ?? []).map((card) => card && <li key={card.id}>{contactDisplayName(card)}</li>)}
      </ul>
    </div>
  )
}

function renderHarness(bookId = 'book1') {
  return render(
    <ReplicaProvider accountId="a" db={db}>
      <Harness bookId={bookId} />
    </ReplicaProvider>,
  )
}

function resultNames(): string[] {
  return within(screen.getByRole('list', { name: 'results' }))
    .queryAllByRole('listitem')
    .map((item) => item.textContent ?? '')
}

describe('useContactSearch', () => {
  it('shows the whole book alphabetically when the box is empty', async () => {
    renderHarness()
    await waitFor(() => expect(resultNames()).toEqual(['Alice Anderson', 'Bob Brown']))
  })

  it('filters the replicated book INSTANTLY, before the debounce fires', async () => {
    const user = userEvent.setup()
    renderHarness()
    await waitFor(() => expect(resultNames()).toEqual(['Alice Anderson', 'Bob Brown']))
    await user.type(screen.getByLabelText('q'), 'ali')
    // Local pass is immediate; the server watch has not been asked yet (still within the debounce).
    expect(resultNames()).toEqual(['Alice Anderson'])
  })

  it('adds server-only matches after the debounce (partially-replicated book)', async () => {
    const user = userEvent.setup()
    renderHarness()
    await waitFor(() => expect(resultNames()).toEqual(['Alice Anderson', 'Bob Brown']))
    await user.type(screen.getByLabelText('q'), 'zed')
    // Zed is in neither replicated base card set locally, so it can only arrive via the server window,
    // which is watched once the debounced text lands.
    await waitFor(() => expect(resultNames()).toEqual(['Zed Zephyr']))
    // …and the engine was asked to watch a `text` query for it.
    await waitFor(() =>
      expect(watchContactQuery.mock.calls.some(([spec]) => spec.filter?.text === 'zed')).toBe(true),
    )
  })

  it('keeps the typed text across a live-query echo between keystrokes (segment-race)', async () => {
    const user = userEvent.setup()
    renderHarness()
    const input = screen.getByLabelText<HTMLInputElement>('q')
    await waitFor(() => expect(resultNames()).toEqual(['Alice Anderson', 'Bob Brown']))

    await user.type(input, 'a')
    expect(input.value).toBe('a')
    // A replica write re-renders the hook (a live-query echo) BETWEEN two keystrokes — the classic
    // controlled-input-vs-async-source trap. The typed text must survive it.
    await act(async () => {
      await putContactCards(db, 'a', [contactCard('c3', { name: { full: 'Echo' } })])
    })
    await user.type(input, 'n')
    expect(input.value).toBe('an')
  })
})
