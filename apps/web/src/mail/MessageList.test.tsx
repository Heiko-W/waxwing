import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '../app/config'
import { ConfigProvider } from '../app/config-context'
import { RouterProvider } from '../app/route'
import {
  canonicalQueryKey,
  putEmails,
  putMailboxes,
  putQueryCache,
  type QuerySpec,
  type ReplicaDb,
  ReplicaProvider,
} from '../sync'
import { setActiveEngine, windowQueryKey } from '../sync/engine'
import { email, freshDb, mailbox } from '../sync/test-utils'
import { MessageList } from './MessageList'

// The virtualizer needs a measurable viewport; jsdom has no layout, so stub the primitives it reads.
// TanStack Virtual measures the scroll element from the ResizeObserver's borderBoxSize, so the fake
// must FIRE its callback on observe (a no-op observer would leave the viewport at 0 → zero rows).
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

const dispatch = vi.fn()
let db: ReplicaDb

/** The exact key useMessageList computes for the inbox with the default (date desc, threaded) view. */
function inboxKey(): string {
  return windowQueryKey('inbox', DEFAULT_CONFIG.offline.cacheDays, Date.now(), {
    sort: [{ property: 'receivedAt', isAscending: false }],
    collapseThreads: true,
  }).key
}

beforeEach(async () => {
  db = freshDb()
  dispatch.mockReset()
  setActiveEngine({
    watchWindow: vi.fn(() => 'k'),
    loadMoreFor: vi.fn(),
    fetchEnvelopes: vi.fn(),
    dispatch,
  } as unknown as Parameters<typeof setActiveEngine>[0])
  await putMailboxes(db, 'a', [
    mailbox('inbox', { role: 'inbox' }),
    mailbox('archive', { role: 'archive' }),
    mailbox('trash', { role: 'trash' }),
  ])
  await putEmails(db, 'a', [
    email('e1', { from: [{ name: 'Alice', email: 'a@x.test' }], subject: 'First', keywords: {} }),
    email('e2', { from: [{ name: 'Bob', email: 'b@x.test' }], subject: 'Second', keywords: {} }),
    email('e3', { from: [{ name: 'Carol', email: 'c@x.test' }], subject: 'Third', keywords: {} }),
  ])
  await putQueryCache(db, {
    accountId: 'a',
    key: inboxKey(),
    ids: ['e1', 'e2', 'e3'],
    queryState: 'q',
    total: 3,
    upToId: 'e3',
    filter: null,
    sort: null,
    collapseThreads: true,
    lastUsedAt: 1,
  })
})

afterEach(async () => {
  setActiveEngine(null)
  await db.delete()
})

function renderList() {
  return render(
    <RouterProvider>
      <ConfigProvider config={DEFAULT_CONFIG}>
        <ReplicaProvider accountId="a" db={db}>
          <MessageList mailboxId="inbox" />
        </ReplicaProvider>
      </ConfigProvider>
    </RouterProvider>,
  )
}

