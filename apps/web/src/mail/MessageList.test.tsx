import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '../app/config'
import { ConfigProvider } from '../app/config-context'
import { RouterProvider } from '../app/route'
import {
  canonicalQueryKey,
  deleteMailbox,
  putEmails,
  putMailboxes,
  putQueryCache,
  type QuerySpec,
  type ReplicaDb,
  ReplicaProvider,
  setPref,
} from '../sync'
import { setActiveEngine, windowQueryKey } from '../sync/engine'
import { email, freshDb, mailbox } from '../sync/test-utils'
import { expectNoA11yViolations } from '../test/axe'
import { ToastProvider } from '../ui'
import { EMPTY_LIST_STATE, useListStore } from './list-store'
import { MessageList } from './MessageList'
import { SWIPE_PREF_KEYS } from './swipe-prefs'

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

/** The exact key useMessageList computes for a folder with the default (date desc, threaded) view. */
function folderKey(mailboxId: string): string {
  return windowQueryKey(mailboxId, DEFAULT_CONFIG.offline.cacheDays, Date.now(), {
    sort: [{ property: 'receivedAt', isAscending: false }],
    collapseThreads: true,
  }).key
}

function inboxKey(): string {
  return folderKey('inbox')
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
function renderList(mailboxId = 'inbox') {
  return render(
    <RouterProvider>
      <ConfigProvider config={DEFAULT_CONFIG}>
        <ToastProvider>
          <ReplicaProvider accountId="a" db={db}>
            <MessageList mailboxId={mailboxId} />
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

  it('the bulk-bar read button TOGGLES, so mark-unread has a single-pointer path (SC 2.5.7)', async () => {
    // Swipe-right toggles `$seen`, so WCAG 2.2 SC 2.5.7 owes that outcome a single-pointer,
    // non-dragging equivalent. Before this, marking a message unread existed only on the `u` chord —
    // a keyboard path, which is a different success criterion and no use on a touchscreen.
    // 'e2' is seeded read, so selecting only it must flip the button to the unread affordance.
    await putEmails(db, 'a', [
      email('e2', {
        from: [{ name: 'Bob', email: 'b@x.test' }],
        subject: 'Second',
        keywords: { $seen: true },
      }),
    ])
    const user = userEvent.setup()
    renderList()
    await screen.findByText('First')

    // A selection that is entirely read offers "unread" and clears the keyword.
    await user.click(screen.getAllByRole('checkbox', { name: 'Select message' })[1] as HTMLElement)
    expect(await screen.findByText('1 selected')).toBeInTheDocument()
    await user.click(await screen.findByRole('button', { name: 'Mark as unread' }))
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      kind: 'setKeywords',
      keyword: '$seen',
      value: false,
      emailIds: ['e2'],
    })

    // POSITIVE CONTROL, same render: adding an unread row makes the selection no longer all-read, so
    // the button must go back to setting `$seen`. Without this the test would also pass if the
    // button were hard-wired the OTHER way round.
    dispatch.mockClear()
    await user.click(screen.getAllByRole('checkbox', { name: 'Select message' })[0] as HTMLElement)
    expect(await screen.findByText('2 selected')).toBeInTheDocument()
    await user.click(await screen.findByRole('button', { name: 'Mark as read' }))
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({ keyword: '$seen', value: true })
  })

  // The `to === from` guard lives in `useTriage`, which means every SURFACE that offers such a move
  // offers one that dispatches nothing and says nothing — the shape 6da2350 exists to kill. The bulk
  // bar expresses the gate the way it already treats a role the account does not have at all: the
  // button is not there. (`MoveDialog` does the same by leaving the current mailbox out of its list.)
  it('the bulk bar offers no Archive while viewing Archive', async () => {
    const user = userEvent.setup()
    await putEmails(db, 'a', [
      email('a1', { subject: 'Filed', mailboxIds: { archive: true }, keywords: {} }),
    ])
    await putQueryCache(db, {
      accountId: 'a',
      key: folderKey('archive'),
      ids: ['a1'],
      queryState: 'q',
      total: 1,
      upToId: 'a1',
      filter: null,
      sort: null,
      collapseThreads: true,
      lastUsedAt: 1,
    })
    renderList('archive')
    await screen.findByText('Filed')
    await user.click(screen.getAllByRole('checkbox', { name: 'Select message' })[0] as HTMLElement)
    expect(await screen.findByText('1 selected')).toBeInTheDocument()

    // Trash is a real move from here and stays — so "no Archive button" is the gate, not an empty bar.
    expect(screen.getByRole('button', { name: 'Move to Trash' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull()
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

  /**
   * A minimal DataTransfer that records setData calls. jsdom ships none, so it is hand-stubbed on
   * the fireEvent init, exactly as ComposerWindow.test does for file drops. Shared with the swipe
   * block below, which asserts that a drag started mid-gesture writes NOTHING to it (ADR-012).
   */
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

  /**
   * The presentational wrapper both pointer affordances bind to — `draggable`/`onDragStart` and
   * `onPointerDown`. Reached through the row's `parentElement`, which is why the reveal layers are
   * SIBLINGS of MessageRow rather than a wrapper around it.
   */
  const rowWrap = (subject: string) =>
    (screen.getByText(subject).closest('[role="row"]')?.parentElement as HTMLElement) ?? null

  // Drag & drop source (M3.9 5b, FR-MBX-03). The dragged-set rule and the two `draggable` gates are
  // the contract; the drop side lives in FolderTree.test.
  describe('drag source', () => {
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

  // Swipe gestures on touch (M3.9, FR-LST-06). The gesture ARITHMETIC — slop, axis lock, commit
  // threshold, pointercancel, the imperative `--swipe-x` — is pinned in `use-swipe.test.tsx` against
  // a bare harness. What this block owns is what a direction MEANS on a real row: which mailbox it
  // resolves against, which keyword it writes, and the four cases where it must resolve to nothing.
  //
  // Assertions are on `dispatch.mock.calls`, never "the row left the list": `setKeywords` does not
  // prune a keyword-filtered window (B1), so a swiped-to-read row correctly stays on screen, and a
  // disappearance assertion would encode the opposite rule.
  describe('swipe', () => {
    /**
     * Drive one gesture over a row wrapper. Two moves, because the FIRST is what the axis lock
     * reads — a single jump to the end coordinate would prove nothing about the decision on the way
     * there. `fireEvent` rather than `user.pointer` for exact control of those coordinates.
     */
    function swipe(el: HTMLElement, dx: number, dy = 0, pointerType = 'touch'): void {
      const init = { pointerId: 1, pointerType, isPrimary: true, buttons: 1, bubbles: true }
      fireEvent.pointerDown(el, { ...init, clientX: 300, clientY: 40 })
      fireEvent.pointerMove(window, { ...init, clientX: 300 + dx / 2, clientY: 40 + dy / 2 })
      fireEvent.pointerMove(window, { ...init, clientX: 300 + dx, clientY: 40 + dy })
      fireEvent.pointerUp(window, { ...init, clientX: 300 + dx, clientY: 40 + dy })
    }

    /**
     * "The direction is inert" in the two ways the user can perceive it: the row never followed the
     * finger (`data-swipe` is written at the axis lock and deliberately survives the snap-back), and
     * no offset was ever written (`--swipe-x` is set to `0px` on lift, so an empty string is the only
     * proof that the gesture never armed at all).
     *
     * This is what makes each suppression test bite. A dispatch assertion alone cannot: `useTriage`
     * refuses a self-move and a `from`-less move too, so removing the LIST's gate leaves the outbox
     * just as quiet while the UI has already promised the user an action it will not perform.
     */
    function expectInert(wrap: HTMLElement): void {
      expect(wrap.dataset.swipe).toBeUndefined()
      expect(wrap.style.getPropertyValue('--swipe-x')).toBe('')
    }

    it('a left swipe archives the row under the finger', async () => {
      renderList()
      await screen.findByText('First')
      // The reveal layer IS the readiness signal: it renders only once `useMailboxes()` has
      // resolved, which is the query the move directions gate on. Waiting for the row alone is not
      // enough — the email window and the mailbox list are independent liveQueries, and a swipe
      // fired in the gap would resolve to nothing and pass for the wrong reason.
      await screen.findAllByText('Archive')

      swipe(rowWrap('First'), -150)

      expect(dispatch).toHaveBeenCalledTimes(1)
      expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
        kind: 'move',
        emailIds: ['e1'],
        from: 'inbox',
        to: 'archive',
      })
      // Through the NAMED seam, so the move is undoable — the affordance a gesture needs most,
      // since there is nothing to un-click. A bare `actions.move` would give neither toast nor undo.
      expect(await screen.findByText('Moved to Archive')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument()
      // The row under the finger alone: a swipe is a complete action, not the start of one, so it
      // leaves the selection (and the reading pane) exactly as it found them — unlike the drag.
      expect(useListStore.getState().selection.selected.size).toBe(0)
    })

    it('a swiped-away row leaves the SELECTION with it — and only it', async () => {
      const user = userEvent.setup()
      renderList()
      await screen.findByText('First')
      await screen.findAllByText('Archive')
      const boxes = () => screen.getAllByRole('checkbox', { name: 'Select message' })
      await user.click(boxes()[0] as HTMLElement)
      await user.click(boxes()[1] as HTMLElement)
      await user.click(boxes()[2] as HTMLElement)
      expect(await screen.findByText('3 selected')).toBeInTheDocument()

      swipe(rowWrap('First'), -150)

      expect(dispatch).toHaveBeenCalledTimes(1)
      // The row has left the folder, so it must leave the selection: with e1 still in it, the bulk
      // bar would count 3 over 2 visible rows and the next bulk Trash would patch
      // `mailboxIds/trash: true` onto e1 while its inbox removal is a no-op — filed in Archive AND
      // Trash. `toEqual` on the array, not just a size: a `clear` would satisfy "e1 is gone" too,
      // and clearing is what a swipe must NOT do — it acts on the row under the finger, not on the
      // selection the user built.
      expect([...useListStore.getState().selection.selected]).toEqual(['e2', 'e3'])
      expect(await screen.findByText('2 selected')).toBeInTheDocument()

      // Only a MOVE prunes. A read/unread swipe leaves the row exactly where it is, so taking it out
      // of the selection would be the same lie in the other direction.
      swipe(rowWrap('Second'), 150)
      expect(dispatch).toHaveBeenCalledTimes(2)
      expect([...useListStore.getState().selection.selected]).toEqual(['e2', 'e3'])
    })

    it('SAFETY: a folder change under a locked gesture cancels the commit, never re-targets it', async () => {
      // The tablet case: finger 1 has locked a swipe on an Inbox row, finger 2 taps Sent on the
      // persistent folder rail. The gesture rejects that second POINTER (`isPrimary`), but the rail's
      // click is not the gesture's to reject — and `<MessageList>` is not keyed on the mailbox in
      // MailScreen, so the folder change re-renders it in place and the swipe survives. `commit`
      // reaches this component through an options ref refreshed every render, so it used to read the
      // mailbox current at LIFT: `archive(['e1'], 'sent')`, whose `mailboxIds/sent` removal is a
      // no-op on a message that was never in Sent → e1 in Inbox AND Archive, with an Undo that files
      // it into Sent.
      await putMailboxes(db, 'a', [mailbox('sent', { role: 'sent' })])
      const ui = (mailboxId: string) => (
        <RouterProvider>
          <ConfigProvider config={DEFAULT_CONFIG}>
            <ToastProvider>
              <ReplicaProvider accountId="a" db={db}>
                <MessageList mailboxId={mailboxId} />
              </ReplicaProvider>
            </ToastProvider>
          </ConfigProvider>
        </RouterProvider>
      )
      const { rerender } = render(ui('inbox'))
      await screen.findByText('First')
      await screen.findAllByText('Archive')

      const init = { pointerId: 1, pointerType: 'touch', isPrimary: true, bubbles: true }
      fireEvent.pointerDown(rowWrap('First'), { ...init, clientX: 300, clientY: 40 })
      fireEvent.pointerMove(window, { ...init, clientX: 250, clientY: 40 }) // axis locks: left
      fireEvent.pointerMove(window, { ...init, clientX: 150, clientY: 40 }) // past the commit slop
      rerender(ui('sent'))
      fireEvent.pointerUp(window, { ...init, clientX: 150, clientY: 40 })

      // Nothing at all: the source captured at the axis lock no longer matches the folder on screen,
      // and a move is not a thing to retarget silently at the last moment.
      expect(dispatch).not.toHaveBeenCalled()

      // Positive control: back in the folder it started in, the identical gesture files it.
      rerender(ui('inbox'))
      await screen.findByText('First')
      await screen.findAllByText('Archive')
      swipe(rowWrap('First'), -150)
      expect(dispatch).toHaveBeenCalledTimes(1)
      expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
        kind: 'move',
        emailIds: ['e1'],
        from: 'inbox',
        to: 'archive',
      })
    })

    it('SAFETY: a mouse never swipes — that pointer belongs to the drag (ADR-012)', async () => {
      renderList()
      await screen.findByText('First')
      await screen.findAllByText('Archive')

      swipe(rowWrap('First'), -150, 0, 'mouse')

      expect(dispatch).not.toHaveBeenCalled()
      expectInert(rowWrap('First'))

      // Positive control, in the SAME render: the identical gesture on touch does fire. Without it
      // this test would keep passing if the swipe were unwired from the list altogether.
      swipe(rowWrap('First'), -150)
      expect(dispatch).toHaveBeenCalledTimes(1)
    })

    it('a right swipe TOGGLES $seen against the row it is used on', async () => {
      // 'Second' is already read, 'First' is not — one render, both directions of the toggle.
      await putEmails(db, 'a', [
        email('e2', {
          from: [{ name: 'Bob', email: 'b@x.test' }],
          subject: 'Second',
          keywords: { $seen: true },
        }),
      ])
      renderList()
      await screen.findByText('First')
      // The read state is seeded BEFORE the render, so the row's first hydration already carries it
      // and its subject is a complete readiness gate. Deliberately NOT the reveal label: a gate that
      // reads the same expression as the assertion turns a broken toggle into a timeout at the gate,
      // and the `value: false` assertion below — the whole point of the test — never runs.
      await screen.findByText('Second')

      swipe(rowWrap('First'), 150)
      swipe(rowWrap('Second'), 150)

      expect(dispatch).toHaveBeenCalledTimes(2)
      expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
        kind: 'setKeywords',
        keyword: '$seen',
        value: true,
        emailIds: ['e1'],
      })
      expect(dispatch.mock.calls[1]?.[0]).toMatchObject({
        kind: 'setKeywords',
        keyword: '$seen',
        value: false,
        emailIds: ['e2'],
      })
      // The revealed label flips with the row's state as well, so the strip can never promise the
      // opposite of what the lift will do: two unread rows offer "read", the read one offers "unread".
      expect(screen.getAllByText('Mark as read')).toHaveLength(2)
      expect(screen.getAllByText('Mark as unread')).toHaveLength(1)
      // No toast for read/unread — the unread dot and the bold weight are the feedback, and adding
      // one here would silently change what the bulk-bar button and `u` do.
      expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
    })

    it('SAFETY: left=Trash while viewing Trash is inert — no destroy, no self-move', async () => {
      await setPref(db, 'a', SWIPE_PREF_KEYS.left, 'trash')
      await putEmails(db, 'a', [
        email('t1', { subject: 'InTrash', mailboxIds: { trash: true }, keywords: {} }),
      ])
      await putQueryCache(db, {
        accountId: 'a',
        key: folderKey('trash'),
        ids: ['t1'],
        queryState: 'q',
        total: 1,
        upToId: 't1',
        filter: null,
        sort: null,
        collapseThreads: true,
        lastUsedAt: 1,
      })
      renderList('trash')
      await screen.findByText('InTrash')
      // The pref is its own liveQuery: until it lands the default (archive) is live, and
      // Trash → Archive is a perfectly legal move. Wait for that layer to GO, or this test swipes in
      // the gap and proves nothing.
      await waitFor(() => expect(screen.queryByText('Archive')).toBeNull())

      swipe(rowWrap('InTrash'), -150)

      // No `move` (the self-move whose replay patch removes the mail from the only mailbox it is in)
      // and no `destroyEmails` — nothing at all reaches the outbox.
      expect(dispatch).not.toHaveBeenCalled()
      // …and the direction is inert rather than merely refused downstream. This is the assertion
      // that pins the LIST's gate: `useTriage` also refuses a self-move, so a dispatch assertion
      // alone stays green with the gate deleted while the UI drags the row aside and shows a red
      // Trash strip it will not honour.
      expectInert(rowWrap('InTrash'))
      expect(screen.queryByText('Move to Trash')).toBeNull()

      // Positive control: the other direction still works in the same view, so "nothing dispatched"
      // above is the gate, not a dead render.
      swipe(rowWrap('InTrash'), 150)
      expect(dispatch).toHaveBeenCalledTimes(1)
      expect(dispatch.mock.calls[0]?.[0]).toMatchObject({ kind: 'setKeywords', emailIds: ['t1'] })
    })

    it('SAFETY: a direction set to "Nothing" is inert — it must never fall through to a move', async () => {
      // `none` is a real choice in the settings picker (SWIPE_ACTIONS), and the one whose failure
      // mode is worst. `resolveSwipe` ends its move branch in
      // `kind = action === 'archive' && archiveId ? 'archive' : 'trash'` — so a `none` that escapes
      // its own gate does not fall through to a no-op, it falls through to TRASH. The user asked for
      // the direction to do nothing and a thumb deletes their mail.
      //
      // RIGHT is set to `archive` rather than left on its `read` default purely to make the readiness
      // gate below airtight — see the comment on the gate.
      await setPref(db, 'a', SWIPE_PREF_KEYS.left, 'none')
      await setPref(db, 'a', SWIPE_PREF_KEYS.right, 'archive')
      renderList()
      await screen.findByText('First')
      // Exactly three Archive strips — one per row, all from the RIGHT direction — and no read strip.
      // Three independent liveQueries have to settle here (the email window, `useMailboxes()`, and
      // the two prefs), and every unsettled combination breaks one half of this pair: with the prefs
      // pending the defaults give 3 Archive AND 3 "Mark as read"; with only the left pref pending it
      // is six Archive; with roles pending there are no move strips at all. A one-sided gate ("no
      // Archive on the left") would be satisfied by roles-not-ready too, and this test would then
      // pass with the `none` branch deleted — resolving to `null` for entirely the wrong reason.
      await waitFor(() => {
        expect(screen.getAllByText('Archive')).toHaveLength(3)
        expect(screen.queryByText('Mark as read')).toBeNull()
      })
      // Nothing revealed on the left before the finger even moves: the direction promises nothing.
      // `queryAllBy`, because the failure this guards against reveals a strip on EVERY row, and
      // `queryByText` would throw "found multiple elements" instead of stating the count.
      expect(screen.queryAllByText('Move to Trash')).toHaveLength(0)

      swipe(rowWrap('First'), -150)

      expect(dispatch).not.toHaveBeenCalled()
      // …and inert in the two ways the user perceives it. As in Trash-inside-Trash, the dispatch
      // assertion alone is not enough — but here it is not even true: with the gate gone this
      // direction dispatches a real move to Trash.
      expectInert(rowWrap('First'))

      // Positive control in the SAME render: the other direction still files the row, so "nothing
      // dispatched" above is the `none` gate and not a gesture that was never wired to this list.
      swipe(rowWrap('First'), 150)
      expect(dispatch).toHaveBeenCalledTimes(1)
      expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
        kind: 'move',
        emailIds: ['e1'],
        from: 'inbox',
        to: 'archive',
      })
    })

    it('falls back to Trash on an account with no Archive folder', async () => {
      renderList()
      await screen.findByText('First')
      // Render WITH an Archive and wait for its layer — that is what pins `useMailboxes()` as
      // resolved — then take the folder away. The gate is "the Archive layer is gone", which a
      // correct fallback and a missing fallback satisfy equally, so it cannot double as the
      // assertion: with a fallback-less resolver this test fails on the dispatch, not on a timeout.
      await screen.findAllByText('Archive')
      await deleteMailbox(db, 'a', 'archive')
      await waitFor(() => expect(screen.queryByText('Archive')).toBeNull())

      swipe(rowWrap('First'), -150)

      expect(dispatch).toHaveBeenCalledTimes(1)
      expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
        kind: 'move',
        emailIds: ['e1'],
        from: 'inbox',
        to: 'trash',
      })
      // Resolved off the mailbox LIST, never off `triage.archive()`'s boolean: `false` there also
      // means "the liveQuery has not resolved yet", so a boolean-driven fallback would trash mail on
      // the first render tick of an account that does have an Archive.
      expect(await screen.findByText('Moved to Trash')).toBeInTheDocument()
      // …and the strip names the fallback rather than promising an Archive that is gone.
      expect(screen.getAllByText('Move to Trash')).toHaveLength(3)
    })

    it('a swipe that has locked an axis cancels the drag (ADR-012)', async () => {
      renderList()
      await screen.findByText('First')
      // The same readiness gate the other move-direction tests take, and it is load-bearing here for
      // a less obvious reason: this test needs the axis to LOCK, and the lock only happens if
      // `resolveSwipe` returns non-null. Left is `archive`, which is gated on `useMailboxes()` — an
      // independent liveQuery from the email window `findByText` waited on. Fire in that gap and the
      // gesture resolves to nothing, never locks, `isSwipeActive()` stays false, and the drag it was
      // supposed to cancel writes its payload: `dt.data.size` is 1, not 0. Observed failing twice
      // under load before this gate was added.
      await screen.findAllByText('Archive')
      const wrap = rowWrap('First')
      const init = { pointerId: 1, pointerType: 'touch', isPrimary: true, bubbles: true }
      fireEvent.pointerDown(wrap, { ...init, clientX: 300, clientY: 40 })
      // Past the axis slop but well under the commit threshold: the swipe now owns the pointer,
      // and lifting here must still not trigger the action.
      fireEvent.pointerMove(window, { ...init, clientX: 260, clientY: 40 })

      const dt = dataTransfer()
      fireEvent.dragStart(wrap, { dataTransfer: dt })

      // Nothing written, so nothing can be dropped: one finger must not move the row two ways.
      expect(dt.data.size).toBe(0)
      expect(dt.effectAllowed).toBe('uninitialized')
      // …and the drag did not hijack the selection on its way past, either.
      expect(useListStore.getState().selection.selected.size).toBe(0)

      fireEvent.pointerUp(window, { ...init, clientX: 260, clientY: 40 })
      expect(dispatch).not.toHaveBeenCalled()

      // With the finger lifted the row is a normal drag source again: the guard is scoped to the
      // gesture, not a permanent disable of drag-and-drop on touch-capable hardware.
      const afterLift = dataTransfer()
      fireEvent.dragStart(wrap, { dataTransfer: afterLift })
      expect(afterLift.data.get('application/x-waxwing-messages')).toBe('e1')
    })

    it('a long press with no movement is still a drag source (ADR-012 coexistence)', async () => {
      // The gesture that ENTERS a touch drag on Chrome-Android and iOS Safari is a press that does
      // not move. Guarding on "a finger is down" rather than "a swipe locked" would cancel exactly
      // that press and silently disable touch drag & drop — the opposite of the recorded decision.
      // This is the test that fails if the guard is ever widened back to the whole gesture.
      renderList()
      await screen.findByText('First')
      const wrap = rowWrap('First')
      const init = { pointerId: 1, pointerType: 'touch', isPrimary: true, bubbles: true }
      fireEvent.pointerDown(wrap, { ...init, clientX: 300, clientY: 40 })

      const dt = dataTransfer()
      fireEvent.dragStart(wrap, { dataTransfer: dt })

      expect(dt.data.get('application/x-waxwing-messages')).toBe('e1')
    })

    it('a cross-folder search row can be read but not moved', async () => {
      // Not `setActiveEngine(null)` like the neighbouring search tests: this one has to observe a
      // dispatch, so the search methods the list calls are stubbed instead.
      setActiveEngine({
        watchWindow: vi.fn(() => 'k'),
        watchQuery: vi.fn(() => 'sk'),
        unwatchQuery: vi.fn(),
        loadMoreFor: vi.fn(),
        fetchEnvelopes: vi.fn(),
        fetchSnippets: vi.fn(async () => new Map()),
        dispatch,
      } as unknown as Parameters<typeof setActiveEngine>[0])
      const spec: QuerySpec = {
        filter: { hasKeyword: 'work' },
        sort: [{ property: 'receivedAt', isAscending: false }],
        collapseThreads: false,
      }
      await putEmails(db, 'a', [
        email('x1', {
          subject: 'Labeled',
          mailboxIds: { archive: true },
          keywords: { work: true },
        }),
      ])
      await putQueryCache(db, {
        accountId: 'a',
        key: canonicalQueryKey(spec),
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
      await screen.findByText('Labeled')
      // The read layer is the readiness gate — it proves the row is hydrated and the gesture wired,
      // and it does not read the `from`-gate the assertions below are about.
      await screen.findByText('Mark as read')

      swipe(rowWrap('Labeled'), -150)

      // `move` with `from: null` keeps the other memberships — a copy, not a move — and gets no
      // Undo, so it is precisely what a gesture must never do.
      expect(dispatch).not.toHaveBeenCalled()
      // As in Trash-inside-Trash: `commitSwipe` also refuses a `from`-less move, so only the inert
      // assertions catch a resolver that reveals the strip and lets the row slide anyway.
      expectInert(rowWrap('Labeled'))
      expect(screen.queryByText('Archive')).toBeNull()

      swipe(rowWrap('Labeled'), 150)
      expect(dispatch).toHaveBeenCalledTimes(1)
      expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
        kind: 'setKeywords',
        keyword: '$seen',
        value: true,
        emailIds: ['x1'],
      })
    })

    it('a row that has not hydrated yet does not swipe', async () => {
      // 'e4' is in the window with no envelope behind it: a live `role="row"` skeleton with nothing
      // to act on — the same gate `draggable` applies.
      await putQueryCache(db, {
        accountId: 'a',
        key: inboxKey(),
        ids: ['e1', 'e2', 'e3', 'e4'],
        queryState: 'q',
        total: 4,
        upToId: 'e4',
        filter: null,
        sort: null,
        collapseThreads: true,
        lastUsedAt: 1,
      })
      renderList()
      await screen.findByText('First')
      await screen.findAllByText('Archive')
      const rows = await screen.findAllByRole('row')
      expect(rows).toHaveLength(4)
      const skeleton = rows[3]?.parentElement as HTMLElement

      swipe(skeleton, -150)

      expect(dispatch).not.toHaveBeenCalled()
      expectInert(skeleton)
      // Only three layers, not four: the skeleton is offered no action in either direction.
      expect(screen.getAllByText('Archive')).toHaveLength(3)

      swipe(rowWrap('First'), -150)
      expect(dispatch).toHaveBeenCalledTimes(1)
    })

    it('the reveal layers are decorative — the grid keeps its row structure', async () => {
      const { container } = renderList()
      await screen.findByText('First')
      const layers = await screen.findAllByText('Archive')
      // No role and `aria-hidden`, so a screen reader still sees three rows in a grid, not nine
      // announcements of colour it cannot perceive.
      expect(layers[0]?.closest('[aria-hidden="true"]')).not.toBeNull()
      expect(screen.getAllByRole('row')).toHaveLength(3)
      await expectNoA11yViolations(container)
    })
  })
})
