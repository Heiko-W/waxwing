import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '../app/config'
import { ConfigProvider } from '../app/config-context'
import { RouterProvider } from '../app/route'
import { useComposerStore } from '../compose'
import { EMPTY_LIST_STATE, useListStore } from '../mail/list-store'
import { MessageList } from '../mail/MessageList'
import { type ReadingHandlers, useReadingStore } from '../mail/reading-store'
import { SEARCH_INPUT_ID } from '../mail/search/SearchBox'
import {
  deleteMailbox,
  putEmails,
  putMailboxes,
  putQueryCache,
  type ReplicaDb,
  ReplicaProvider,
} from '../sync'
import { setActiveEngine, windowQueryKey } from '../sync/engine'
import { email, freshDb, mailbox } from '../sync/test-utils'
import { TextInput, ToastProvider } from '../ui'
import { ShortcutProvider } from './ShortcutProvider'
import { usePaletteUi } from './ui-store'

// The virtualizer needs a measurable viewport (jsdom has no layout) — same stubs as MessageList.test.
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

function inboxKey(): string {
  return windowQueryKey('inbox', DEFAULT_CONFIG.offline.cacheDays, Date.now(), {
    sort: [{ property: 'receivedAt', isAscending: false }],
    collapseThreads: true,
  }).key
}

/** Fire a keydown the way the browser does: on the focused element, bubbling up to `window`. */
function press(
  key: string,
  init: KeyboardEventInit = {},
  target: Element = document.body,
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  act(() => {
    target.dispatchEvent(event)
  })
  return event
}

/**
 * Press until the assertion holds. `s` is a TOGGLE, and the flag state it toggles from is read out of
 * the replica through a liveQuery — so the first keystroke after a focus change can still be looking
 * at the previous target's rows. Retrying the keystroke is what a user would do; it is also the only
 * honest way to wait for a Dexie subscription in a jsdom test.
 */
async function pressUntil(key: string, assert: () => void): Promise<void> {
  await waitFor(() => {
    dispatch.mockReset()
    press(key)
    assert()
  })
}

/** The shell the dispatcher lives in: the list (which owns the window) + a search box + the provider. */
function renderShell() {
  return render(
    <RouterProvider>
      <ConfigProvider config={DEFAULT_CONFIG}>
        <ToastProvider>
          <ReplicaProvider accountId="a" db={db}>
            {/* Stands in for SearchBox — the `/` chord only needs the stable id. */}
            <input id={SEARCH_INPUT_ID} aria-label="Search" />
            <TextInput aria-label="Elsewhere" />
            {/* biome-ignore lint/a11y/useSemanticElements: a bare contenteditable stands in for Squire's editing surface */}
            <div
              contentEditable
              role="textbox"
              aria-label="Body"
              tabIndex={0}
              suppressContentEditableWarning
            />
            <MessageList mailboxId="inbox" />
            <ShortcutProvider />
          </ReplicaProvider>
        </ToastProvider>
      </ConfigProvider>
    </RouterProvider>,
  )
}

beforeEach(async () => {
  window.history.pushState(null, '', '/mail/inbox')
  db = freshDb()
  dispatch.mockReset()
  useListStore.setState(EMPTY_LIST_STATE)
  useReadingStore.setState({ handlers: null })
  usePaletteUi.getState().closeOverlays()
  useComposerStore.setState({ drafts: new Map(), focusedId: undefined, uploads: new Map() })
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
    email('e1', { subject: 'First', keywords: {} }),
    email('e2', { subject: 'Second', keywords: {} }),
    // Already flagged — so `s` over it has to UNflag (it is a toggle, like the star button).
    email('e3', { subject: 'Third', keywords: { $flagged: true } }),
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
  window.history.pushState(null, '', '/')
  await db.delete()
})

/** Mount the shell and wait for the list window to reach the store. */
async function mounted() {
  renderShell()
  await screen.findByText('First')
  await waitFor(() => expect(useListStore.getState().ids).toHaveLength(3))
}

describe('ShortcutProvider — navigation', () => {
  it('j / k move the roving focus (aria-activedescendant follows)', async () => {
    await mounted()
    const grid = screen.getByRole('grid')
    expect(grid.getAttribute('aria-activedescendant')).toMatch(/-r-e1$/)

    press('j')
    expect(grid.getAttribute('aria-activedescendant')).toMatch(/-r-e2$/)
    press('j')
    expect(grid.getAttribute('aria-activedescendant')).toMatch(/-r-e3$/)
    press('k')
    expect(grid.getAttribute('aria-activedescendant')).toMatch(/-r-e2$/)
  })

  it('j is allowed to auto-repeat (it is the only chord that is, with k)', async () => {
    await mounted()
    press('j', { repeat: true })
    expect(useListStore.getState().focusIndex).toBe(1)
  })
})

