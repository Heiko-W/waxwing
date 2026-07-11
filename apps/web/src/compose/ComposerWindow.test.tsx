import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LayoutTier } from '../app/shell/layout'
import { expectNoA11yViolations } from '../test/axe'
import { ToastProvider } from '../ui'
import type { BlobUploader } from './attachment-upload'
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
    insertImage: noop,
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
function Harness({
  id,
  tier = 'desktop',
  uploader,
}: {
  id: string
  tier?: LayoutTier
  uploader?: BlobUploader
}) {
  const draft = useComposerStore((state) => state.drafts.get(id))
  if (draft === undefined) return null
  return (
    <ToastProvider>
      <ComposerWindow
        draft={draft}
        tier={tier}
        editorFactory={factory}
        {...(uploader ? { uploader } : {})}
      />
    </ToastProvider>
  )
}

const store = () => useComposerStore.getState()

function openWindow(mode: DraftMode = 'docked', tier: LayoutTier = 'desktop') {
  const id = store().openDraft({ mode })
  render(<Harness id={id} tier={tier} />)
  return id
}

const reset = () =>
  useComposerStore.setState({ drafts: new Map(), focusedId: undefined, uploads: new Map() })
beforeEach(reset)
afterEach(reset)

const fileInput = (): HTMLInputElement =>
  document.querySelector('input[type="file"]') as HTMLInputElement

describe('ComposerWindow', () => {
  it('renders a non-modal dialog with the editor surface when docked', async () => {
    openWindow('docked')
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'false')
    expect(await within(dialog).findByRole('textbox', { name: 'Message body' })).toBeInTheDocument()
  })

  it('renders recipient pills for a reply draft (Cc auto-shown)', async () => {
    const id = store().openDraft({
      to: [{ name: 'Alice', email: 'alice@x.test' }],
      cc: [{ name: null, email: 'c@x.test' }],
    })
    render(<Harness id={id} />)
    expect(await screen.findByText('Alice')).toBeInTheDocument()
    expect(screen.getByText('c@x.test')).toBeInTheDocument()
  })

  it('adds a typed recipient to the To field', async () => {
    const id = openWindow('docked')
    const to = screen.getAllByRole('combobox')[0] as HTMLElement
    await userEvent.setup().type(to, 'x@y.test{Enter}')
    expect(store().drafts.get(id)?.to).toEqual([{ name: null, email: 'x@y.test' }])
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

  it('Esc minimizes a docked window rather than closing it (no data loss)', async () => {
    const id = openWindow('docked')
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Subject'), 'x')
    await user.keyboard('{Escape}')
    expect(store().drafts.get(id)?.mode).toBe('minimized')
  })

  it('Close saves the draft and closes the window without asking', async () => {
    const id = openWindow('docked')
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Subject'), 'x')
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog', { name: 'Discard this draft?' })).not.toBeInTheDocument()
    expect(store().drafts.has(id)).toBe(false)
  })

  it('Discard asks before deleting a non-empty draft', async () => {
    const id = openWindow('docked')
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Subject'), 'x')
    await user.click(screen.getByRole('button', { name: 'Discard draft' }))
    const confirm = await screen.findByRole('dialog', { name: 'Discard this draft?' })
    await user.click(within(confirm).getByRole('button', { name: 'Discard' }))
    expect(store().drafts.has(id)).toBe(false)
  })

  it('has no a11y violations', async () => {
    openWindow('docked')
    await screen.findByRole('textbox', { name: 'Message body' })
    await expectNoA11yViolations(document.body)
  })

  // ── Attachments (M2.7) ───────────────────────────────────────────────────────────────────────
  const okUploader: BlobUploader = async (file) => ({
    blobId: 'b1',
    type: (file as File).type,
    size: (file as File).size,
  })

  function renderWithUploader(uploader: BlobUploader) {
    const id = store().openDraft()
    render(<Harness id={id} uploader={uploader} />)
    return id
  }

  it('attaches a file picked from the file dialog and shows a chip', async () => {
    const id = renderWithUploader(okUploader)
    await screen.findByRole('textbox', { name: 'Message body' })
    fireEvent.change(fileInput(), {
      target: { files: [new File([new Uint8Array(10)], 'doc.pdf', { type: 'application/pdf' })] },
    })
    await waitFor(() => expect(store().drafts.get(id)?.attachments).toHaveLength(1))
    expect(screen.getByText('doc.pdf')).toBeInTheDocument()
  })

  it('removes an attached file', async () => {
    const id = renderWithUploader(okUploader)
    await screen.findByRole('textbox', { name: 'Message body' })
    fireEvent.change(fileInput(), {
      target: { files: [new File([new Uint8Array(4)], 'doc.pdf', { type: 'application/pdf' })] },
    })
    await waitFor(() => expect(store().drafts.get(id)?.attachments).toHaveLength(1))
    await userEvent.setup().click(screen.getByRole('button', { name: 'Remove doc.pdf' }))
    await waitFor(() => expect(store().drafts.get(id)?.attachments ?? []).toHaveLength(0))
  })

  it('attaches a file dropped on the window', async () => {
    const id = renderWithUploader(okUploader)
    const dialog = await screen.findByRole('dialog')
    fireEvent.drop(dialog, {
      dataTransfer: {
        files: [new File([new Uint8Array(3)], 'drop.txt', { type: 'text/plain' })],
        types: ['Files'],
      },
    })
    await waitFor(() => expect(store().drafts.get(id)?.attachments).toHaveLength(1))
    expect(screen.getByText('drop.txt')).toBeInTheDocument()
  })

  it('offers a Retry action when an upload fails', async () => {
    renderWithUploader(async () => {
      throw new Error('boom')
    })
    await screen.findByRole('textbox', { name: 'Message body' })
    fileInput() // ensure the input exists
    fireEvent.change(fileInput(), {
      target: { files: [new File([new Uint8Array(2)], 'x.png', { type: 'image/png' })] },
    })
    expect(await screen.findByRole('button', { name: 'Retry x.png' })).toBeInTheDocument()
  })
})
