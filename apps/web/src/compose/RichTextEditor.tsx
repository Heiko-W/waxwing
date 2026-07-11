/**
 * The compose rich-text editor (M2.1, FR-CMP-01). A thin React wrapper over the {@link EditorEngine}
 * seam (Squire by default, a fake in tests): it owns the engine lifecycle, debounces edits into
 * `onChange(html)`, reflects the caret's active formats into the toolbar, and offers a per-message
 * plain-text-only mode (a `<textarea>` seeded from the generated plain-text alternative).
 *
 * Controlled-ish: Squire owns the DOM, so we `setHTML` only on mount and when `value` changes to
 * something this editor did NOT emit (tracked via `lastEmittedRef`) — never on our own echo, which
 * would fight the cursor. The engine is created asynchronously (the default factory lazy-loads
 * Squire) and torn down on unmount / mode switch, clearing the debounce timer (no leaks).
 */

import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Dialog, TextInput } from '../ui'
import { EditorToolbar, type ToolbarCommands } from './EditorToolbar'
import styles from './editor.module.css'
import {
  type ActiveFormats,
  defaultEditorFactory,
  type EditorEngine,
  type EditorFactory,
  NO_ACTIVE_FORMATS,
  readActiveFormats,
} from './editor-engine'
import { htmlToPlainText, plainTextToHtml } from './html-to-text'

/** Debounce between the last keystroke and an `onChange` — keeps typing off the parent's render path. */
const DEBOUNCE_MS = 200

export interface RichTextEditorProps {
  /** The message HTML (source of truth). */
  readonly value: string
  /** Debounced on every rich-text edit. */
  readonly onChange: (html: string) => void
  /** Start in plain-text-only mode. */
  readonly plainText?: boolean | undefined
  /** Called on every plain-text edit while in plain-text mode. */
  readonly onPlainTextChange?: ((text: string) => void) | undefined
  /** Accessible name for the editing surface. */
  readonly ariaLabel: string
  /** Injectable engine factory (defaults to the real Squire adapter; tests pass a fake). */
  readonly factory?: EditorFactory | undefined
}

