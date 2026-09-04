import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef, useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { expectNoA11yViolations } from '../test/axe'
import type { EditorEngine, EditorFactory } from './editor-engine'
import { htmlToPlainText, plainTextToHtml } from './html-to-text'
import { RichTextEditor, type RichTextEditorHandle } from './RichTextEditor'

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

/**
 * The editor is CONTROLLED on `plainText` and on `value`: the toolbar button only asks for a mode
 * change and the surfaces only emit. This harness plays the owner (`ComposerWindow` in production)
 * so a test can watch what actually reaches the store, which is the thing that sends the mail.
 */
function renderEditor(value = '<p>hi</p>', plainText = false) {
  const fake = createFakeEngine()
  const factory: EditorFactory = () => Promise.resolve(fake)
  const onChange = vi.fn()
  const ref: { current: RichTextEditorHandle | null } = { current: null }
  function Owner() {
    const [body, setBody] = useState(value)
    const [plain, setPlain] = useState(plainText)
    return (
      <RichTextEditor
        ref={ref}
        value={body}
        onChange={(html) => {
          onChange(html)
          setBody(html)
        }}
        plainText={plain}
        onPlainTextToggle={setPlain}
        ariaLabel="Message body"
        factory={factory}
      />
    )
  }
  const view = render(<Owner />)
  return { fake, onChange, ref, ...view }
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

  it('flush() emits the current body immediately, ahead of the debounce (M2.8)', async () => {
    const fake = createFakeEngine()
    const factory: EditorFactory = () => Promise.resolve(fake)
    const onChange = vi.fn()
    const ref = createRef<RichTextEditorHandle>()
    render(
      <RichTextEditor
        ref={ref}
        value="<p>hi</p>"
        onChange={onChange}
        ariaLabel="Message body"
        factory={factory}
      />,
    )
    await whenReady(fake, '<p>hi</p>')
    // Squire has the new text but the 200 ms debounce has not emitted it yet.
    fake.html = '<p>hi there</p>'
    fake.emit('input')
    ref.current?.flush()
    expect(onChange).toHaveBeenCalledWith('<p>hi there</p>') // emitted synchronously by flush
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
      htmlToPlainText('<p>Hello</p><p>World</p>', { keepTypedWhitespace: true }),
    )
  })

  /**
   * N-03. The seed used to run through the MAIL-alternative rules, which collapse whitespace the way
   * HTML rendering does. Everything that put someone back on this surface — a mode switch, minimize
   * and restore, a reload — therefore flattened their indentation, their aligned columns and their
   * blank lines, silently and with no way back.
   */
  it('seeds the plain surface with the whitespace the writer typed', async () => {
    const user = userEvent.setup()
    const typed = 'def foo():\n    return 1\n\nGruß'
    const body = plainTextToHtml(typed)
    const { fake } = renderEditor(body)
    await whenReady(fake, body)

    await user.click(screen.getByRole('button', { name: 'Plain text' }))

    const textarea = screen.getByRole('textbox', { name: 'Message body' }) as HTMLTextAreaElement
    expect(textarea.value).toBe(typed)
  })

  /**
   * R-02: the plain-text surface was a dead end. It had local state and no way out — no debounced
   * emission, and `flush()` bailed on the missing engine — so "Plain text", type, Send sent the body
   * from BEFORE the switch (an empty signature, or a reply's bare quote) and the message was gone.
   */
  describe('plain-text mode reaches the owner', () => {
    async function typePlain(text: string): Promise<ReturnType<typeof renderEditor>> {
      const user = userEvent.setup()
      const view = renderEditor('<p>Hello</p>')
      await whenReady(view.fake, '<p>Hello</p>')
      await user.click(screen.getByRole('button', { name: 'Plain text' }))
      view.onChange.mockClear()
      await user.clear(screen.getByRole('textbox', { name: 'Message body' }))
      await user.type(screen.getByRole('textbox', { name: 'Message body' }), text)
      return view
    }

    it('emits every plain-text edit, debounced like a rich-text one', async () => {
      const { onChange } = await typePlain('typed in plain')
      await waitFor(() => expect(onChange).toHaveBeenCalledWith('<div>typed in plain</div>'), {
        timeout: 2000,
      })
    })

    it('flush() emits the typed text immediately — the send path', async () => {
      const { onChange, ref } = await typePlain('typed in plain')
      ref.current?.flush()
      expect(onChange).toHaveBeenCalledWith('<div>typed in plain</div>')
    })

    it('carries the typed text back into rich mode', async () => {
      const user = userEvent.setup()
      const { onChange } = await typePlain('typed in plain')
      onChange.mockClear()
      await user.click(screen.getByRole('button', { name: 'Rich text' }))
      expect(onChange).toHaveBeenCalledWith('<div>typed in plain</div>')
      expect(screen.getByRole('textbox', { name: 'Message body' }).tagName).not.toBe('TEXTAREA')
    })

    it('stays plain when the owner says so, and asks the owner to switch', async () => {
      const user = userEvent.setup()
      const onPlainTextToggle = vi.fn()
      const fake = createFakeEngine()
      render(
        <RichTextEditor
          value="<p>Hello</p>"
          onChange={vi.fn()}
          plainText
          onPlainTextToggle={onPlainTextToggle}
          ariaLabel="Message body"
          factory={() => Promise.resolve(fake)}
        />,
      )
      await user.click(screen.getByRole('button', { name: 'Rich text' }))
      expect(onPlainTextToggle).toHaveBeenCalledWith(false)
      // The owner did not flip it, so the surface must not flip either (controlled).
      expect(screen.getByRole('textbox', { name: 'Message body' }).tagName).toBe('TEXTAREA')
    })
  })

  /**
   * Nebenbefund 2. The body is not written by the editor alone: picking another identity swaps the
   * signature, the default identity seeds one when the identities finally load, and "Insert
   * template" appends to it. The plain surface ignored every one of those — the textarea kept its
   * old text, so the change was invisible, and the next keystroke (or `send`'s flush) wrote the
   * stale text back over it.
   */
  describe('plain-text mode follows an external body change', () => {
    function renderControlled(initial: string) {
      const fake = createFakeEngine()
      const onChange = vi.fn()
      const ref: { current: RichTextEditorHandle | null } = { current: null }
      let external: (html: string) => void = () => undefined
      function Owner() {
        const [body, setBody] = useState(initial)
        external = setBody
        return (
          <RichTextEditor
            ref={ref}
            value={body}
            onChange={(html) => {
              onChange(html)
              setBody(html)
            }}
            plainText
            onPlainTextToggle={() => undefined}
            ariaLabel="Message body"
            factory={() => Promise.resolve(fake)}
          />
        )
      }
      render(<Owner />)
      const textarea = (): HTMLTextAreaElement =>
        screen.getByRole('textbox', { name: 'Message body' }) as HTMLTextAreaElement
      return {
        onChange,
        ref,
        textarea,
        setBodyExternally: (html: string) => {
          act(() => external(html))
        },
      }
    }

    it('shows the swapped signature, and flushes THAT rather than the stale text', () => {
      const swapped = 'Hallo\n\nViele Grüße\nNeue Signatur'
      const { setBodyExternally, textarea, ref, onChange } = renderControlled(
        plainTextToHtml('Hallo'),
      )
      expect(textarea().value).toBe('Hallo')

      setBodyExternally(plainTextToHtml(swapped))

      expect(textarea().value).toBe(swapped)
      ref.current?.flush()
      expect(onChange).toHaveBeenLastCalledWith(plainTextToHtml(swapped))
    })

    it('never overwrites text that is still being typed', async () => {
      const { setBodyExternally, textarea, onChange } = renderControlled(plainTextToHtml('Hallo'))

      // A keystroke arms the 200 ms debounce, so the owner does not have this text yet …
      fireEvent.change(textarea(), { target: { value: 'Hallo!' } })
      // … and an external change computed WITHOUT it must not be allowed to delete it.
      setBodyExternally(plainTextToHtml('Hallo\n\nSignatur'))

      expect(textarea().value).toBe('Hallo!')
      await waitFor(() => expect(onChange).toHaveBeenCalledWith(plainTextToHtml('Hallo!')), {
        timeout: 2000,
      })
    })
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
