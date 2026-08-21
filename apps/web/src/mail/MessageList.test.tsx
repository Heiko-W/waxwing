import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { UserEvent } from '@testing-library/user-event'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '../app/config'
import { ConfigProvider } from '../app/config-context'
import { RouterProvider } from '../app/route'
import de from '../i18n/locales/de/common.json'
import en from '../i18n/locales/en/common.json'
import {
  canonicalQueryKey,
  deleteMailbox,
  getPref,
  putEmails,
  putMailboxes,
  putQueryCache,
  type QuerySpec,
  type ReplicaDb,
  ReplicaProvider,
  setPref,
} from '../sync'
import { setActiveEngine, windowQueryKey } from '../sync/engine'
import { email, FULL_RIGHTS, freshDb, mailbox } from '../sync/test-utils'
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
    // The search seam's pair (M3.1/M3.2). Stubbed here so a search-mode render does not have to
    // null the engine out and lose `dispatch` with it.
    watchQuery: vi.fn(() => 'k'),
    unwatchQuery: vi.fn(),
    // `useSnippets` runs on the search seam only, and asks the engine for the `<mark>` highlights.
    fetchSnippets: vi.fn(async () => new Map<string, never>()),
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
            <MessageList mailboxId={mailboxId} viewOptionsOpen />
          </ReplicaProvider>
        </ToastProvider>
      </ConfigProvider>
    </RouterProvider>,
  )
}

/** The same list over the SEARCH seam (M3.1 results / M3.2 label browse), with no folder context. */
function renderSearch(spec: QuerySpec, scopeMailboxId?: string) {
  return render(
    <RouterProvider>
      <ConfigProvider config={DEFAULT_CONFIG}>
        <ToastProvider>
          <ReplicaProvider accountId="a" db={db}>
            <MessageList mailboxId={undefined} search={{ spec, scopeMailboxId }} viewOptionsOpen />
          </ReplicaProvider>
        </ToastProvider>
      </ConfigProvider>
    </RouterProvider>,
  )
}

/**
 * The search seam WITH a folder context — `/mail/inbox?q=…`, which is what `MailScreen` renders for
 * the overwhelmingly common search: type in the box while standing in a folder and the route keeps
 * the folder (`route.params.mailboxId`) while `useSearch` supplies the spec, so BOTH props arrive.
 *
 * It exists because {@link renderSearch} hardcodes `mailboxId={undefined}`, which is the RARE case
 * (`/mail?q=…`, reachable only by editing the URL or from an all-mailboxes label browse). Every
 * search-seam assertion written against that helper alone is blind to the difference between
 * "is this a search?" and "is there no folder?" — two conditions that are equal in the helper and
 * opposite here, which is exactly where the toolbar gate lives.
 */
