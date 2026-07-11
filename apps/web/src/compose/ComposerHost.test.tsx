import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { expectNoA11yViolations } from '../test/axe'
import { ToastProvider } from '../ui'
import ComposerHost from './ComposerHost'
import { useComposerStore } from './composer-store'
import type { EditorEngine, EditorFactory } from './editor-engine'

function makeFakeEngine(): EditorEngine {
  const noop = (): void => {}
  return {
    getHTML: () => '',
    setHTML: noop,
    focus: noop,
    destroy: noop,
    bold: noop,
    removeBold: noop,
    italic: noop,
    removeItalic: noop,
    underline: noop,
    removeUnderline: noop,
    makeUnorderedList: noop,
    makeOrderedList: noop,
    removeList: noop,
    increaseQuoteLevel: noop,
    decreaseQuoteLevel: noop,
    makeLink: noop,
    removeLink: noop,
    setFontSize: noop,
    hasFormat: () => false,
    getPath: () => '',
    addEventListener: noop,
    removeEventListener: noop,
  }
}
const factory: EditorFactory = () => Promise.resolve(makeFakeEngine())
const store = () => useComposerStore.getState()

const renderHost = () =>
  render(
    <ToastProvider>
      <ComposerHost editorFactory={factory} />
    </ToastProvider>,
  )

/** Force the layout tier by stubbing matchMedia (mirrors App.test). */
function stubTier(tier: 'phone' | 'desktop'): void {
  const desktop = tier === 'desktop'
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: desktop,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }))
}

beforeEach(() => {
  stubTier('desktop')
  useComposerStore.setState({ drafts: new Map(), focusedId: undefined })
})
afterEach(() => {
  vi.restoreAllMocks()
  useComposerStore.setState({ drafts: new Map(), focusedId: undefined })
})

describe('ComposerHost', () => {
  it('renders nothing when there are no drafts', () => {
    const { container } = renderHost()
    expect(container).toBeEmptyDOMElement()
    expect(document.querySelector('[data-composer-layer]')).toBeNull()
  })

  it('shows two parallel drafts, each editable independently', async () => {
    const a = store().openDraft()
    const b = store().openDraft()
    renderHost()
    const user = userEvent.setup()
    const subjects = await screen.findAllByLabelText('Subject')
    expect(subjects).toHaveLength(2)
    await user.type(subjects[0] as HTMLElement, 'First')
    await user.type(subjects[1] as HTMLElement, 'Second')
    // The two windows map to distinct drafts (order = creation order).
    const bodies = [store().drafts.get(a)?.subject, store().drafts.get(b)?.subject]
    expect(bodies).toContain('First')
    expect(bodies).toContain('Second')
  })

  it('keeps drafts across a host remount (module-scoped store → survives route changes)', async () => {
    const id = store().openDraft({ body: '<p>keep me</p>' })
    const { unmount } = renderHost()
    await screen.findByRole('dialog')
    unmount() // a route change would swap <main>; the host + store must not lose the draft
    expect(store().drafts.get(id)?.body).toBe('<p>keep me</p>')
    renderHost()
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })

  it('shows exactly one full-screen draft on phone', async () => {
    stubTier('phone')
    store().openDraft()
    store().openDraft()
    renderHost()
    const dialogs = await screen.findAllByRole('dialog')
    expect(dialogs).toHaveLength(1)
    expect(dialogs[0]).toHaveAttribute('aria-modal', 'true')
  })

  it('has no a11y violations with an open draft', async () => {
    store().openDraft()
    renderHost()
    await screen.findByRole('dialog')
    await expectNoA11yViolations(document.body)
  })
})
