import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { expectNoA11yViolations } from '../test/axe'
import { ToastProvider } from '../ui'
import ComposerHost from './ComposerHost'
import { useComposerStore } from './composer-store'
import type { EditorEngine, EditorFactory } from './editor-engine'
import { NEW_MESSAGE_BTN_ID } from './NewMessageButton'

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
    insertImage: noop,
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

  /*
   * Focus return (WCAG 2.4.3), through the mount gate that decides whether it happens at all.
   *
   * `AppShell` renders the host only while `drafts.size > 0`, so closing the last draft UNMOUNTS it
   * — the "zero drafts" render is never reached. Every test above renders the host directly, which
   * is why the dead effect this replaces stayed green for four milestones. `Gate` reproduces the
   * real condition.
   */
  describe('focus return when the last draft closes', () => {
    function Gate({ triggerId }: { triggerId: string | null }) {
      const hasDrafts = useComposerStore((state) => state.drafts.size > 0)
      return (
        <ToastProvider>
          <button type="button" id="opener">
            opener
          </button>
          {triggerId !== null && (
            <button type="button" id={triggerId}>
              new message
            </button>
          )}
          {hasDrafts && <ComposerHost editorFactory={factory} />}
        </ToastProvider>
      )
    }

    /** Focus the opener, then open a draft from it — the shape of every real compose entry point. */
    async function openFrom(
      triggerId: string | null,
    ): Promise<{ id: string; opener: HTMLElement }> {
      render(<Gate triggerId={triggerId} />)
      const opener = document.getElementById('opener') as HTMLElement
      opener.focus()
      let id = ''
      await act(async () => {
        id = store().openDraft()
      })
      await screen.findByRole('dialog')
      return { id, opener }
    }

    it('prefers the New-message trigger when it is on screen', async () => {
      const { id } = await openFrom(NEW_MESSAGE_BTN_ID)
      await act(async () => {
        store().closeDraft(id)
      })
      expect(document.activeElement).toBe(document.getElementById(NEW_MESSAGE_BTN_ID))
    })

    // B50: off the mail route there is no trigger, and `c` / ⌘N / the palette still open drafts.
    it('falls back to the element that opened the draft when the trigger is absent', async () => {
      const { id, opener } = await openFrom(null)
      await act(async () => {
        store().closeDraft(id)
      })
      expect(document.activeElement).toBe(opener)
    })

    // A command-palette row is gone by the time the draft it opened closes. Focusing a detached
    // node does nothing at all, so the guard is what keeps this from LOOKING like it worked.
    // The opener here is raw DOM rather than a rendered node, because that is what it models: an
    // element React does not own and will not be holding a reference to when it disappears.
    it('does not try to focus an opener that has left the DOM', async () => {
      const transient = document.createElement('button')
      document.body.append(transient)
      render(<Gate triggerId={null} />)
      transient.focus()
      let id = ''
      await act(async () => {
        id = store().openDraft()
      })
      await screen.findByRole('dialog')
      transient.remove()
      await act(async () => {
        store().closeDraft(id)
      })
      expect(document.activeElement).toBe(document.body)
    })

    // Closing one of two drafts is not "the last draft closes": the host stays mounted and focus
    // belongs to whatever the composer does next, not to the trigger.
    it('leaves focus alone while another draft is still open', async () => {
      const { id } = await openFrom(NEW_MESSAGE_BTN_ID)
      await act(async () => {
        store().openDraft()
      })
      await act(async () => {
        store().closeDraft(id)
      })
      expect(document.activeElement).not.toBe(document.getElementById(NEW_MESSAGE_BTN_ID))
    })
  })
})
