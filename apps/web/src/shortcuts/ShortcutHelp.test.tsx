import { act, render, screen, within } from '@testing-library/react'
import i18next from 'i18next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '../app/config'
import { ConfigProvider } from '../app/config-context'
import { RouterProvider } from '../app/route'
import { EMPTY_LIST_STATE, useListStore } from '../mail/list-store'
import { useReadingStore } from '../mail/reading-store'
import { putMailboxes, type ReplicaDb, ReplicaProvider } from '../sync'
import { setActiveEngine } from '../sync/engine'
import { freshDb, mailbox } from '../sync/test-utils'
import { expectNoA11yViolations } from '../test/axe'
import { ToastProvider } from '../ui'
import { SHORTCUTS } from './registry'
import { ShortcutProvider } from './ShortcutProvider'
import { usePaletteUi } from './ui-store'

let db: ReplicaDb

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

async function openHelp(): Promise<HTMLElement> {
  renderShell()
  act(() => usePaletteUi.getState().openHelp())
  return await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })
}

beforeEach(async () => {
  db = freshDb()
  useListStore.setState(EMPTY_LIST_STATE)
  useReadingStore.setState({ handlers: null })
  usePaletteUi.getState().closeOverlays()
  setActiveEngine({ dispatch: vi.fn() } as unknown as Parameters<typeof setActiveEngine>[0])
  await putMailboxes(db, 'a', [mailbox('inbox', { role: 'inbox' })])
})

afterEach(async () => {
  setActiveEngine(null)
  await db.delete()
})

describe('ShortcutHelp', () => {
  it('lists EVERY registry action — it is generated, so it cannot go stale', async () => {
    const dialog = await openHelp()
    for (const action of SHORTCUTS) {
      const title = i18next.t(action.titleKey)
      expect(within(dialog).getAllByText(title).length, action.id).toBeGreaterThan(0)
    }
  })

  it('renders each chord as <kbd> chips, including the secondary one', async () => {
    const dialog = await openHelp()
    const chips = within(dialog)
      .getAllByText(/.*/, { selector: 'kbd' })
      .map((chip) => chip.textContent)
    expect(chips).toContain('E') // archive
    expect(chips).toContain('#') // trash
    expect(chips).toContain('?') // this very dialog
    expect(chips).toContain('C') // compose (primary)
    expect(chips).toContain('N') // compose (⌘N, the best-effort secondary)
  })

  it('marks the scope of a chord that is not global', async () => {
    const dialog = await openHelp()
    expect(within(dialog).getAllByText('Reading pane').length).toBeGreaterThan(0)
    expect(within(dialog).getAllByText('Message list').length).toBeGreaterThan(0)
  })

  // G2/B3. The sheet is the surface a user opens right after a chord did nothing, so it has to answer
  // the question they came with. It must NOT answer it by removing the row: the key exists, the
  // mailbox does not, and an absent row states a different falsehood.
  //
  // This asserts on the TEXT, never on the dimming class — jsdom computes no CSS, so a class assertion
  // would prove nothing about what anyone sees. The text is also the half that reaches a screen reader.
  it('explains a chord this account cannot run, and still lists it', async () => {
    // `beforeEach` seeds an Inbox and nothing else, so Archive/Junk/Trash have no target mailbox.
    const dialog = await openHelp()
    expect(
      await within(dialog).findByText('This account has no Archive folder.'),
    ).toBeInTheDocument()
    expect(within(dialog).getByText('This account has no Junk folder.')).toBeInTheDocument()
    // …and the chords are all still on the sheet, with their keys.
    expect(within(dialog).getAllByText('Archive').length).toBeGreaterThan(0)
    // `v` needs no role mailbox — it is what the toast tells the user to press, so it must never be
    // explained away here.
    expect(within(dialog).getByText('Move to folder')).toBeInTheDocument()
    expect(within(dialog).queryByText('This account has no Move folder.')).toBeNull()
  })

  it('says nothing about an account that DOES have the folder', async () => {
    // The positive control for the test above: without it, a predicate stuck at "always unavailable"
    // passes just as happily, and every account would be told it is missing every folder.
    await putMailboxes(db, 'a', [
      mailbox('inbox', { role: 'inbox' }),
      mailbox('archive', { role: 'archive' }),
    ])
    const dialog = await openHelp()
    // Junk is still missing, which is what proves the sheet has resolved its mailboxes at all — an
    // assertion that merely waits for the Archive reason to be absent would also pass on the very
    // first tick, before `useMailboxes()` had answered anything.
    expect(await within(dialog).findByText('This account has no Junk folder.')).toBeInTheDocument()
    expect(within(dialog).queryByText('This account has no Archive folder.')).toBeNull()
  })

  it('has no a11y violations', async () => {
    await openHelp()
    await expectNoA11yViolations(document.body)
  })
})