function renderFolderSearch(spec: QuerySpec, mailboxId = 'inbox', scopeMailboxId = mailboxId) {
  return render(
    <RouterProvider>
      <ConfigProvider config={DEFAULT_CONFIG}>
        <ToastProvider>
          <ReplicaProvider accountId="a" db={db}>
            <MessageList mailboxId={mailboxId} search={{ spec, scopeMailboxId }} viewOptionsOpen />
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

  describe('the bulk bar overflow', () => {
    // The bar used to render every action unconditionally behind `overflow-x: auto`. Measured live
    // in a browser at both widths the app ships for: seven controls came to 443px inside a 420px
    // column, so "Move to…" ended 11px outside its own container — present in the DOM, invisible on
    // screen, and reachable only by dragging a bar that shows no scrollbar. Every existing test
    // passed throughout, because jsdom reports no widths and `getByRole` does not care where an
    // element is painted.
    /**
     * Widths for the ACTION CONTAINER only, not for every element on the page.
     *
     * The reading-pane version of this can stub `HTMLElement.prototype` wholesale; here that breaks
     * the test before it starts, because the list is virtualized and TanStack measures the same
     * property to decide how many rows exist. Reporting 224px for the scroll container renders no
     * rows at all, so `findByText('First')` never resolves — the failure looks like a bulk-bar bug
     * and is a test-harness one.
     */
    let barWidth = 224

    beforeEach(() => {
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
        configurable: true,
        get(this: HTMLElement) {
          return typeof this.className === 'string' && this.className.includes('bulkActions')
            ? barWidth
            : 0
        },
      })
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
        configurable: true,
        get(this: HTMLElement) {
          return this.tagName === 'BUTTON' ? 44 : 0
        },
      })
      // Deliberately NO ResizeObserver stub. jsdom has none, and installing one switches TanStack
      // Virtual onto its observer path, where a stub that never fires leaves the list with zero
      // rows — the test then fails looking for a message, not for a button. The hook measures once
      // synchronously, which is all this needs.
    })

    afterEach(() => {
      Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth')
      Reflect.deleteProperty(HTMLElement.prototype, 'offsetWidth')
      barWidth = 224
    })

    const selectFirst = async (user: ReturnType<typeof userEvent.setup>): Promise<void> => {
      renderList()
      await screen.findByText('First')
      await user.click(
        screen.getAllByRole('checkbox', { name: 'Select message' })[0] as HTMLElement,
      )
      await screen.findByText('1 selected')
    }

    it('hands what does not fit to a menu instead of painting it outside the column', async () => {
      const user = userEvent.setup()
      await selectFirst(user)
      const bar = screen.getByText('1 selected').parentElement as HTMLElement
      const buttons = within(bar)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label') ?? '')
      // Not the exact count: jsdom reports no `column-gap` for a CSS module, so the arithmetic
      // lands one control higher here than in a browser. What the bar must NEVER do is draw all
      // seven and let the last sit outside its own box, which is what the old one did at every
      // width the app ships.
      expect(buttons.length).toBeLessThan(7)
      expect(buttons.at(-1)).toBe('More actions for the selection')
      // The first survivors are the ones triage needs most, in order.
      expect(buttons.slice(0, 3)).toEqual(['Mark as read', 'Archive', 'Move to Trash'])
    })

    it('makes every displaced action reachable in that menu', async () => {
      // The half that makes hiding them legitimate: an action removed from the bar and not added to
      // the menu is one the reader can no longer perform at all.
      const user = userEvent.setup()
      await selectFirst(user)
      await user.click(screen.getByRole('button', { name: 'More actions for the selection' }))
      const menu = await screen.findByRole('menu')
      const items = within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent ?? '')
      for (const displaced of ['Move to…']) {
        expect(items.some((item) => item.startsWith(displaced))).toBe(true)
      }
    })

    it('shows no trigger at all when everything fits', async () => {
      barWidth = 2000
      const user = userEvent.setup()
      await selectFirst(user)
      expect(
        screen.queryByRole('button', { name: 'More actions for the selection' }),
      ).not.toBeInTheDocument()
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

  it('the bulk-bar flag button TOGGLES, and its accessible name says which way', async () => {
    // Mirrors the read test above, because the defect was the same one control over: `s` toggles
    // `$flagged` through this very seam while the button hard-wired `setFlagged(ids, true)` — and
    // announced itself as "Flag" while doing it. `IconButton`'s label IS the accessible name, so a
    // static one is a lie to a screen reader, not a cosmetic slip.
    // 'e2' is seeded flagged, so selecting only it must flip the button to the unflag affordance.
    await putEmails(db, 'a', [
      email('e2', {
        from: [{ name: 'Bob', email: 'b@x.test' }],
        subject: 'Second',
        keywords: { $flagged: true },
      }),
    ])
    const user = userEvent.setup()
    renderList()
    await screen.findByText('First')

    await user.click(screen.getAllByRole('checkbox', { name: 'Select message' })[1] as HTMLElement)
    expect(await screen.findByText('1 selected')).toBeInTheDocument()
    await user.click(await screen.findByRole('button', { name: 'Unflag' }))
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      kind: 'setKeywords',
      keyword: '$flagged',
      value: false,
      emailIds: ['e2'],
    })

    // POSITIVE CONTROL, same render: adding an unflagged row makes the selection no longer all-
    // flagged, so the button must go back to SETTING the keyword ("set unless every target already
    // has it" — the same rule read/unread and `s` follow). Without this the test would also pass if
    // the button were hard-wired the other way round.
    dispatch.mockClear()
    await user.click(screen.getAllByRole('checkbox', { name: 'Select message' })[0] as HTMLElement)
    expect(await screen.findByText('2 selected')).toBeInTheDocument()
    await user.click(await screen.findByRole('button', { name: 'Flag' }))
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({ keyword: '$flagged', value: true })
  })

  it('the bulk toggles read the WHOLE selection, not just the rows on screen', async () => {
    // The test that proves the fix is not a relocation of the drift. Both toggle predicates used to
    // be hydrated from `rowById`, which holds the VIRTUAL WINDOW only — but select-all dispatches
    // over the whole window. Off-screen selected rows resolve to `undefined` there, the predicate
    // reads false even though every message qualifies, and the button then SETS what `s`/`u` (which
    // hydrate from the full target set) would CLEAR.
    //
    // 30 rows is not decoration: the harness stubs a 600px viewport and at comfortable density
    // (76px) with OVERSCAN 8 the virtualizer renders ~16 rows, and `scrollTo` is a no-op so the
    // window stays at the head. Any smaller fixture puts every selected id inside `rowById` and the
    // mutation below stays green — the test would prove nothing.
    const ids = Array.from({ length: 30 }, (_, i) => `m${String(i + 1).padStart(2, '0')}`)
    await putEmails(
      db,
      'a',
      ids.map((id) =>
        email(id, { subject: `Msg ${id}`, keywords: { $flagged: true, $seen: true } }),
      ),
    )
    await putQueryCache(db, {
      accountId: 'a',
      key: inboxKey(),
      ids,
      queryState: 'q',
      total: ids.length,
      upToId: ids.at(-1) as string,
      filter: null,
      sort: null,
      collapseThreads: true,
      lastUsedAt: 1,
    })
    const user = userEvent.setup()
    renderList()
    await screen.findByText('Msg m01')
    // Precondition the whole test rests on: the tail is genuinely NOT rendered, so those rows exist
    // only in the selection — never in `rowById`.
    expect(screen.queryByText('Msg m30')).toBeNull()
    expect(screen.getAllByRole('row').length).toBeLessThan(ids.length)

    await user.click(screen.getAllByRole('checkbox', { name: 'Select message' })[0] as HTMLElement)
    await user.click(await screen.findByRole('checkbox', { name: 'Select all' }))
    expect(await screen.findByText('30 selected')).toBeInTheDocument()

    // Once everything IS selected, the same control clears — so it must stop announcing "Select
    // all". It did not: the name was static while `onChange` branched, i.e. a control naming one
    // action and performing the opposite, and for a screen-reader user the name is all there is.
    // `list.clearSelection` was already translated in both languages and had no caller.
    expect(await screen.findByRole('checkbox', { name: 'Clear selection' })).toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: 'Select all' })).toBeNull()

    // Every one of the 30 is flagged AND read, so both buttons must offer to CLEAR — exactly what
    // `s` and `u` would do over the same selection.
    expect(await screen.findByRole('button', { name: 'Unflag' })).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Mark as unread' })).toBeInTheDocument()

    // …and the click that follows the label really does clear, so this is not just a label test.
    await user.click(screen.getByRole('button', { name: 'Unflag' }))
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      kind: 'setKeywords',
      keyword: '$flagged',
      value: false,
      emailIds: ids,
    })
  })

  it('a selection whose rows have not caught up with its ids is not treated as all-flagged', async () => {
    // The `selectedRows.length === ids.length` clause of the predicate, which nothing else covers.
    // The race is real and reachable with two clicks: growing the selection changes
    // `useEmailWindow`'s deps, and dexie-react-hooks keeps serving the PREVIOUS result until the new
    // query resolves. So for one render `ids` is [e1, e2] while `selectedRows` still holds the
    // single row for [e1] — and `every` over that one flagged row would answer "all flagged" for a
    // selection whose second member has not been looked at yet.
    //
    // Both seeded rows ARE flagged, deliberately: the converged answer is "Unflag" both before and
    // after, so the only thing that can produce "Flag" in between is the length guard refusing to
    // trust a result that has not caught up. The test cannot pass by accident of the fixture.
    await putEmails(db, 'a', [
      email('e1', { subject: 'First', keywords: { $flagged: true } }),
      email('e2', { subject: 'Second', keywords: { $flagged: true } }),
    ])
    renderList()
    await screen.findByText('First')
    const boxes = () => screen.getAllByRole('checkbox', { name: 'Select message' })

    // `fireEvent`, not `userEvent`: userEvent awaits between events and would flush the pending
    // liveQuery, which is precisely the render this test needs to observe.
    fireEvent.click(boxes()[0] as HTMLElement)
    expect(await screen.findByRole('button', { name: 'Unflag' })).toBeInTheDocument()

    fireEvent.click(boxes()[1] as HTMLElement)
    expect(screen.getByText('2 selected')).toBeInTheDocument()
    // The unconverged render: one row in hand, two in the selection → the SAFE label. Offering to
    // set a keyword a message already carries is harmless; offering to CLEAR the flag on a message
    // nobody has looked at is the destructive way round.
    expect(screen.getByRole('button', { name: 'Flag' })).toBeInTheDocument()

    // …and it converges rather than sticking on the safe answer: both rows really are flagged.
    expect(await screen.findByRole('button', { name: 'Unflag' })).toBeInTheDocument()
  })

  // `loading` is true only while the window ROW is missing, so a window that EXISTS with `ids: []`
  // and a non-zero `total` used to paint the confident empty state over a folder that has mail —
  // contradicting the `aria-rowcount` beside it and announcing "no results" to a screen reader.
  // Several sync-side paths reach that state and they are NOT a closed set — the comment on
  // `retracted` in `MessageList.tsx` names the ones known and says plainly what is not detected (see
  // also §13 B17). Do not re-enumerate them here: an earlier revision of this block counted "three",
  // and a fourth was found in `delta.ts` afterwards.
  //
  // What the tests below cover is only the RENDERING, from a seeded window, because that is all this
  // component can see — it has no way to tell which path pruned the window, and deliberately renders
  // the same thing for every one of them, which is also why an unenumerated producer still gets the
  // right rendering. So no test here constructs a move, a rejection, or a connectivity state, and
  // none should claim to: the recoverability argument belongs to `outbox.ts`'s and `delta.ts`'s
  // tests, and lives here only as the reason the WORDING defers to the next sync rather than
  // promising a refresh in progress.
  /**
   * The loading state holds the SHAPE of the list.
   *
   * It used to blank the grid and centre a spinner in the empty space, so changing folder threw away
   * the structure the reader had just been looking at and made them find it again a moment later.
   * The placeholder rows are the same skeletons a not-yet-hydrated row already renders, at the
   * virtualizer's own row height, so nothing shifts when the real rows arrive — and they are hidden
   * from assistive technology, which gets the one sentence instead.
   */
  it('renders placeholder rows while the window is loading, not an empty pane', async () => {
    // Archive, because the shared setup seeds a window for the Inbox only — so this is the state a
    // reader gets every time they change folder, which is the moment the old spinner appeared.
    renderList('archive')

    // The announcement survives the change; it is what a screen reader is told.
    expect(await screen.findByText('Loading messages')).toBeInTheDocument()

    const skeletons = screen.getAllByRole('row', { hidden: true })
    expect(skeletons.length).toBeGreaterThanOrEqual(8)
    // Hidden, so the grid does not claim a dozen rows that hold nothing.
    expect(screen.queryAllByRole('row')).toHaveLength(0)
  })

  describe('the empty state', () => {
    async function seedWindow(windowIds: string[], total: number) {
      await putQueryCache(db, {
        accountId: 'a',
        key: inboxKey(),
        ids: windowIds,
        queryState: 'q',
        total,
        upToId: 'e3',
        filter: null,
        sort: null,
        collapseThreads: true,
        lastUsedAt: 1,
      })
    }

    it('an empty window over a non-empty total is out of date, not empty', async () => {
      await seedWindow([], 41)
      renderList()
      expect(
        await screen.findByText('This list is out of date and will refresh on the next sync.'),
      ).toBeInTheDocument()
      expect(screen.queryByText('No messages in this folder.')).toBeNull()
      // NOT the generic spinner: nothing is loading. The window resolved — it is merely stale.
      expect(screen.queryByText('Loading messages')).toBeNull()
      // The row count next to it says 41; claiming emptiness beside that is incoherent either way.
      expect(screen.getByRole('grid')).toHaveAttribute('aria-rowcount', '41')
    })

    // The half the WORDING turns on, and the only half this component can be tested for: the list
    // does not rescue itself. Whether a re-query is reachable is a connectivity question owned by
    // `delta.ts`/`outbox.ts`, but `loadMore` is right here and is gated on `ids.length > 0`, so a
    // retracted window cannot even page its way out. That is why the message must name the condition
    // instead of promising a spinner's progress — asserted below by the engine never being asked.
    it('a retracted window does not page its way out — `loadMore` is never called', async () => {
      const loadMoreFor = vi.fn()
      setActiveEngine({
        watchWindow: vi.fn(() => 'k'),
        loadMoreFor,
        fetchEnvelopes: vi.fn(),
        dispatch,
      } as unknown as Parameters<typeof setActiveEngine>[0])
      // A folder of 200 whose whole 50-id head page a bulk move's prune (or its rollback) took away.
      await seedWindow([], 150)
      renderList()

      expect(
        await screen.findByText('This list is out of date and will refresh on the next sync.'),
      ).toBeInTheDocument()
      expect(screen.queryByText('Loading messages')).toBeNull()
      // The claim the guard exists to suppress: no confident "empty", visibly or to a screen reader.
      expect(screen.queryByText('No messages in this folder.')).toBeNull()
      expect(screen.getByRole('grid')).toHaveAttribute('aria-rowcount', '150')
      // …and it really is a dead end until reconnect, not a paging gap the list can close itself.
      await waitFor(() => expect(loadMoreFor).not.toHaveBeenCalled())
    })

    // The rendered assertions above only ever see ENGLISH — the test i18n instance runs `en` — so
    // nothing here noticed when the German said "wird aktualisiert": a present passive, "is being
    // updated right now", which is the spinner's claim and the exact promise the split onto
    // `loading` was made to stop making. Both bundles must name the CONDITION and defer the action
    // to the next sync, so both are asserted, in both languages, from the bundles themselves.
    it('neither language promises an update that is already under way', () => {
      expect(en.list.stale).toBe('This list is out of date and will refresh on the next sync.')
      expect(de.list.stale).toBe(
        'Diese Liste ist nicht aktuell und wird bei der nächsten Synchronisation aktualisiert.',
      )
      // The property behind the literals, so a future reword cannot quietly drop the qualifier and
      // fall back to "…und wird aktualisiert" / "…will refresh".
      expect(en.list.stale).toMatch(/on the next sync\.$/)
      expect(de.list.stale).toMatch(/bei der nächsten Synchronisation aktualisiert\.$/)
      // …and it uses the bundle's ONE word for the concept. The first draft said "Abgleich" — correct
      // German, but a second term for what every other German sync string calls Synchronisation
      // ("sobald die Synchronisation folgt", "Wird synchronisiert…", "Synchronisationsproblem"). It
      // was a test exactly like this one that would have made the inconsistency permanent, so the
      // term is asserted, not just the sentence.
      expect(de.list.stale).not.toMatch(/Abgleich/)
    })

    it('a genuinely empty folder still says so', async () => {
      // The half a careless guard swallows — and swallowing it would be the worse bug: a real empty
      // folder that shows a permanent spinner never resolves for the user.
      await seedWindow([], 0)
      renderList()
      expect(await screen.findByText('No messages in this folder.')).toBeInTheDocument()
      expect(screen.queryByText('Loading messages')).toBeNull()
      expect(
        screen.queryByText('This list is out of date and will refresh on the next sync.'),
      ).toBeNull()
    })

    // The OTHER half, and the one a `total === undefined ||` slip turns into a second permanent
    // spinner: `QueryCacheRow.total` is `number | null` (`db.ts`) and `null` is a real persisted
    // value the outbox preserves deliberately. `use-message-list.ts` surfaces it as `undefined`, so
    // a PRESENT window with an unknown total is reachable — and it is a genuine empty state.
    it('an empty window with an UNKNOWN total is empty, not out of date', async () => {
      await putQueryCache(db, {
        accountId: 'a',
        key: inboxKey(),
        ids: [],
        queryState: 'q',
        total: null,
        upToId: 'e3',
        filter: null,
        sort: null,
        collapseThreads: true,
        lastUsedAt: 1,
      })
      renderList()
      expect(await screen.findByText('No messages in this folder.')).toBeInTheDocument()
      expect(
        screen.queryByText('This list is out of date and will refresh on the next sync.'),
      ).toBeNull()
      expect(screen.queryByText('Loading messages')).toBeNull()
    })

    it('a search whose window is retracted announces nothing, and a truly empty one says so', async () => {
      setActiveEngine(null)
      const spec: QuerySpec = {
        filter: { hasKeyword: 'work' },
        sort: [{ property: 'receivedAt', isAscending: false }],
        collapseThreads: false,
      }
      const key = canonicalQueryKey(spec)
      const seedSearch = async (total: number) => {
        await putQueryCache(db, {
          accountId: 'a',
          key,
          ids: [],
          queryState: 'q',
          total,
          upToId: 'x1',
          filter: spec.filter ?? null,
          sort: spec.sort ?? null,
          collapseThreads: false,
          lastUsedAt: 1,
        })
      }
      const ui = (
        <RouterProvider>
          <ConfigProvider config={DEFAULT_CONFIG}>
            <ToastProvider>
              <ReplicaProvider accountId="a" db={db}>
                <MessageList mailboxId={undefined} search={{ spec, scopeMailboxId: undefined }} />
              </ReplicaProvider>
            </ToastProvider>
          </ConfigProvider>
        </RouterProvider>
      )

      await seedSearch(7)
      const { unmount } = render(ui)
      // The live region is rendered but must stay SILENT: announcing "no messages match" for a
      // query that matched seven is worse than saying nothing, because a screen-reader user has no
      // rowcount to contradict it with.
      await screen.findByText('This list is out of date and will refresh on the next sync.')
      expect(screen.queryAllByText(/No messages match your search/)).toHaveLength(0)
      unmount()

      // Positive control: a search that really found nothing still announces it.
      await seedSearch(0)
      render(ui)
      // Twice over, and both matter: the visible empty state AND the live region's announcement.
      expect(await screen.findAllByText(/No messages match your search/)).toHaveLength(2)
    })
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

  /**
   * Two of the three terms in `canMoveTo`, the gate that stands IN FRONT of `moveThenClear`. (The
   * third — the self-move term, `target !== fromMailbox` — is pinned by "the bulk bar offers no
   * Archive while viewing Archive" just above, so it is not repeated here.) They are pinned here
   * because `moveThenClear` itself cannot be pinned, and it is worth being exact about why rather
   * than leaving the next reader to rediscover it as a coverage hole.
   *
   * `moveThenClear` carries two defensive lines. Deleting EITHER leaves this whole file green, and
   * that is not a gap these tests close:
   *
   *   - `if (fromMailbox === undefined) return` — its real enforcement is the TYPE checker, not the
   *     suite: `useTriage`'s moves take `Id | null` and `fromMailbox` is `Id | undefined`, so
   *     removing the narrowing fails `tsc --noEmit` with TS2345 while vitest still passes. Verified.
   *     Behaviourally it is unreachable, because `canMoveTo` starts with `canMove`
   *     (`fromMailbox !== undefined`) and all three of this bar's move buttons render behind it.
   *   - `if (move(…)) onClear()` — the boolean it tests is false in exactly three cases
   *     (`to === undefined`, `to === from`, `ids.length === 0`), and each is already excluded before
   *     the button is drawn: the first two by `canMoveTo`'s own two terms, the third by the bar
   *     mounting only under `selection.selected.size > 0` over `ids = [...selection.selected]`.
   *     Dropping the condition passes `tsc` AND this suite. Verified.
   *
   * So the honest statement is: those lines are dominated by the gates below, and the gates are what
   * a test can hold. Weaken `canMoveTo` and one of these two goes red — at which point the guards in
   * `moveThenClear` stop being redundant and start being the thing that saves the user's selection.
   * That is the property worth pinning, and it is the one pinned here.
   *
   * (One residual divergence is NOT covered and is not claimed to be: `canMoveTo` reads BulkBar's
   * own `useMailboxByRole` while `useTriage` reads its own separate subscription of the same query.
   * Two independent `useLiveQuery` instances could in principle report the role mailbox on different
   * renders. Probed directly — two subscriptions in one component, mailbox inserted under a mounted
   * tree — and they resolved in the SAME render every time under React's batching, so no test here
   * can produce the skew. It is why the `if (move(…))` line is kept, not something it is proven to
   * catch.)
   */
  describe('what canMoveTo refuses before a move button is drawn', () => {
    async function selectFirst(user: UserEvent): Promise<void> {
      await screen.findByText('First')
      await user.click(
        screen.getAllByRole('checkbox', { name: 'Select message' })[0] as HTMLElement,
      )
      expect(await screen.findByText('1 selected')).toBeInTheDocument()
    }

    // `canMoveTo`'s `target !== undefined` term. An account with no Archive role must not be offered
    // an Archive button, because `triage.archive` would return false and file nothing — the `e`-chord
    // bug (6da2350) one surface over. Trash still shows, so this is the gate and not an empty bar.
    it('offers no Archive when the account has no Archive mailbox', async () => {
      const user = userEvent.setup()
      await deleteMailbox(db, 'a', 'archive')
      renderList()
      await selectFirst(user)

      expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull()
      expect(screen.getByRole('button', { name: 'Move to Trash' })).toBeInTheDocument()
    })

    // `canMoveTo`'s leading `canMove` term, on the ARCHIVE button. The destructive end of the bar
    // already has this covered ("offers neither destructive button in a source-less search
    // selection"); Archive did not, and it is the button whose absence makes `moveThenClear`'s
    // `fromMailbox === undefined` line unreachable. Read/flag need no source and stay, so a green
    // assertion here means the gate fired rather than the bar failing to mount.
    it('offers no Archive in a source-less (cross-folder) search selection', async () => {
      const user = userEvent.setup()
      const spec: QuerySpec = {
        filter: { text: 'report' },
        sort: [{ property: 'receivedAt', isAscending: false }],
        collapseThreads: false,
      }
      await putQueryCache(db, {
        accountId: 'a',
        key: canonicalQueryKey(spec),
        ids: ['e1'],
        queryState: 'q',
        total: 1,
        upToId: 'e1',
        filter: spec.filter ?? null,
        sort: spec.sort ?? null,
        collapseThreads: false,
        lastUsedAt: 1,
      })
      renderSearch(spec)
      await selectFirst(user)

      expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull()
      expect(screen.getByRole('button', { name: 'Mark as read' })).toBeInTheDocument()
    })
  })

  /**
   * The bulk bar's destructive end. It used to render "Move to Trash" AND an unconditional "Delete"
   * (permanent destroy) as adjacent icon-only buttons drawing the SAME `Trash2` glyph — in the Inbox
   * a user saw two identical icons, one recoverable and one not, told apart only by an accessible
   * name they never hear. It is now the ONE button `MessageView`'s action bar has always had, and
   * that the `#` chord's `inTrash` context already assumed: Move to Trash outside Trash, Delete
   * inside it.
   */
  describe('the destructive bulk action', () => {
    async function seedFolder(mailboxId: string, subject: string): Promise<void> {
      await putEmails(db, 'a', [
        email('x1', { subject, mailboxIds: { [mailboxId]: true }, keywords: {} }),
      ])
      await putQueryCache(db, {
        accountId: 'a',
        key: folderKey(mailboxId),
        ids: ['x1'],
        queryState: 'q',
        total: 1,
        upToId: 'x1',
        filter: null,
        sort: null,
        collapseThreads: true,
        lastUsedAt: 1,
      })
    }

    async function selectOne(user: UserEvent, subject: string): Promise<void> {
      await screen.findByText(subject)
      await user.click(
        screen.getAllByRole('checkbox', { name: 'Select message' })[0] as HTMLElement,
      )
      await screen.findByText('1 selected')
    }

    it('offers exactly one Trash2 button outside Trash — the recoverable one', async () => {
      const user = userEvent.setup()
      renderList()
      await selectOne(user, 'First')

      expect(screen.getByRole('button', { name: 'Move to Trash' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull()
    })

    it('swaps to the permanent Delete inside Trash, and offers no move-to-Trash there', async () => {
      const user = userEvent.setup()
      await seedFolder('trash', 'Binned')
      renderList('trash')
      await selectOne(user, 'Binned')

      expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Move to Trash' })).toBeNull()
    })

    // Icon-only buttons whose meaning is irreversible owe their confirm dialog the word "permanent".
    // The dialog used to say only "1 selected", which is a count, not a warning.
    it('confirms the destroy with a permanence warning, then dispatches it', async () => {
      const user = userEvent.setup()
      await seedFolder('trash', 'Binned')
      renderList('trash')
      await selectOne(user, 'Binned')

      await user.click(screen.getByRole('button', { name: 'Delete' }))
      const dialog = await screen.findByRole('dialog', { name: 'Delete' })
      expect(dialog).toHaveTextContent(/permanently deleted/)
      expect(dialog).toHaveTextContent(/can’t be undone/)

      await user.click(within(dialog).getByRole('button', { name: 'Delete' }))
      expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
        kind: 'destroyEmails',
        emailIds: ['x1'],
      })
    })

    // A cross-folder search selection spans folders, so there is no `from` to move out of — and a
    // per-folder permanent destroy is exactly the action the plan forbids there (a message filed
    // elsewhere too would be destroyed everywhere). Neither destructive button belongs.
    it('offers neither destructive button in a source-less search selection', async () => {
      const user = userEvent.setup()
      const spec: QuerySpec = {
        filter: { text: 'report' },
        sort: [{ property: 'receivedAt', isAscending: false }],
        collapseThreads: false,
      }
      await putQueryCache(db, {
        accountId: 'a',
        key: canonicalQueryKey(spec),
        ids: ['e1'],
        queryState: 'q',
        total: 1,
        upToId: 'e1',
        filter: spec.filter ?? null,
        sort: spec.sort ?? null,
        collapseThreads: false,
        lastUsedAt: 1,
      })
      renderSearch(spec)
      await selectOne(user, 'First')

      expect(screen.queryByRole('button', { name: 'Move to Trash' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull()
    })

    /**
     * Junk — the folder this bar had no test for at all, and the one where it deliberately does NOT
     * follow `FolderTree`'s `olderMode` (which destroys permanently in Junk, and is tested there).
     *
     * The rule this bar follows is the per-selection one its two sibling surfaces already implement:
     * `MessageView`'s action bar (`inTrash`, one `Trash2` reading "Move to Trash" outside Trash and
     * "Delete" inside it) and the `#` chord's `inTrash` in `use-shortcut-context.ts`. Both resolve
     * `inTrash` against the TRASH role alone, so in Junk both offer the recoverable move — and a bar
     * that destroyed here would be the odd one out among three surfaces, not the one that fell in
     * line. Junk is also where a false-positive classification lands, which is the mail most in need
     * of a recovery step.
     */
    it('offers the recoverable move in Junk, not the permanent destroy', async () => {
      const user = userEvent.setup()
      await putMailboxes(db, 'a', [mailbox('junk', { role: 'junk' })])
      await seedFolder('junk', 'Spam')
      renderList('junk')
      await selectOne(user, 'Spam')

      expect(screen.getByRole('button', { name: 'Move to Trash' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull()
      // And no "Mark as junk" while standing IN Junk — `canMoveTo` already refuses a self-move, so
      // the destructive end of the bar is the only thing this test is pinning.
      expect(screen.queryByRole('button', { name: 'Mark as junk' })).toBeNull()
    })

    // The move must actually dispatch, not merely render: a button that survives the gate and then
    // does nothing is the anti-pattern this bar's `canMoveTo` exists to prevent, one folder over.
    it('moves the Junk selection to Trash rather than destroying it', async () => {
      const user = userEvent.setup()
      await putMailboxes(db, 'a', [mailbox('junk', { role: 'junk' })])
      await seedFolder('junk', 'Spam')
      renderList('junk')
      await selectOne(user, 'Spam')

      await user.click(screen.getByRole('button', { name: 'Move to Trash' }))
      expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
        kind: 'move',
        emailIds: ['x1'],
        from: 'junk',
        to: 'trash',
      })
      // The one thing that must never come out of this bar in Junk.
      for (const call of dispatch.mock.calls) {
        expect(call[0]).not.toMatchObject({ kind: 'destroyEmails' })
      }
    })

    it('names the permanence warning in German too, in the formal register', () => {
      expect(de.list.confirmDeleteBody_other).toMatch(/endgültig gelöscht/)
      expect(de.list.confirmDeleteBody_one).toMatch(/endgültig gelöscht/)
      expect(de.list.confirmDeleteBody_other).not.toMatch(/\b[Dd]ein|\bDu\b/)
    })
  })

  /**
   * The toolbar's Sort / Conversations / Unread-first on the SEARCH seam (search results M3.1 and
   * label browse M3.2, which share it).
   *
   * `use-message-list.ts` keys a search off `canonicalQueryKey(spec)` and watches that spec alone —
   * it never reads the `sort`/`unreadFirst`/`flat` arguments on that branch. So all three controls
   * were fully enabled, wrote their preference, and changed nothing about the list in front of the
   * user: the control moved, the setting stuck, the list did not budge. Enabled-and-inert is the one
   * option that is not allowed; they are disabled here with the reason on screen.
   */
  describe('the view options that the search seam cannot honour', () => {
    const spec: QuerySpec = {
      filter: { hasKeyword: 'work' },
      sort: [{ property: 'receivedAt', isAscending: false }],
      collapseThreads: false,
    }

    async function seedLabelWindow(): Promise<void> {
      await putQueryCache(db, {
        accountId: 'a',
        key: canonicalQueryKey(spec),
        ids: ['e1'],
        queryState: 'q',
        total: 1,
        upToId: 'e1',
        filter: spec.filter ?? null,
        sort: spec.sort ?? null,
        collapseThreads: false,
        lastUsedAt: 1,
      })
    }

    it('leaves them live in a folder view (the control, so "disabled" means something)', async () => {
      renderList()
      await screen.findByText('First')
      expect(screen.getByLabelText('Sort')).toBeEnabled()
      expect(screen.getByLabelText('View')).toBeEnabled()
      expect(screen.getByRole('checkbox', { name: 'Unread first' })).toBeEnabled()
      expect(screen.queryByText(/apply to folders only/)).toBeNull()
      // …and no control points at a reason that is not on screen. The note only renders on the
      // search seam, so an unconditional `aria-describedby` here would be a dangling IDREF — a
      // screen reader announcing nothing extra, and the one defect axe cannot see from the search
      // render alone (it never renders this branch).
      for (const control of [
        screen.getByLabelText('Sort'),
        screen.getByLabelText('View'),
        screen.getByRole('checkbox', { name: 'Unread first' }),
      ]) {
        expect(control).not.toHaveAttribute('aria-describedby')
      }
    })

    /**
     * THE case the gate exists for, and the one wave 1 never rendered: a folder-scoped search
     * (`/mail/inbox?q=report`), where `MailScreen` passes `mailboxId` AND `search` together.
     *
     * Every other test in this block goes through `renderSearch`, which hardcodes
     * `mailboxId={undefined}` — so "on the search seam" and "outside any folder" were the same
     * condition in every fixture, and a gate keyed off EITHER one passed all of them. Keyed off the
     * mailbox, this is the exact route where the three controls come back to life, write their
     * preference, and move nothing: the defect the gate was added to remove, in its dominant form.
     */
    it('disables them for a folder-scoped search too (mailboxId AND search)', async () => {
      await seedLabelWindow()
      renderFolderSearch(spec)
      await screen.findByText('First')

      const reason = screen.getByText('Sorting and conversation view apply to folders only.')
      for (const control of [
        screen.getByLabelText('Sort'),
        screen.getByLabelText('View'),
        screen.getByRole('checkbox', { name: 'Unread first' }),
      ]) {
        expect(control).toBeDisabled()
        expect(control).toHaveAttribute('aria-describedby', reason.id)
      }
      // Density is no longer here at all: Settings → Appearance already wrote the same
      // `list.density` key, so the toolbar copy was a second door onto one room.
      expect(screen.queryByLabelText('Density')).toBeNull()
    })

    // The persisting half, on that same route. A folder-scoped search is precisely where a written
    // preference does the most damage: the user is one `Escape` away from the folder view where the
    // sort they never chose is suddenly in force.
    it('writes no preference from a folder-scoped search either', async () => {
      await seedLabelWindow()
      renderFolderSearch(spec)
      await screen.findByText('First')

      fireEvent.change(screen.getByLabelText('Sort'), { target: { value: 'subject' } })
      fireEvent.change(screen.getByLabelText('View'), { target: { value: 'flat' } })
      fireEvent.click(screen.getByRole('checkbox', { name: 'Unread first' }))

      await waitFor(() => expect(screen.getByText('First')).toBeInTheDocument())
      expect(await getPref(db, 'a', 'list.sort')).toBeUndefined()
      expect(await getPref(db, 'a', 'list.flat')).toBeUndefined()
      expect(await getPref(db, 'a', 'list.unreadFirst')).toBeUndefined()
    })

    it('disables them on the search seam and says why on screen', async () => {
      await seedLabelWindow()
      renderSearch(spec)
      await screen.findByText('First')

      const reason = screen.getByText('Sorting and conversation view apply to folders only.')
      for (const control of [
        screen.getByLabelText('Sort'),
        screen.getByLabelText('View'),
        screen.getByRole('checkbox', { name: 'Unread first' }),
      ]) {
        expect(control).toBeDisabled()
        // Not a bare grey control: the reason is reachable from the control itself, not only by
        // sighted proximity.
        expect(control).toHaveAttribute('aria-describedby', reason.id)
      }
      // Density used to live here too, ungated, because it is pure presentation. It has moved out
      // altogether: Settings → Appearance offered the identical control writing the identical
      // `list.density` key, and one setting with two doors is one door too many.
      expect(screen.queryByLabelText('Density')).toBeNull()
    })

    // The other half of the promise, and the half that persists: a setting the user cannot see take
    // effect must not be written behind their back either. `disabled` carries this in a browser (a
    // disabled control fires no change event); the guard carries it against any other dispatch.
    it('writes no preference when a change is forced onto a disabled control', async () => {
      await seedLabelWindow()
      renderSearch(spec)
      await screen.findByText('First')

      fireEvent.change(screen.getByLabelText('Sort'), { target: { value: 'subject' } })
      fireEvent.change(screen.getByLabelText('View'), { target: { value: 'flat' } })
      fireEvent.click(screen.getByRole('checkbox', { name: 'Unread first' }))

      await waitFor(() => expect(screen.getByText('First')).toBeInTheDocument())
      expect(await getPref(db, 'a', 'list.sort')).toBeUndefined()
      expect(await getPref(db, 'a', 'list.flat')).toBeUndefined()
      expect(await getPref(db, 'a', 'list.unreadFirst')).toBeUndefined()
    })

    it('states the reason in German too, in the formal register', () => {
      expect(de.list.viewOptionsUnavailable).toMatch(/Ordner/)
      expect(de.list.viewOptionsUnavailable).not.toMatch(/\b[Dd]ein|\bDu\b/)
    })

    // The disabled state is new markup in a labelled toolbar; axe catches the classic slips here
    // (a description pointing at nothing, a label orphaned from its control).
    it('has no axe violations with the controls disabled', async () => {
      await seedLabelWindow()
      const { container } = renderSearch(spec)
      await screen.findByText('First')
      await expectNoA11yViolations(container)
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
                <MessageList mailboxId={mailboxId} viewOptionsOpen />
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
      // Trash → Archive is a perfectly legal move. Wait for the SETTLED state, not merely for the
      // Archive strip to GO — the same latent race the "no Archive account" test carries: the bare
      // negative also goes true for a row not yet hydrated, so under load the gate can pass before
      // the left pref lands and the synchronous swipe below arms an Archive strip in the gap. Gate on
      // the row being HYDRATED (its right-direction `read` reveal, which the left pref does not
      // touch) AND no Archive strip in that same render: together they hold only once left has become
      // the inert self-move, and neither regresses.
      await waitFor(() => {
        expect(screen.getByText('Mark as read')).toBeInTheDocument()
        expect(screen.queryByText('Archive')).toBeNull()
      })

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
      // `target = action === 'archive' ? archiveId : trashId` — so a `none` that escapes its own gate
      // does not fall through to a no-op, it falls through to TRASH. The user asked for the direction
      // to do nothing and a thumb deletes their mail. (TypeScript now catches this particular escape
      // at `kind: action`, since G2/B3 removed the `kind` widening — but the gate is the guarantee.)
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

    it('SAFETY: a direction set to "Archive" is INERT on an account with no Archive — it must never fall back to Trash', async () => {
      // REVERSED in G2/B3; this test used to assert the opposite ("falls back to Trash"). The
      // fallback was deliberate, but a gesture the user configured as "Archive" must never be the
      // thing that puts mail in the bin: a thumb IS the whole interaction, there is no confirmation
      // step, and the strip the finger revealed said "Archive". It also contradicted the keyboard on
      // the same list, where `e` refused the identical account shape — and now says so out loud.
      renderList()
      await screen.findByText('First')
      // Render WITH an Archive and wait for its layer — that is what pins `useMailboxes()` as
      // resolved — then take the folder away. "The Archive layer is gone" cannot double as the
      // assertion here (roles-not-ready satisfies it too), which is what the positive control below
      // is for.
      await screen.findAllByText('Archive')
      await deleteMailbox(db, 'a', 'archive')
      // Gate on the NEW state being fully live, not merely on the Archive strip having vanished. That
      // negative alone is too weak: it also goes true for a render where a row is not yet hydrated
      // (`resolveSwipe` returns null for every direction then), so under parallel load it can win the
      // race against `useMailboxes()` actually dropping the role — the gate passes on a render where
      // the left direction still resolves to `archive`, the synchronous swipe below arms a strip, and
      // `expectInert` fails at exactly this line. So wait for the airtight shape the "Nothing" test
      // uses: all three rows HYDRATED (their right-direction `read` reveal is present, and `read`
      // returns before the `useMailboxes()` gate so it depends on hydration ALONE, not the role) AND
      // no Archive strip in that same render. Both hold only once the account genuinely has no
      // Archive, and neither can regress — the folder stays deleted, the rows stay hydrated — so the
      // swipe that follows is guaranteed to see the settled state.
      // `queryAllByText`, not `queryByText`: the failure this gate guards against reveals a strip on
      // EVERY row, and `queryByText` THROWS on multiple matches. Inside `waitFor` a throw reads as
      // "not settled yet", so the loop would keep polling and finally time out on the wrong thing —
      // hiding the very shape it is here to catch. The assertions below already use the plural form
      // for exactly this reason; the gate did not.
      await waitFor(() => {
        expect(screen.getAllByText('Mark as read')).toHaveLength(3)
        expect(screen.queryAllByText('Archive')).toHaveLength(0)
      })

      swipe(rowWrap('First'), -150)

      // Nothing reaches the outbox — in particular no move to Trash, which is what this used to do.
      expect(dispatch).not.toHaveBeenCalled()
      // …and inert in the two ways the user perceives it, not merely refused downstream.
      expectInert(rowWrap('First'))
      // `queryAllBy`: the failure mode reveals a strip on EVERY row, and `queryByText` would throw
      // "found multiple elements" instead of stating the count.
      expect(screen.queryAllByText('Move to Trash')).toHaveLength(0)

      // Positive control in the SAME render: the other direction still acts, so "nothing dispatched"
      // above is this gate and not a list whose gestures stopped being wired at all.
      swipe(rowWrap('First'), 150)
      expect(dispatch).toHaveBeenCalledTimes(1)
      expect(dispatch.mock.calls[0]?.[0]).toMatchObject({ kind: 'setKeywords', emailIds: ['e1'] })
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

  describe('rights refuse OUT LOUD, and gestures refuse silently (B34)', () => {
    /** Re-seed the inbox with a right denied, so the bar renders against a real mixed account. */
    async function denyInInbox(right: 'maySetSeen' | 'maySetKeywords' | 'mayRemoveItems') {
      await putMailboxes(db, 'a', [
        mailbox('inbox', { role: 'inbox', myRights: { ...FULL_RIGHTS, [right]: false } }),
        mailbox('archive', { role: 'archive' }),
        mailbox('trash', { role: 'trash' }),
      ])
    }

    async function selectFirst(user: UserEvent): Promise<void> {
      await screen.findByText('First')
      await user.click(
        screen.getAllByRole('checkbox', { name: 'Select message' })[0] as HTMLElement,
      )
      await screen.findByText('1 selected')
    }

    it('marks the read button unavailable, explains it, and dispatches nothing', async () => {
      // aria-disabled, NOT disabled: the control has to stay focusable or the explanation is
      // unreachable by exactly the user who needs it (FR-A11Y-01).
      const user = userEvent.setup()
      await denyInInbox('maySetSeen')
      renderList()
      await selectFirst(user)

      const button = await screen.findByRole('button', { name: 'Mark as read' })
      await waitFor(() => expect(button).toHaveAttribute('aria-disabled', 'true'))
      expect(button).not.toBeDisabled()
      expect(button).toHaveAccessibleDescription(en.rights.unavailable.seen)

      dispatch.mockClear()
      await user.click(button)
      expect(dispatch).not.toHaveBeenCalled()
    })

    it('marks the flag button unavailable when keywords are denied', async () => {
      const user = userEvent.setup()
      await denyInInbox('maySetKeywords')
      renderList()
      await selectFirst(user)

      const button = await screen.findByRole('button', { name: 'Flag' })
      await waitFor(() => expect(button).toHaveAttribute('aria-disabled', 'true'))
      expect(button).toHaveAccessibleDescription(en.rights.unavailable.keywords)
    })

    it('marks Archive unavailable when the SOURCE denies removal', async () => {
      // The half every pre-existing check missed: rights were consulted for move TARGETS only.
      const user = userEvent.setup()
      await denyInInbox('mayRemoveItems')
      renderList()
      await selectFirst(user)

      const button = await screen.findByRole('button', { name: 'Archive' })
      await waitFor(() => expect(button).toHaveAttribute('aria-disabled', 'true'))
      expect(button).toHaveAccessibleDescription(en.rights.unavailable.remove)
    })

    it('leaves every bulk control operable on an account that grants everything', async () => {
      // The single-account no-regression pin.
      const user = userEvent.setup()
      renderList()
      await selectFirst(user)

      for (const name of ['Mark as read', 'Flag', 'Archive', 'Move to Trash']) {
        expect(screen.getByRole('button', { name })).not.toHaveAttribute('aria-disabled')
      }
    })

    it('makes a row undraggable when it may not leave the folder', async () => {
      // A gesture gets no words — there is nowhere under a finger to put them — so it goes inert
      // instead of promising a drop it cannot keep. The bulk bar's Move button is the pointer
      // alternative that DOES explain itself (SC 2.5.7).
      await denyInInbox('mayRemoveItems')
      const { container } = renderList()
      await screen.findByText('First')

      // `draggable` lives on the presentational wrapper around each row — the only node that owns
      // both the drag and the swipe — so it is read from the DOM rather than through a role.
      await waitFor(() => {
        expect(container.querySelector('[draggable]')?.getAttribute('draggable')).toBe('false')
      })
    })

    it('keeps rows draggable when removal is permitted', async () => {
      const { container } = renderList()
      await screen.findByText('First')

      await waitFor(() => {
        expect(container.querySelector('[draggable]')?.getAttribute('draggable')).toBe('true')
      })
    })
  })

  /**
   * An empty WINDOW is not an empty folder (M4.8).
   *
   * The replica holds `inMailbox AND receivedAt >= now − offline.cacheDays`, so a folder whose mail
   * is all older than that syncs to an empty window. The list said "No messages in this folder."
   * while the sidebar beside it showed the folder's real unread count — two parts of one screen
   * contradicting each other with no way to tell which was wrong. Found against the 100 k perf
   * fixture, where the whole corpus sat outside the window and the app reported an empty folder
   * against a server answering 100 000 to the same query.
   */
  describe('the empty state distinguishes empty from out-of-window', () => {
    async function renderEmpty(totalEmails: number) {
      await putMailboxes(db, 'a', [mailbox('empty', { name: 'Empty', totalEmails })])
      await putQueryCache(db, {
        accountId: 'a',
        key: folderKey('empty'),
        ids: [],
        queryState: 'q',
        total: 0,
        upToId: null,
        filter: null,
        sort: null,
        collapseThreads: true,
        lastUsedAt: 1,
      })
      renderList('empty')
    }

    it('says the folder is empty when it really is', async () => {
      await renderEmpty(0)
      expect(await screen.findByText('No messages in this folder.')).toBeInTheDocument()
    })

    it('explains the offline window when the folder has mail the window excludes', async () => {
      await renderEmpty(100_000)

      const note = await screen.findByText(/No messages from the last 30 days/)
      expect(note).toBeInTheDocument()
      // The old text would have been a flat contradiction of the sidebar's count.
      expect(screen.queryByText('No messages in this folder.')).toBeNull()
      // …and it must NOT send the user to Settings. This assertion used to demand the opposite —
      // it required the sentence to name "the setting that changes it" — but no such setting
      // exists: `offline.cacheDays` comes from the deployment's config.json and StorageSection only
      // PRINTS it. So the copy promised a control the user would then hunt for and never find,
      // which is worse than saying nothing, and the test was holding that promise in place.
      expect(note).not.toHaveTextContent(/Settings/)
      expect(note).toHaveTextContent(/this device only keeps the last 30 days/)
    })
  })
})