describe('ShortcutProvider — triage', () => {
  it('x selects the focused row and shows the bulk bar', async () => {
    await mounted()
    press('x')
    expect(await screen.findByText('1 selected')).toBeInTheDocument()
    expect(useListStore.getState().selection.selected.has('e1')).toBe(true)
  })

  it('e archives the focused row through the outbox (one move intent) and offers Undo', async () => {
    await mounted()
    press('e')

    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      kind: 'move',
      emailIds: ['e1'],
      from: 'inbox',
      to: 'archive',
    })
    expect(await screen.findByRole('button', { name: 'Undo' })).toBeInTheDocument()
  })

  it('e over a multi-row selection moves the whole selection and clears it', async () => {
    await mounted()
    press('x') // e1
    press('j')
    press('x') // e2
    expect(await screen.findByText('2 selected')).toBeInTheDocument()

    press('e')
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({ kind: 'move', emailIds: ['e1', 'e2'] })
    expect(useListStore.getState().selection.selected.size).toBe(0)
  })

  it('# moves to Trash', async () => {
    await mounted()
    press('#', { shiftKey: true }) // en-US: Shift+3
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({ kind: 'move', to: 'trash' })
  })

  it('u in the list marks the target unread', async () => {
    await mounted()
    press('u')
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      kind: 'setKeywords',
      keyword: '$seen',
      value: false,
      emailIds: ['e1'],
    })
  })

  it('l opens the label picker over the target', async () => {
    await mounted()
    press('l')
    expect(await screen.findByRole('menu', { name: 'Apply labels' })).toBeInTheDocument()
  })

  it('a held e fires exactly once (auto-repeat is swallowed)', async () => {
    await mounted()
    press('e')
    press('e', { repeat: true })
    press('e', { repeat: true })
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
  })

  // `s` is a TOGGLE — the star button it shares a seam with toggles, and a key that can only ever SET
  // a flag is exactly the keystroke/button drift `useTriage` exists to prevent.
  it('s flags an unflagged target', async () => {
    await mounted()
    await pressUntil('s', () =>
      expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
        kind: 'setKeywords',
        keyword: '$flagged',
        value: true,
        emailIds: ['e1'],
      }),
    )
  })

  it('s UNflags a target that is already flagged', async () => {
    await mounted()
    press('j')
    press('j') // e3 — seeded with $flagged
    expect(useListStore.getState().focusIndex).toBe(2)

    await pressUntil('s', () =>
      expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
        kind: 'setKeywords',
        keyword: '$flagged',
        value: false,
        emailIds: ['e3'],
      }),
    )
  })

  // The other half of the multi-selection rule, and the half nothing covered: the mixed case below
  // proves `s` SETS, but only this proves it ever CLEARS over more than one row. The bulk bar's flag
  // button is now driven off the same predicate (B9), so "the keystroke is already right" had to
  // stop being an assumption before the button could be made to agree with it.
  it('s UNflags a multi-selection in which every row is already flagged', async () => {
    await putEmails(db, 'a', [email('e2', { subject: 'Second', keywords: { $flagged: true } })])
    await mounted()
    press('j')
    press('x') // e2 — flagged
    press('j')
    press('x') // e3 — flagged
    expect(await screen.findByText('2 selected')).toBeInTheDocument()

    await pressUntil('s', () =>
      expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
        kind: 'setKeywords',
        keyword: '$flagged',
        value: false,
        emailIds: ['e2', 'e3'],
      }),
    )
  })

  it('s flags a MIXED selection (it only unflags when every target already carries the flag)', async () => {
    await mounted()
    press('x') // e1 — not flagged
    press('j')
    press('j')
    press('x') // e3 — flagged
    expect(await screen.findByText('2 selected')).toBeInTheDocument()

    await pressUntil('s', () =>
      expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
        kind: 'setKeywords',
        keyword: '$flagged',
        value: true,
        emailIds: ['e1', 'e3'],
      }),
    )
  })
})

