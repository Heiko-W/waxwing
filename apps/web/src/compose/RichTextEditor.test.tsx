import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { expectNoA11yViolations } from '../test/axe'
import type { EditorEngine, EditorFactory } from './editor-engine'
import { htmlToPlainText } from './html-to-text'
import { RichTextEditor } from './RichTextEditor'

/** A fake {@link EditorEngine} — jsdom has no real contenteditable/selection, so the wrapper is
 *  tested against this injected double (spies on the format commands, a manual event bus). */
interface FakeEngine extends EditorEngine {
  html: string
  destroyed: boolean
  readonly formats: Set<string>
  path: string
  emit(type: string): void
}

function createFakeEngine(): FakeEngine {
  const listeners = new Map<string, Array<(event: Event) => void>>()
  const fake: FakeEngine = {
    html: '',
    destroyed: false,
    formats: new Set<string>(),
    path: '',
    getHTML: () => fake.html,
    setHTML: (html) => {
      fake.html = html
    },
    focus: vi.fn(),
    destroy: () => {
      fake.destroyed = true
    },
    bold: vi.fn(),
    removeBold: vi.fn(),
    italic: vi.fn(),
    removeItalic: vi.fn(),
    underline: vi.fn(),
    removeUnderline: vi.fn(),
    makeUnorderedList: vi.fn(),
    makeOrderedList: vi.fn(),
    removeList: vi.fn(),
    increaseQuoteLevel: vi.fn(),
    decreaseQuoteLevel: vi.fn(),
    makeLink: vi.fn(),
    removeLink: vi.fn(),
    insertImage: vi.fn(),
    setFontSize: vi.fn(),
    hasFormat: (tag) => fake.formats.has(tag),
    getPath: () => fake.path,
    addEventListener: (type, handler) => {
      const arr = listeners.get(type) ?? []
      arr.push(handler)
      listeners.set(type, arr)
    },
    removeEventListener: (type, handler) => {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((fn) => fn !== handler),
      )
    },
    emit: (type) => {
      for (const handler of [...(listeners.get(type) ?? [])]) handler(new Event(type))
    },
  }
  return fake
}

function renderEditor(value = '<p>hi</p>', plainText = false) {
  const fake = createFakeEngine()
  const factory: EditorFactory = () => Promise.resolve(fake)
  const onChange = vi.fn()
  const view = render(
    <RichTextEditor
      value={value}
      onChange={onChange}
      plainText={plainText}
      ariaLabel="Message body"
      factory={factory}
    />,
  )
  return { fake, onChange, ...view }
}

/** Resolve once the async engine has mounted (its `setHTML(value)` ran). */
async function whenReady(fake: FakeEngine, value: string): Promise<void> {
  await waitFor(() => expect(fake.html).toBe(value))
}

describe('RichTextEditor', () => {
  it('loads the initial value into the engine once', async () => {
    const { fake } = renderEditor('<p>hi</p>')
    await whenReady(fake, '<p>hi</p>')
  })

  it('emits a debounced onChange when the engine reports input', async () => {
    const { fake, onChange } = renderEditor('<p>hi</p>')
    await whenReady(fake, '<p>hi</p>')
    fake.html = '<p>changed</p>'
    fake.emit('input')
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('<p>changed</p>'), { timeout: 2000 })
  })

  it('runs the matching engine command from a toolbar button', async () => {
    const user = userEvent.setup()
    const { fake } = renderEditor('<p>hi</p>')
    await whenReady(fake, '<p>hi</p>')
    await user.click(screen.getByRole('button', { name: 'Bold' }))
    expect(fake.bold).toHaveBeenCalled()
  })

  it('reflects active formats from pathChange in aria-pressed', async () => {
    const { fake } = renderEditor('<p>hi</p>')
    await whenReady(fake, '<p>hi</p>')
    const bold = screen.getByRole('button', { name: 'Bold' })
    expect(bold).toHaveAttribute('aria-pressed', 'false')
    fake.formats.add('B')
    fake.emit('pathChange')
    await waitFor(() => expect(bold).toHaveAttribute('aria-pressed', 'true'))
  })

  it('applies bold on ⌘/Ctrl+B in the editor surface', async () => {
    const user = userEvent.setup()
    const { fake } = renderEditor('<p>hi</p>')
    await whenReady(fake, '<p>hi</p>')
    screen.getByRole('textbox', { name: 'Message body' }).focus()
    await user.keyboard('{Control>}b{/Control}')
    expect(fake.bold).toHaveBeenCalled()
  })

  it('inserts a link through the link dialog', async () => {
    const user = userEvent.setup()
    const { fake } = renderEditor('<p>hi</p>')
    await whenReady(fake, '<p>hi</p>')
    await user.click(screen.getByRole('button', { name: 'Insert link' }))
    const dialog = await screen.findByRole('dialog', { name: 'Insert link' })
    await user.type(within(dialog).getByLabelText('Link URL'), 'https://x.test')
    await user.click(within(dialog).getByRole('button', { name: 'Insert' }))
    expect(fake.makeLink).toHaveBeenCalledWith('https://x.test')
  })

  it('moves toolbar focus with ArrowRight (roving tabindex)', async () => {
    const user = userEvent.setup()
    const { fake } = renderEditor('<p>hi</p>')
    await whenReady(fake, '<p>hi</p>')
    const bold = screen.getByRole('button', { name: 'Bold' })
    bold.focus()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('button', { name: 'Italic' })).toHaveFocus()
  })

  it('switches to a plain-text textarea seeded from the html', async () => {
    const user = userEvent.setup()
    const { fake } = renderEditor('<p>Hello</p><p>World</p>')
    await whenReady(fake, '<p>Hello</p><p>World</p>')
    await user.click(screen.getByRole('button', { name: 'Plain text' }))
    const textarea = screen.getByRole('textbox', { name: 'Message body' })
    expect(textarea.tagName).toBe('TEXTAREA')
    expect((textarea as HTMLTextAreaElement).value).toBe(
      htmlToPlainText('<p>Hello</p><p>World</p>'),
    )
  })

  it('destroys the engine on unmount', async () => {
    const { fake, unmount } = renderEditor('<p>hi</p>')
    await whenReady(fake, '<p>hi</p>')
    unmount()
    expect(fake.destroyed).toBe(true)
  })

  it('has no a11y violations', async () => {
    const { fake, container } = renderEditor('<p>hi</p>')
    await whenReady(fake, '<p>hi</p>')
    await expectNoA11yViolations(container)
  })
})