export function RichTextEditor({
  value,
  onChange,
  plainText = false,
  onPlainTextChange,
  ariaLabel,
  factory = defaultEditorFactory,
}: RichTextEditorProps) {
  const [mode, setMode] = useState<'rich' | 'plain'>(plainText ? 'plain' : 'rich')
  const [active, setActive] = useState<ActiveFormats>(NO_ACTIVE_FORMATS)
  const [ready, setReady] = useState(false)
  const [plainValue, setPlainValue] = useState(() => (plainText ? htmlToPlainText(value) : ''))
  const [linkOpen, setLinkOpen] = useState(false)

  const rootRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<EditorEngine | null>(null)
  const htmlRef = useRef(value)
  const lastEmittedRef = useRef(value)
  const debounceRef = useRef<number | undefined>(undefined)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  // Create / tear down the Squire engine while in rich mode.
  useEffect(() => {
    if (mode !== 'rich') return
    const root = rootRef.current
    if (root === null) return
    let cancelled = false
    let engine: EditorEngine | null = null
    let removeListeners: (() => void) | undefined
    setReady(false)
    void factory(root).then((created) => {
      if (cancelled) {
        created.destroy()
        return
      }
      engine = created
      engineRef.current = created
      created.setHTML(htmlRef.current)
      lastEmittedRef.current = htmlRef.current
      const onInput = (): void => {
        if (debounceRef.current !== undefined) window.clearTimeout(debounceRef.current)
        debounceRef.current = window.setTimeout(() => {
          const html = created.getHTML()
          htmlRef.current = html
          lastEmittedRef.current = html
          onChangeRef.current(html)
        }, DEBOUNCE_MS)
      }
      const onPath = (): void => setActive(readActiveFormats(created))
      created.addEventListener('input', onInput)
      created.addEventListener('pathChange', onPath)
      removeListeners = () => {
        created.removeEventListener('input', onInput)
        created.removeEventListener('pathChange', onPath)
      }
      setActive(readActiveFormats(created))
      setReady(true)
    })
    return () => {
      cancelled = true
      if (debounceRef.current !== undefined) window.clearTimeout(debounceRef.current)
      removeListeners?.()
      engine?.destroy()
      if (engineRef.current === engine) engineRef.current = null
    }
  }, [mode, factory])

  // Push an EXTERNAL value change into the engine (never our own debounced echo → no cursor fight).
  useEffect(() => {
    htmlRef.current = value
    if (mode === 'rich' && engineRef.current !== null && value !== lastEmittedRef.current) {
      engineRef.current.setHTML(value)
      lastEmittedRef.current = value
    }
  }, [value, mode])

  const runCommand = useCallback((fn: (engine: EditorEngine) => void): void => {
    const engine = engineRef.current
    if (engine === null) return
    fn(engine)
    engine.focus()
    setActive(readActiveFormats(engine))
    const html = engine.getHTML()
    htmlRef.current = html
    lastEmittedRef.current = html
    onChangeRef.current(html)
  }, [])

  const commands: ToolbarCommands = {
    toggleBold: () => runCommand((engine) => (active.bold ? engine.removeBold() : engine.bold())),
    toggleItalic: () =>
      runCommand((engine) => (active.italic ? engine.removeItalic() : engine.italic())),
    toggleUnderline: () =>
      runCommand((engine) => (active.underline ? engine.removeUnderline() : engine.underline())),
    toggleUnorderedList: () =>
      runCommand((engine) =>
        active.unorderedList ? engine.removeList() : engine.makeUnorderedList(),
      ),
    toggleOrderedList: () =>
      runCommand((engine) => (active.orderedList ? engine.removeList() : engine.makeOrderedList())),
    toggleQuote: () =>
      runCommand((engine) =>
        active.quote ? engine.decreaseQuoteLevel() : engine.increaseQuoteLevel(),
      ),
    removeLink: () => runCommand((engine) => engine.removeLink()),
  }

  const insertLink = (url: string): void => {
    runCommand((engine) => engine.makeLink(url))
    setLinkOpen(false)
  }

  function onSurfaceKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return
    switch (event.key.toLowerCase()) {
      case 'b':
        event.preventDefault()
        commands.toggleBold()
        break
      case 'i':
        event.preventDefault()
        commands.toggleItalic()
        break
      case 'u':
        event.preventDefault()
        commands.toggleUnderline()
        break
      case 'k':
        event.preventDefault()
        if (active.link) commands.removeLink()
        else setLinkOpen(true)
        break
      default:
        break
    }
  }

  const togglePlainText = (): void => {
    setMode((current) => {
      if (current === 'rich') {
        const html = engineRef.current?.getHTML() ?? htmlRef.current
        htmlRef.current = html
        setPlainValue(htmlToPlainText(html))
        return 'plain'
      }
      const html = plainTextToHtml(plainValue)
      htmlRef.current = html
      lastEmittedRef.current = html
      onChangeRef.current(html)
      return 'rich'
    })
  }

  return (
    <div className={styles.editor}>
      <EditorToolbar
        active={active}
        plainText={mode === 'plain'}
        busy={mode === 'rich' && !ready}
        commands={commands}
        onRequestLink={() => setLinkOpen(true)}
        onTogglePlainText={togglePlainText}
      />
      {mode === 'plain' ? (
        <textarea
          className={styles.plain}
          aria-label={ariaLabel}
          value={plainValue}
          onChange={(event) => {
            setPlainValue(event.target.value)
            onPlainTextChange?.(event.target.value)
          }}
        />
      ) : (
        <>
          {/* biome-ignore lint/a11y/useSemanticElements: Squire needs a contenteditable div; role="textbox" is the correct mapping. */}
          <div
            ref={rootRef}
            className={styles.surface}
            role="textbox"
            aria-multiline="true"
            aria-label={ariaLabel}
            tabIndex={0}
            onKeyDown={onSurfaceKeyDown}
          />
        </>
      )}
      {linkOpen && <LinkDialog onCancel={() => setLinkOpen(false)} onInsert={insertLink} />}
    </div>
  )
}

/** Small modal for entering a link URL (owned here so ⌘K and the toolbar button share it). */
function LinkDialog({
  onCancel,
  onInsert,
}: {
  readonly onCancel: () => void
  readonly onInsert: (url: string) => void
}) {
  const { t } = useTranslation()
  const [url, setUrl] = useState('')
  const inputId = useId()

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const trimmed = url.trim()
    if (trimmed !== '') onInsert(trimmed)
  }

  return (
    <Dialog open onClose={onCancel} title={t('compose.linkTitle')} size="sm">
      <form className={styles.linkForm} onSubmit={onSubmit}>
        <label className={styles.linkLabel} htmlFor={inputId}>
          {t('compose.linkUrlLabel')}
        </label>
        <TextInput
          id={inputId}
          type="url"
          inputMode="url"
          autoComplete="off"
          placeholder={t('compose.linkUrlPlaceholder')}
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
        <div className={styles.linkActions}>
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t('compose.linkCancel')}
          </Button>
          <Button type="submit" variant="primary" disabled={url.trim() === ''}>
            {t('compose.linkInsert')}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
