import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LayoutTier } from '../app/shell/layout'
import { expectNoA11yViolations } from '../test/axe'
import { ToastProvider } from '../ui'
import { ComposerWindow } from './ComposerWindow'
import { type DraftMode, useComposerStore } from './composer-store'
import type { EditorEngine, EditorFactory } from './editor-engine'

/** Minimal fake {@link EditorEngine} — jsdom has no real contenteditable; the window only needs
 *  the surface to mount, so every command is a no-op and no events fire. Stable factory reference. */
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

/** Subscribes to the live draft so store mutations (mode/subject) re-render the window (the host
 *  does this in production). */
function Harness({ id, tier = 'desktop' }: { id: string; tier?: LayoutTier }) {
  const draft = useComposerStore((state) => state.drafts.get(id))
  if (draft === undefined) return null
  return (
    <ToastProvider>
      <ComposerWindow draft={draft} tier={tier} editorFactory={factory} />
    </ToastProvider>
  )
}

const store = () => useComposerStore.getState()

function openWindow(mode: DraftMode = 'docked', tier: LayoutTier = 'desktop') {
  const id = store().openDraft({ mode })
  render(<Harness id={id} tier={tier} />)
  return id
}

beforeEach(() => useComposerStore.setState({ drafts: new Map(), focusedId: undefined }))
afterEach(() => useComposerStore.setState({ drafts: new Map(), focusedId: undefined }))

describe('ComposerWindow', () => {
  it('renders a non-modal dialog with the editor surface when docked', async () => {
    openWindow('docked')
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'false')
    expect(await within(dialog).findByRole('textbox', { name: 'Message body' })).toBeInTheDocument()
  })

  it('shows a read-only recipients summary for a reply draft', async () => {
    const id = store().openDraft({
      to: [{ name: 'Alice', email: 'alice@x.test' }],
      cc: [{ name: null, email: 'c@x.test' }],
    })
    render(<Harness id={id} />)
    expect(await screen.findByText(/To: Alice/)).toBeInTheDocument()
    expect(screen.getByText(/Cc: c@x.test/)).toBeInTheDocument()
  })

  it('shows no recipients summary for a blank draft', async () => {
    openWindow('docked') // openDraft() with no to/cc
    await screen.findByRole('dialog')
    expect(screen.queryByText(/^To:/)).toBeNull()
  })

  it('edits the subject through the store', async () => {
    const id = openWindow('docked')
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Subject'), 'Hello')
    expect(store().drafts.get(id)?.subject).toBe('Hello')
    expect(store().drafts.get(id)?.dirty).toBe(true)
  })

  it('toggles full-screen modal via the expand button', async () => {
    const id = openWindow('docked')
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Full screen' }))
    expect(store().drafts.get(id)?.mode).toBe('expanded')
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true'))
  })

  it('confirms before discarding a dirty draft; Esc does not close a docked window', async () => {
    const id = openWindow('docked')
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Subject'), 'x') // make it dirty
    // Esc on a docked window is harmless — the draft stays.
    await user.keyboard('{Escape}')
    expect(store().drafts.has(id)).toBe(true)
    // Close asks first, then discards.
    await user.click(screen.getByRole('button', { name: 'Close' }))
    const confirm = await screen.findByRole('dialog', { name: 'Discard this draft?' })
    await user.click(within(confirm).getByRole('button', { name: 'Discard' }))
    expect(store().drafts.has(id)).toBe(false)
  })

  it('has no a11y violations', async () => {
    openWindow('docked')
    await screen.findByRole('textbox', { name: 'Message body' })
    await expectNoA11yViolations(document.body)
  })
})