describe('MessageList', () => {
  it('renders the window rows in order from the replica', async () => {
    renderList()
    expect(await screen.findByText('First')).toBeInTheDocument()
    expect(screen.getByText('Second')).toBeInTheDocument()
    expect(screen.getByText('Third')).toBeInTheDocument()
    expect(screen.getByRole('grid')).toHaveAttribute('aria-rowcount', '3')
  })

  it('opens a message by navigating (row becomes aria-current)', async () => {
    const user = userEvent.setup()
    renderList()
    const first = (await screen.findByText('First')).closest('[role="row"]') as HTMLElement
    await user.click(first)
    await waitFor(() => expect(first).toHaveAttribute('aria-current', 'page'))
  })

  it('shows the bulk bar and dispatches a mark-read intent over the selection', async () => {
    const user = userEvent.setup()
    renderList()
    await screen.findByText('First')
    await user.click(screen.getAllByRole('checkbox', { name: 'Select message' })[0] as HTMLElement)

    expect(await screen.findByText('1 selected')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Mark as read' }))

    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      kind: 'setKeywords',
      keyword: '$seen',
      value: true,
      emailIds: ['e1'],
    })
  })

  it('select-all covers the whole window id-set', async () => {
    const user = userEvent.setup()
    renderList()
    await screen.findByText('First')
    // Select one row, then use the bulk-bar select-all checkbox.
    await user.click(screen.getAllByRole('checkbox', { name: 'Select message' })[0] as HTMLElement)
    await user.click(await screen.findByRole('checkbox', { name: 'Select all' }))
    expect(await screen.findByText('3 selected')).toBeInTheDocument()
  })

  it('moves aria-activedescendant with ArrowDown (grid keeps focus, review regression)', async () => {
    const user = userEvent.setup()
    renderList()
    await screen.findByText('First')
    const grid = screen.getByRole('grid')
    grid.focus()
    expect(grid.getAttribute('aria-activedescendant')).toMatch(/-r-e1$/) // starts on the first row
    await user.keyboard('{ArrowDown}')
    expect(grid.getAttribute('aria-activedescendant')).toMatch(/-r-e2$/) // moved, container still focused
    expect(document.activeElement).toBe(grid)
  })

  it('clears the selection after an archive move (review regression)', async () => {
    const user = userEvent.setup()
    renderList()
    await screen.findByText('First')
    await user.click(screen.getAllByRole('checkbox', { name: 'Select message' })[0] as HTMLElement)
    expect(await screen.findByText('1 selected')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Archive' }))
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({ kind: 'move', emailIds: ['e1'] })
    // The moved row must leave the selection so the bulk bar closes.
    await waitFor(() => expect(screen.queryByText('1 selected')).toBeNull())
  })

  it('watches the window once the engine becomes active after mount (review regression)', async () => {
    setActiveEngine(null)
    const watchWindow = vi.fn(() => 'k')
    renderList()
    await screen.findByText('First') // rows come from the seeded queryCache even with no engine
    setActiveEngine({
      watchWindow,
      loadMoreFor: vi.fn(),
      dispatch,
    } as unknown as Parameters<typeof setActiveEngine>[0])
    await waitFor(() => expect(watchWindow).toHaveBeenCalledWith('inbox', expect.anything()))
  })

  it('opens the label picker with the "l" shortcut for the focused row (M3.2)', async () => {
    const user = userEvent.setup()
    renderList()
    await screen.findByText('First')
    const grid = screen.getByRole('grid')
    grid.focus()
    await user.keyboard('l')
    expect(await screen.findByRole('menu', { name: 'Apply labels' })).toBeInTheDocument()
  })

  it('files an opened result under the row’s own mailbox when there is no folder context (M3.2)', async () => {
    const user = userEvent.setup()
    // The list renders from the seeded search window even with no engine, and open() navigates
    // without one — so null-out the engine to avoid stubbing every search-mode engine method.
    setActiveEngine(null)
    const spec: QuerySpec = {
      filter: { hasKeyword: 'work' },
      sort: [{ property: 'receivedAt', isAscending: false }],
      collapseThreads: false,
    }
    const key = canonicalQueryKey(spec)
    // e1 lives in Archive — no route folder in a label view, so open() must resolve the mailbox off it.
    await putEmails(db, 'a', [
      email('e1', { subject: 'Labeled', mailboxIds: { archive: true }, keywords: { work: true } }),
    ])
    await putQueryCache(db, {
      accountId: 'a',
      key,
      ids: ['e1'],
      queryState: 'q',
      total: 1,
      upToId: 'e1',
      filter: spec.filter ?? null,
      sort: spec.sort ?? null,
      collapseThreads: false,
      lastUsedAt: 1,
    })

    render(
      <RouterProvider>
        <ConfigProvider config={DEFAULT_CONFIG}>
          <ReplicaProvider accountId="a" db={db}>
            <MessageList
              mailboxId={undefined}
              search={{ spec, scopeMailboxId: undefined }}
              activeLabel="work"
            />
          </ReplicaProvider>
        </ConfigProvider>
      </RouterProvider>,
    )
    const rowEl = (await screen.findByText('Labeled')).closest('[role="row"]') as HTMLElement
    await user.click(rowEl)
    // Navigation happened (row is aria-current) → open() resolved the mailbox from the row.
    await waitFor(() => expect(rowEl).toHaveAttribute('aria-current', 'page'))
  })
})