describe('ShortcutProvider — application chords', () => {
  it('c opens a composer draft', async () => {
    await mounted()
    press('c')
    expect(useComposerStore.getState().drafts.size).toBe(1)
  })

  it('/ focuses the search box', async () => {
    await mounted()
    press('/')
    expect(document.activeElement).toBe(document.getElementById(SEARCH_INPUT_ID))
  })

  it('? opens the cheat-sheet', async () => {
    await mounted()
    press('?', { shiftKey: true })
    expect(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument()
  })

  it('⌘K (and Ctrl+K) opens the command palette', async () => {
    await mounted()
    press('k', { metaKey: true })
    expect(await screen.findByRole('dialog', { name: 'Command palette' })).toBeInTheDocument()
  })
})

describe('ShortcutProvider — the guards (this is the work package)', () => {
  it('e typed into a text field dispatches nothing', async () => {
    const user = userEvent.setup()
    await mounted()
    await user.type(screen.getByLabelText('Elsewhere'), 'e')
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('e typed into a contenteditable (the message body) dispatches nothing', async () => {
    await mounted()
    const body = screen.getByLabelText('Body')
    press('e', {}, body)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('e typed into the search box dispatches nothing', async () => {
    const user = userEvent.setup()
    await mounted()
    await user.type(screen.getByLabelText('Search'), 'e')
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('a key pressed inside an open dialog dispatches nothing (portal guard)', async () => {
    await mounted()
    press('?', { shiftKey: true })
    const dialog = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })

    press('e', {}, dialog)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('an already-handled (defaultPrevented) event dispatches nothing — the editor keeps its keys', async () => {
    await mounted()
    const veto = (event: KeyboardEvent): void => event.preventDefault()
    document.addEventListener('keydown', veto)
    try {
      press('e')
      expect(dispatch).not.toHaveBeenCalled()
    } finally {
      document.removeEventListener('keydown', veto)
    }
  })

  it('an IME composition keystroke dispatches nothing', async () => {
    await mounted()
    press('e', { isComposing: true })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('AltGr (ctrl+alt) dispatches nothing', async () => {
    await mounted()
    press('e', { ctrlKey: true, altKey: true })
    expect(dispatch).not.toHaveBeenCalled()
  })

  // A checkbox is an `<input>` — but it accepts no text. Ticking three rows with the mouse leaves the
  // focus on the last checkbox, and that is the most natural hybrid triage flow there is: `e` must fire.
  it('e DOES fire while a row checkbox has focus (a checkbox is not text entry)', async () => {
    const user = userEvent.setup()
    await mounted()
    const box = screen.getAllByRole('checkbox', { name: 'Select message' })[0] as HTMLElement
    await user.click(box)
    expect(await screen.findByText('1 selected')).toBeInTheDocument()

    press('e', {}, document.activeElement ?? box)
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({ kind: 'move', to: 'archive' })
  })

  /**
   * G2/B3. `e` on an account with no Archive folder used to fall out of the dispatcher's loop and do
   * nothing at all — no move, no toast, no live-region text — which from the keyboard is
   * indistinguishable from a key that was never bound. Now it says so, and names `v` as the way out.
   *
   * The barrier has to watch THE DISPATCHER'S OWN view of the roles, and that is subtler than it
   * looks. `useMailboxes()` is a plain `useLiveQuery`, so every call site is an INDEPENDENT
   * subscription: `MessageList`'s swipe reveal layer, `useShortcutContext`, and `useTriage`'s
   * `useMailboxByRole` each re-run their own query on the delete and land on their own tick. Waiting
   * for the reveal layer's "Archive" strip to disappear therefore proves only that `MessageList`
   * caught up, and nothing at all about the context that actually answers `e` — measured at 4/160
   * runs, the context was still holding the deleted mailbox, `e` dispatched a real `move` to it, and
   * `findByText` timed out at ~1s having never seen a toast. `waitFor` re-runs on DOM mutation, so
   * the reveal layer's own removal is what releases it, in the very commit before the context's.
   *
   * The `?` sheet is the honest barrier: `ShortcutProvider` hands `ShortcutHelp` the very `context`
   * object the key dispatcher reads out of `contextRef`, and B3 has it render this reason straight
   * from `action.unavailable(context)`. Once the sheet says the folder is missing, the dispatcher
   * cannot still disagree — it is the same object. Opened through the store rather than the `?` chord
   * so the barrier also holds on `/settings`, where every chord drops to the `global` scope.
   */
  async function withoutArchive(): Promise<void> {
    await mounted()
    await screen.findAllByText('Archive')
    await deleteMailbox(db, 'a', 'archive')

    act(() => usePaletteUi.getState().openHelp())
    const sheet = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })
    await within(sheet).findByText('This account has no Archive folder.')
    act(() => usePaletteUi.getState().closeOverlays())
    // The sheet renders the same string the toast does, and `isInOverlay` would swallow `e` while it
    // is up — so the assertions below only mean what they say once it is fully gone.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  }

  it('e on an account with no Archive folder SAYS so, and moves nothing', async () => {
    await withoutArchive()

    const event = press('e')

    expect(await screen.findByText('This account has no Archive folder.')).toBeInTheDocument()
    // The message is a fix, not an apology: `v` needs no role mailbox and works on the same targets.
    expect(screen.getByText('Press V to pick a folder instead.')).toBeInTheDocument()
    // Nothing reached the outbox — the toast replaces the silence, it does not replace the gate.
    expect(dispatch).not.toHaveBeenCalled()
    // The chord IS ours the moment we answer it, so we own the key too.
    expect(event.defaultPrevented).toBe(true)
  })

  it('e outside the mail area stays completely silent (scope, not just the missing folder)', async () => {
    // Settings and Contacts drop every chord to the `global` scope. `e` explaining mailbox roles from
    // the Settings screen would be a NEW bug introduced by the fix above — this is the regression it
    // most plausibly causes. The URL is set BEFORE the render: the router reads `location` at mount
    // and only listens for `popstate`, so a `pushState` afterwards would leave the route on /mail and
    // this test would pass while proving nothing.
    window.history.pushState(null, '', '/settings')
    await withoutArchive()

    press('e')

    await waitFor(() => expect(dispatch).not.toHaveBeenCalled())
    expect(screen.queryByText('This account has no Archive folder.')).toBeNull()
  })

  it('a held e cannot stack toasts (auto-repeat is swallowed above the gate)', async () => {
    await withoutArchive()
    press('e')
    press('e', { repeat: true })
    press('e', { repeat: true })

    expect(await screen.findAllByText('This account has no Archive folder.')).toHaveLength(1)
  })

  // M4.7 / WCAG 2.1.1. Undo used to be reachable by pointer only: the toast region is portalled to
  // the END of the document, so Tabbing to it means crossing the whole shell — and the toast expired
  // long before anyone got there. `z` is the keyboard's route to the same button.
  describe('z — Undo', () => {
    it('runs the Undo of the toast the last action raised', async () => {
      await mounted()
      press('e') // archive the focused message
      await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
      expect(await screen.findByRole('button', { name: 'Undo' })).toBeInTheDocument()

      press('z')

      await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2))
      // The INVERSE move — the same thing clicking Undo would have dispatched.
      expect(dispatch.mock.calls[1]?.[0]).toMatchObject({
        kind: 'move',
        from: 'archive',
        to: 'inbox',
      })
      expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
    })

    it('says so when there is nothing to undo, rather than doing nothing', async () => {
      await mounted()

      press('z')

      expect(await screen.findByText('Nothing to undo.')).toBeInTheDocument()
      expect(dispatch).not.toHaveBeenCalled()
    })
  })

  // `/` preventDefaults BEFORE it runs, so an always-enabled `/` eats the key on Settings/Contacts —
  // where there is no search box — and with it the browser's own Quick Find, to then do nothing.
  it('/ does not swallow the key when there is no search box on screen', async () => {
    await mounted()
    expect(press('/').defaultPrevented).toBe(true) // with the box: ours

    // Settings / Contacts render no search box (rename the id rather than unmount it — React owns
    // this node): `/` must fall through to the browser's Quick Find instead of being eaten.
    document.getElementById(SEARCH_INPUT_ID)?.setAttribute('id', 'gone')
    expect(press('/').defaultPrevented).toBe(false)
  })
})

describe('ShortcutProvider — reading scope', () => {
  /** Register the handlers the open MessageView would publish. */
  function openReading(
    over: Partial<ReadingHandlers> = {},
  ): Record<string, ReturnType<typeof vi.fn>> {
    const spies = {
      compose: vi.fn(),
      archive: vi.fn(),
      junk: vi.fn(),
      trash: vi.fn(),
      toggleFlag: vi.fn(),
      markUnread: vi.fn(),
      openMove: vi.fn(),
      openLabels: vi.fn(),
      requestDelete: vi.fn(),
      print: vi.fn(),
    }
    act(() =>
      useReadingStore.getState().set({
        emailId: 'e1',
        mailboxId: 'inbox',
        bodyReady: true,
        ...spies,
        ...over,
      }),
    )
    return spies
  }

  beforeEach(() => {
    window.history.pushState(null, '', '/mail/inbox/e1')
  })

  it('r / a / f reuse the open message’s OWN compose callback', async () => {
    await mounted()
    const spies = openReading()

    press('r')
    expect(spies.compose).toHaveBeenCalledWith('reply')
    press('a')
    expect(spies.compose).toHaveBeenCalledWith('replyAll')
    press('f')
    expect(spies.compose).toHaveBeenCalledWith('forward')
  })

  it('r is disabled until the body has loaded', async () => {
    await mounted()
    const spies = openReading({ bodyReady: false })
    press('r')
    expect(spies.compose).not.toHaveBeenCalled()
  })

  it('e archives the open message through its own handler and auto-advances to the next one', async () => {
    await mounted()
    const spies = openReading()

    press('e')
    expect(spies.archive).toHaveBeenCalledTimes(1)
    // The reading pane must not be left on a message that is no longer there.
    await waitFor(() => expect(window.location.pathname).toBe('/mail/inbox/e2'))
  })

  // The other half of the auto-advance, and the half nothing covered: the ROVING FOCUS must land on
  // the very message the reading pane just opened — and stay on it once the archived row leaves the
  // window and every row shifts up. Otherwise `x` ticks the row after it and `j` skips one.
  it('the roving focus follows the auto-advance BY ID, across the row shift', async () => {
    await mounted()
    openReading()

    press('e')
    const store = useListStore.getState()
    expect(store.ids[store.focusIndex]).toBe('e2') // not e3, not "wherever index+1 lands"

    // The move lands: e1 leaves the window, the rows shift up by one.
    const { windowKey } = useListStore.getState()
    act(() => useListStore.getState().setWindow(windowKey, ['e2', 'e3'], 'inbox'))
    const after = useListStore.getState()
    expect(after.ids[after.focusIndex]).toBe('e2') // still the message on screen
  })

  // `x` acts on the ROVING ROW, which has nothing to do with the open message. In the reading scope it
  // would tick a row the user cannot see (a narrow viewport does not even render the list) — and that
  // invisible selection would then take over what `e` archives.
  it('x does nothing in the reading scope', async () => {
    await mounted()
    openReading()
    press('x')
    expect(useListStore.getState().selection.selected.size).toBe(0)
  })

  it('s in the reading scope toggles the OPEN message’s flag through its own handler', async () => {
    await mounted()
    const spies = openReading()
    press('s')
    expect(spies.toggleFlag).toHaveBeenCalledTimes(1)
    expect(dispatch).not.toHaveBeenCalled()
  })

  // `MessageList.open()` goes out of its way to preserve `?q=` / `?label=` so the results list stays;
  // the registry's own navigation steps must do the same, or `j` snaps back to the plain folder — a
  // different window key, which resets the focus and the selection mid-triage.
  it('j / k / u keep the ?q= search context', async () => {
    window.history.pushState(null, '', '/mail/inbox/e1?q=invoice')
    await mounted()
    openReading()

    press('j')
    await waitFor(() => expect(window.location.pathname).toBe('/mail/inbox/e2'))
    expect(window.location.search).toBe('?q=invoice')

    press('u')
    await waitFor(() => expect(window.location.pathname).toBe('/mail/inbox'))
    expect(window.location.search).toBe('?q=invoice')
  })

  it('u goes back to the list (it does NOT mark unread here — the scopes are disjoint)', async () => {
    await mounted()
    openReading()
    press('u')
    await waitFor(() => expect(window.location.pathname).toBe('/mail/inbox'))
    expect(dispatch).not.toHaveBeenCalled()
  })

  // WCAG 2.4.3 (Focus Order). `u` navigates and nothing moves focus, so the reading pane unmounts
  // out from under it and focus falls to <body> — the next Tab starts from the top of the document
  // and a screen reader loses its place entirely. The chords keep working (the dispatcher is
  // document-level), which is exactly why this went unnoticed: everything a sighted keyboard user
  // tries still does something.
  it('u returns FOCUS to the list, not just the route', async () => {
    await mounted()
    openReading()

    press('u')

    await waitFor(() => expect(window.location.pathname).toBe('/mail/inbox'))
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('grid')))
  })

  it('v opens the move dialog, l the label picker', async () => {
    await mounted()
    const spies = openReading()
    press('v')
    expect(spies.openMove).toHaveBeenCalled()
    press('l')
    expect(spies.openLabels).toHaveBeenCalled()
  })
})
