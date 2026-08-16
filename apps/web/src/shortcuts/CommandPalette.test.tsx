import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '../app/config'
import { ConfigProvider } from '../app/config-context'
import { RouterProvider } from '../app/route'
import { LABELS_PREF_KEY } from '../mail/labels/label-model'
import { EMPTY_LIST_STATE, useListStore } from '../mail/list-store'
import { useReadingStore } from '../mail/reading-store'
import { putMailboxes, type ReplicaDb, ReplicaProvider, setPref } from '../sync'
import { setActiveEngine } from '../sync/engine'
import { freshDb, mailbox } from '../sync/test-utils'
import { expectNoA11yViolations } from '../test/axe'
import { ToastProvider } from '../ui'
import { ShortcutProvider } from './ShortcutProvider'
import { usePaletteUi } from './ui-store'

const dispatch = vi.fn()
let db: ReplicaDb

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: () => {},
  })
})
afterAll(() => vi.restoreAllMocks())

function renderShell() {
  return render(
    <RouterProvider>
      <ConfigProvider config={DEFAULT_CONFIG}>
        <ToastProvider>
          <ReplicaProvider accountId="a" db={db}>
            <ShortcutProvider />
          </ReplicaProvider>
        </ToastProvider>
      </ConfigProvider>
    </RouterProvider>,
  )
}

/** Open the palette the way ⌘K does (the shell must already be mounted); waits for the lazy chunk. */
async function openPalette(): Promise<HTMLElement> {
  act(() => usePaletteUi.getState().openPalette())
  return await screen.findByRole('dialog', { name: 'Command palette' })
}

/** Mount the shell and open the palette. */
async function mountAndOpen(): Promise<HTMLElement> {
  renderShell()
  return await openPalette()
}

const options = (): HTMLElement[] => screen.getAllByRole('option')

beforeEach(async () => {
  window.history.pushState(null, '', '/mail/inbox')
  db = freshDb()
  dispatch.mockReset()
  // A live list window, so the triage actions are ENABLED — the palette's item list is exactly the
  // set of runnable actions, which is the behaviour under test here.
  useListStore.setState({
    ...EMPTY_LIST_STATE,
    windowKey: 'w',
    ids: ['e1', 'e2'],
    sourceMailboxId: 'inbox',
  })
  useReadingStore.setState({ handlers: null })
  usePaletteUi.getState().closeOverlays()
  setActiveEngine({ dispatch } as unknown as Parameters<typeof setActiveEngine>[0])
  await putMailboxes(db, 'a', [
    mailbox('inbox', { role: 'inbox' }),
    mailbox('archive', { role: 'archive' }),
    mailbox('team', { name: 'Team' }),
  ])
  await setPref(db, 'a', LABELS_PREF_KEY, [{ keyword: 'work', name: 'Work', color: 'blue' }])
})

afterEach(async () => {
  setActiveEngine(null)
  window.history.pushState(null, '', '/')
  await db.delete()
})

