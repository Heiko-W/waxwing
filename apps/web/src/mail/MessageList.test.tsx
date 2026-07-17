import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
import { ToastProvider } from '../ui'
import { EMPTY_LIST_STATE, useListStore } from './list-store'
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
  // The list's window/focus/selection live in a MODULE-scoped store (M3.8) — reset it, or one test's
  // roving focus leaks into the next.
  useListStore.setState(EMPTY_LIST_STATE)
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

// The bulk bar triages through `useTriage`, which raises an undo toast — so a ToastProvider is now
// part of the list's minimum provider stack (M3.8).
function renderList() {
  return render(
    <RouterProvider>
      <ConfigProvider config={DEFAULT_CONFIG}>
        <ToastProvider>
          <ReplicaProvider accountId="a" db={db}>
            <MessageList mailboxId="inbox" />
          </ReplicaProvider>
        </ToastProvider>
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

  // Opening a message makes IT the subject. A leftover selection would otherwise win the `targetIds`
  // precedence and `e` in the reading pane would archive a message that is not even on screen.
  it('opening a message clears the selection (review regression)', async () => {
    const user = userEvent.setup()
    renderList()
    await screen.findByText('First')
    await user.click(screen.getAllByRole('checkbox', { name: 'Select message' })[0] as HTMLElement)
    expect(await screen.findByText('1 selected')).toBeInTheDocument()

    const second = (await screen.findByText('Second')).closest('[role="row"]') as HTMLElement
    await user.click(second)

    await waitFor(() => expect(screen.queryByText('1 selected')).toBeNull())
    expect(useListStore.getState().selection.selected.size).toBe(0)
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

  // The `l` CHORD itself moved into the shortcut registry (M3.8) — it is exercised end to end in
  // shortcuts/ShortcutProvider.test.tsx. What the list still owns is RENDERING the picker the store
  // asks for, which is what this asserts.
  it('renders the label picker for the targets the list store requests (M3.2/M3.8)', async () => {
    renderList()
    await screen.findByText('First')
    act(() => useListStore.getState().requestLabels(['e1']))
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
          <ToastProvider>
            <ReplicaProvider accountId="a" db={db}>
              <MessageList
                mailboxId={undefined}
                search={{ spec, scopeMailboxId: undefined }}
                activeLabel="work"
              />
            </ReplicaProvider>
          </ToastProvider>
        </ConfigProvider>
      </RouterProvider>,
    )
    const rowEl = (await screen.findByText('Labeled')).closest('[role="row"]') as HTMLElement
    await user.click(rowEl)
    // Navigation happened (row is aria-current) → open() resolved the mailbox from the row.
    await waitFor(() => expect(rowEl).toHaveAttribute('aria-current', 'page'))
  })

  // The list's move path (M3.9, FR-MBX-03). It is the non-pointer route WCAG 2.2 SC 2.5.7 makes a
  // prerequisite of the drag, and the bulk bar had no way to reach an arbitrary folder at all.
  describe('move to folder', () => {
    it('the bulk bar offers Move to…, and the picker dispatches through the undo seam', async () => {
      const user = userEvent.setup()
      renderList()
      await screen.findByText('First')
      await user.click(
        screen.getAllByRole('checkbox', { name: 'Select message' })[0] as HTMLElement,
      )
      expect(await screen.findByText('1 selected')).toBeInTheDocument()

      await user.click(screen.getByRole('button', { name: 'Move to…' }))
      const dialog = await screen.findByRole('dialog', { name: 'Move to folder' })
      // `findBy`, not `getBy`: the dialog's targets come from `useMailboxes()`, a liveQuery
      // INDEPENDENT of the email window `findByText('First')` waited on. The dialog exists one tick
      // before its folders do, and until then it renders the "No other folders." empty state — a sync
      // query lands in that gap ~1 run in 20. Two unresolved liveQueries racing is precisely the
      // shape of the M3.8 keyboard flake (M3.9); it is no more acceptable in a test than in the app.
      await user.click(await within(dialog).findByRole('button', { name: 'Archive' }))

      await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
      expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
        kind: 'move',
        emailIds: ['e1'],
        from: 'inbox',
        to: 'archive',
      })
      // Named after the target, and undoable — a bare `actions.move` would give neither.
      expect(await screen.findByText('Moved to Archive')).toBeInTheDocument()
      // The mail left the folder, so it must leave the selection: a follow-up action would
      // otherwise run with a stale `from`.
      await waitFor(() => expect(screen.queryByText('1 selected')).toBeNull())
    })

    it('the `v` chord opens the same picker via the store', async () => {
      renderList()
      await screen.findByText('First')
      act(() => useListStore.getState().requestMove(['e1']))
      expect(await screen.findByRole('dialog', { name: 'Move to folder' })).toBeInTheDocument()
    })

    it('offers neither the button nor the picker in a cross-folder view', async () => {
      // A label view spans folders, so there is no `from`. `move(ids, null, to)` keeps every other
      // membership — it would ADD the mail to the target and leave it where it was, which is a copy,
      // not the move the button promises. Both halves of the gate are asserted: the bulk bar hides
      // the button, and the render site refuses even if `requestMove` is driven directly.
      // No engine: the list renders from the seeded search window, and this test dispatches nothing
      // — the same shortcut the label-view test above takes rather than stub every search method.
      setActiveEngine(null)
      const spec: QuerySpec = {
        filter: { hasKeyword: 'work' },
        sort: [{ property: 'receivedAt', isAscending: false }],
        collapseThreads: false,
      }
      const key = canonicalQueryKey(spec)
      await putEmails(db, 'a', [
        email('x1', {
          subject: 'Labeled',
          mailboxIds: { archive: true },
          keywords: { work: true },
        }),
      ])
      await putQueryCache(db, {
        accountId: 'a',
        key,
        ids: ['x1'],
        queryState: 'q',
        total: 1,
        upToId: 'x1',
        filter: spec.filter ?? null,
        sort: spec.sort ?? null,
        collapseThreads: false,
        lastUsedAt: 1,
      })
      const user = userEvent.setup()
      render(
        <RouterProvider>
          <ConfigProvider config={DEFAULT_CONFIG}>
            <ToastProvider>
              <ReplicaProvider accountId="a" db={db}>
                <MessageList
                  mailboxId={undefined}
                  search={{ spec, scopeMailboxId: undefined }}
                  activeLabel="work"
                />
              </ReplicaProvider>
            </ToastProvider>
          </ConfigProvider>
        </RouterProvider>,
      )
      await screen.findByText('Labeled')
      await user.click(
        screen.getAllByRole('checkbox', { name: 'Select message' })[0] as HTMLElement,
      )
      expect(await screen.findByText('1 selected')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Move to…' })).toBeNull()

      act(() => useListStore.getState().requestMove(['x1']))
      await waitFor(() =>
        expect(screen.queryByRole('dialog', { name: 'Move to folder' })).toBeNull(),
      )
    })
  })

  // Drag & drop source (M3.9 5b, FR-MBX-03). The dragged-set rule and the two `draggable` gates are
  // the contract; the drop side lives in FolderTree.test. jsdom ships no DataTransfer, so it is
  // hand-stubbed on the fireEvent init, exactly as ComposerWindow.test does for file drops.
  describe('drag source', () => {
    /** A minimal DataTransfer that records setData calls. */
    function dataTransfer() {
      const store = new Map<string, string>()
      return {
        data: store,
        setData: (type: string, value: string) => store.set(type, value),
        getData: (type: string) => store.get(type) ?? '',
        setDragImage: () => {},
        types: [] as string[],
        effectAllowed: 'uninitialized',
      }
    }
    const rowWrap = (subject: string) =>
      (screen.getByText(subject).closest('[role="row"]')?.parentElement as HTMLElement) ?? null

    it('dragging a row OUTSIDE the selection carries only that row and makes it the selection', async () => {
      const user = userEvent.setup()
      renderList()
      await screen.findByText('First')
      // Select 'Second' and 'Third', then drag 'First', which is NOT selected.
      await user.click(
        screen.getAllByRole('checkbox', { name: 'Select message' })[1] as HTMLElement,
      )
      await user.click(
        screen.getAllByRole('checkbox', { name: 'Select message' })[2] as HTMLElement,
      )
      expect(await screen.findByText('2 selected')).toBeInTheDocument()

      const dt = dataTransfer()
      fireEvent.dragStart(rowWrap('First'), { dataTransfer: dt })

      // Carries e1 alone — NOT the selection. The rule `targetIds` gets backwards for a pointer.
      expect(dt.data.get('application/x-waxwing-messages')).toBe('e1')
      // …and 'First' becomes the whole selection (selectOne's first production caller).
      expect(useListStore.getState().selection.selected.has('e1')).toBe(true)
      expect(useListStore.getState().selection.selected.size).toBe(1)
    })

    it('dragging a row INSIDE the selection carries every selected id and leaves the selection alone', async () => {
      const user = userEvent.setup()
      renderList()
      await screen.findByText('First')
      await user.click(
        screen.getAllByRole('checkbox', { name: 'Select message' })[0] as HTMLElement,
      )
      await user.click(
        screen.getAllByRole('checkbox', { name: 'Select message' })[1] as HTMLElement,
      )
      expect(await screen.findByText('2 selected')).toBeInTheDocument()

      const dt = dataTransfer()
      fireEvent.dragStart(rowWrap('First'), { dataTransfer: dt })

      expect((dt.data.get('application/x-waxwing-messages') ?? '').split(',').sort()).toEqual([
        'e1',
        'e2',
      ])
      expect(useListStore.getState().selection.selected.size).toBe(2)
    })

    it('a real row is draggable; a cross-folder search row is not (that move would be a copy)', async () => {
      renderList()
      await screen.findByText('First')
      expect(rowWrap('First')).toHaveAttribute('draggable', 'true')
    })

    it('rows in a cross-folder search are NOT draggable', async () => {
      setActiveEngine(null)
      const spec: QuerySpec = {
        filter: { hasKeyword: 'work' },
        sort: [{ property: 'receivedAt', isAscending: false }],
        collapseThreads: false,
      }
      const key = canonicalQueryKey(spec)
      await putEmails(db, 'a', [
        email('x1', {
          subject: 'Labeled',
          mailboxIds: { archive: true },
          keywords: { work: true },
        }),
      ])
      await putQueryCache(db, {
        accountId: 'a',
        key,
        ids: ['x1'],
        queryState: 'q',
        total: 1,
        upToId: 'x1',
        filter: spec.filter ?? null,
        sort: spec.sort ?? null,
        collapseThreads: false,
        lastUsedAt: 1,
      })
      render(
        <RouterProvider>
          <ConfigProvider config={DEFAULT_CONFIG}>
            <ToastProvider>
              <ReplicaProvider accountId="a" db={db}>
                <MessageList mailboxId={undefined} search={{ spec, scopeMailboxId: undefined }} />
              </ReplicaProvider>
            </ToastProvider>
          </ConfigProvider>
        </RouterProvider>,
      )
      // sourceMailboxId is null here: `move` with no `from` keeps the other memberships — a copy.
      await screen.findByText('Labeled')
      expect(rowWrap('Labeled')).toHaveAttribute('draggable', 'false')
    })
  })
})
