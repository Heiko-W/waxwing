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

  it('has no a11y violations', async () => {
    await openHelp()
    await expectNoA11yViolations(document.body)
  })
})