describe('CommandPalette', () => {
  it('lists actions, folders and labels — the palette reaches everything', async () => {
    await mountAndOpen()
    await waitFor(() => expect(screen.getByText('Go to folder: Inbox')).toBeInTheDocument())
    expect(screen.getByText('Go to folder: Team')).toBeInTheDocument()
    expect(screen.getByText('Go to label: Work')).toBeInTheDocument()
    expect(screen.getByText('Go to Settings')).toBeInTheDocument()
    expect(screen.getByText('New message')).toBeInTheDocument()
    expect(screen.getByText('Archive')).toBeInTheDocument()
    // …but NOT the actions that cannot run right now: `enabled(ctx)` is the item list.
    expect(screen.queryByText('Reply all')).toBeNull() // no message is open
    expect(screen.queryByText('Next message')).toBeNull() // paletteHidden — keys only
  })

  it('filters fuzzily as you type', async () => {
    const user = userEvent.setup()
    await mountAndOpen()
    await waitFor(() => expect(screen.getByText('Go to folder: Inbox')).toBeInTheDocument())

    await user.keyboard('arch')
    const labels = options().map((option) => option.textContent ?? '')
    expect(labels.some((label) => label.includes('New message'))).toBe(false)
    // The tight, word-initial match (the "Archive" ACTION, whose chip reads "E") outranks the same
    // letters buried further in ("Search", "Go to folder: Archive").
    expect(labels[0]).toContain('Archive')
    expect(labels[0]).not.toContain('Go to folder')
    expect(labels.some((label) => label.includes('Go to folder: Archive'))).toBe(true)
  })

  it('ArrowDown moves aria-activedescendant (the options are never focused)', async () => {
    const user = userEvent.setup()
    await mountAndOpen()
    await waitFor(() => expect(options().length).toBeGreaterThan(1))
    const input = screen.getByRole('combobox')
    const first = input.getAttribute('aria-activedescendant')

    await user.keyboard('{ArrowDown}')
    const second = input.getAttribute('aria-activedescendant')
    expect(second).not.toBe(first)
    expect(document.activeElement).toBe(input)
    expect(options()[1]).toHaveAttribute('aria-selected', 'true')
  })

  it('Enter runs the active item and closes the palette (folder jump)', async () => {
    const user = userEvent.setup()
    await mountAndOpen()
    await waitFor(() => expect(screen.getByText('Go to folder: Team')).toBeInTheDocument())

    await user.keyboard('team')
    await waitFor(() => expect(options()[0]?.textContent).toContain('Team'))
    await user.keyboard('{Enter}')

    await waitFor(() => expect(window.location.pathname).toBe('/mail/team'))
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull()
  })

  it('a label item navigates to the label view (?label=…, not a folder)', async () => {
    const user = userEvent.setup()
    await mountAndOpen()
    await waitFor(() => expect(screen.getByText('Go to label: Work')).toBeInTheDocument())

    await user.keyboard('work')
    await waitFor(() => expect(options()[0]?.textContent).toContain('Work'))
    await user.keyboard('{Enter}')

    await waitFor(() => expect(window.location.search).toBe('?label=work'))
    expect(window.location.pathname).toBe('/mail')
  })

  it('ranks the last-run item first when reopened with an empty query (recents)', async () => {
    const user = userEvent.setup()
    await mountAndOpen()
    await waitFor(() => expect(screen.getByText('Go to folder: Team')).toBeInTheDocument())
    await user.keyboard('team')
    await waitFor(() => expect(options()[0]?.textContent).toContain('Team'))
    await user.keyboard('{Enter}')
    await waitFor(() => expect(window.location.pathname).toBe('/mail/team'))

    const dialog = await openPalette()
    await waitFor(() =>
      expect(within(dialog).getAllByRole('option')[0]?.textContent).toContain('Team'),
    )
    // …under a "Recent" heading, so the ordering is explained rather than mysterious.
    expect(within(dialog).getByText('Recent')).toBeInTheDocument()
  })

  // THE scope gate. Nothing clears the list window when `MessageList` unmounts, so on /settings the
  // store still holds the last Inbox window — `enabled(ctx)` alone therefore says "yes, Archive can
  // run". It cannot: the dispatcher's scope check says no. One registry, ONE gate (`isRunnable`), or
  // the palette silently archives a message that is not on screen and was never selected.
  it('offers no list/reading action off the mail route, even with a live list window', async () => {
    window.history.pushState(null, '', '/settings')
    await mountAndOpen()
    await waitFor(() => expect(screen.getByText('Go to folder: Inbox')).toBeInTheDocument())

    expect(screen.queryByText('Archive')).toBeNull()
    expect(screen.queryByText('Move to Trash')).toBeNull()
    expect(screen.queryByText('Mark as unread')).toBeNull()
    expect(screen.queryByText('Apply labels')).toBeNull()
    // The global chords stay — they are what the palette is FOR outside the mail route.
    expect(screen.getByText('New message')).toBeInTheDocument()
    expect(screen.getByText('Go to Settings')).toBeInTheDocument()
  })

  it('says so when nothing matches', async () => {
    const user = userEvent.setup()
    await mountAndOpen()
    await waitFor(() => expect(options().length).toBeGreaterThan(0))
    const input = screen.getByRole('combobox')
    expect(input).toHaveAttribute('aria-expanded', 'true')

    await user.keyboard('zzzzzz')

    expect(await screen.findByText('No matches.')).toBeInTheDocument()
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    // B20.4, both halves. The message has to be ANNOUNCED — it was a plain <p>, so a screen-reader
    // user typed into a silence indistinguishable from a broken palette — and `aria-expanded` has to
    // stop claiming there are options to arrow through, right as `aria-activedescendant` vanishes.
    expect(screen.getByRole('status')).toHaveTextContent('No matches.')
    expect(input).toHaveAttribute('aria-expanded', 'false')
    expect(input).not.toHaveAttribute('aria-activedescendant')
  })

  it('has no a11y violations', async () => {
    await mountAndOpen()
    await waitFor(() => expect(options().length).toBeGreaterThan(0))
    await expectNoA11yViolations(document.body)
  })
})
