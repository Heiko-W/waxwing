/**
 * The compose rich-text editor (M2.1, FR-CMP-01). A thin React wrapper over the {@link EditorEngine}
 * seam (Squire by default, a fake in tests): it owns the engine lifecycle, debounces edits into
 * `onChange(html)`, reflects the caret's active formats into the toolbar, and offers a per-message
 * plain-text-only mode (a `<textarea>` seeded from the generated plain-text alternative).
 *
 * BOTH surfaces emit through the SAME `onChange(html)` on the same debounce, and the plain-text
 * MODE is the owner's state (`plainText` + `onPlainTextToggle`), not this component's. The body is
 * html either way — the textarea's content is `plainTextToHtml(text)` — so exactly one field
 * carries the message and everything downstream (send, autosave, close, quoting) reads it.
 *
 * Controlled-ish: Squire owns the DOM, so we `setHTML` only on mount and when `value` changes to
 * something this editor did NOT emit (tracked via `lastEmittedRef`) — never on our own echo, which
 * would fight the cursor. The engine is created asynchronously (the default factory lazy-loads
 * Squire) and torn down on unmount / mode switch, clearing the debounce timer (no leaks).
 */

import {
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  type Ref,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Dialog, TextInput } from '../ui'
import type { AddFilesMode } from './attachment-upload'
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
import { canonicalizeInlineImages, resolveInlineImages } from './inline-images'

/** Imperative surface for the composer to drive inline-image insertion (M2.7) + a send-time flush (M2.8). */
export interface RichTextEditorHandle {
  /** Insert `<img src=objectUrl data-cid=cid alt=alt>` at the caret; false if the engine isn't ready. */
  insertInlineImage(objectUrl: string, cid: string, alt: string): boolean
  /** Emit the current body NOW, cancelling the pending debounce — so a send never drops the last keystrokes. */
  flush(): void
  focus(): void
}

/** Debounce between the last keystroke and an `onChange` — keeps typing off the parent's render path. */
const DEBOUNCE_MS = 200

/** getHTML → canonical body (inline `<img>` become `cid:`). Cheap no-op when no inline image is present. */
function toCanonicalHtml(html: string): string {
  return html.includes('data-cid') ? canonicalizeInlineImages(html) : html
}

/** canonical body → editor view (inline `cid:` become local objectURLs; unresolved ones are dropped). */
function forDisplayHtml(
  html: string,
  resolve: ((cid: string) => string | null) | undefined,
): string {
  return html.includes('cid:') ? resolveInlineImages(html, resolve ?? (() => null)) : html
}

export interface RichTextEditorProps {
  /** The message HTML (source of truth). */
  readonly value: string
  /** Debounced on every rich-text edit. */
  readonly onChange: (html: string) => void
  /**
   * Plain-text-only mode (FR-CMP-01) — CONTROLLED: this prop is the mode, and the toolbar button
   * only ASKS for a change via {@link onPlainTextToggle}. It used to be a mere starting value over
   * editor-local state, which meant the mode did not survive a remount and nothing outside this
   * component could know about it. Without an `onPlainTextToggle` the button is inert.
   */
  readonly plainText?: boolean | undefined
  /** The toolbar's plain-text button was pressed; the owner is expected to flip {@link plainText}. */
  readonly onPlainTextToggle?: ((plainText: boolean) => void) | undefined
  /** Accessible name for the editing surface. */
  readonly ariaLabel: string
  /** Injectable engine factory (defaults to the real Squire adapter; tests pass a fake). */
  readonly factory?: EditorFactory | undefined
  /** Imperative handle for inline-image insertion (M2.7). */
  readonly ref?: Ref<RichTextEditorHandle>
  /** Files pasted/dropped onto the editor (image → inline, other → attachment). */
  readonly onAddFiles?: ((files: File[], mode: AddFilesMode) => void) | undefined
  /** Resolve an inline `cid:` to a local preview objectURL (null → drop from the view). */
  readonly resolveInlineImage?: ((cid: string) => string | null) | undefined
}

export function RichTextEditor({
  value,
  onChange,
  plainText = false,
  onPlainTextToggle,
  ariaLabel,
  factory = defaultEditorFactory,
  ref,
  onAddFiles,
  resolveInlineImage,
}: RichTextEditorProps) {
  const mode = plainText ? 'plain' : 'rich'
  const [active, setActive] = useState<ActiveFormats>(NO_ACTIVE_FORMATS)
  const [ready, setReady] = useState(false)
  // `keepTypedWhitespace`: this seeds a TYPING surface, so indentation, aligned columns and blank
  // lines have to come back exactly as they were left (N-03). The mail alternative is the other
  // caller and wants the opposite.
  const [plainValue, setPlainValue] = useState(() =>
    plainText ? htmlToPlainText(value, { keepTypedWhitespace: true }) : '',
  )
  const [linkOpen, setLinkOpen] = useState(false)

  const rootRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<EditorEngine | null>(null)
  const htmlRef = useRef(value)
  const lastEmittedRef = useRef(value)
  const debounceRef = useRef<number | undefined>(undefined)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  // Read by the imperative `flush()`, which must stay identity-stable (it is a handle method).
  const plainValueRef = useRef(plainValue)
  plainValueRef.current = plainValue
  const plainModeRef = useRef(plainText)
  plainModeRef.current = plainText
  const resolveRef = useRef(resolveInlineImage)
  resolveRef.current = resolveInlineImage

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
      // Seed the editor with the DISPLAY form (cid: → objectURL); track the CANONICAL value so the
      // external-value effect below never re-sets our own echo (which would fight the cursor).
      created.setHTML(forDisplayHtml(htmlRef.current, resolveRef.current))
      lastEmittedRef.current = htmlRef.current
      const onInput = (): void => {
        if (debounceRef.current !== undefined) window.clearTimeout(debounceRef.current)
        debounceRef.current = window.setTimeout(() => {
          const html = toCanonicalHtml(created.getHTML())
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

  // Entering plain-text mode: seed the textarea from the body as it stands. Only on the TRANSITION —
  // the sync below owns every later change. Declared BEFORE it so it reads the html the toggle has
  // just emitted, not the `value` prop, which is one render behind whenever the owner re-renders
  // asynchronously.
  const wasPlainRef = useRef(plainText)
  useEffect(() => {
    if (plainText && !wasPlainRef.current)
      setPlainValue(htmlToPlainText(htmlRef.current, { keepTypedWhitespace: true }))
    wasPlainRef.current = plainText
  }, [plainText])

  /**
   * Push an EXTERNAL value change into whichever surface is live — never our own debounced echo, so
   * there is no cursor fight.
   *
   * The plain arm was missing, and the body is not only written by the editor: picking another
   * identity swaps the signature (`FromField`), the default identity seeds one when the identities
   * finally load, and "Insert template" appends to the body. In plain-text mode the textarea kept
   * its old text, so the change was invisible — and worse, the next keystroke (or the flush that
   * `send` performs) wrote that stale text back over it. The swap silently did not happen.
   *
   * NOT while our own debounce is armed: the typed text has not reached the owner yet, so `value`
   * cannot contain it, and re-seeding from it would delete what someone is in the middle of typing.
   * Text the user typed outranks a body change computed without it; the owner recomputes from the
   * fresh body a moment later.
   */
  useEffect(() => {
    htmlRef.current = value
    if (value === lastEmittedRef.current) return
    if (mode === 'rich') {
      if (engineRef.current === null) return
      engineRef.current.setHTML(forDisplayHtml(value, resolveRef.current))
      lastEmittedRef.current = value
      return
    }
    if (debounceRef.current !== undefined) return
    setPlainValue(htmlToPlainText(value, { keepTypedWhitespace: true }))
    lastEmittedRef.current = value
  }, [value, mode])

  /** Hand the body to the owner and remember it, so the value effect does not echo it back. */
  const emit = useCallback((html: string): void => {
    htmlRef.current = html
    lastEmittedRef.current = html
    onChangeRef.current(html)
  }, [])

  const runCommand = useCallback(
    (fn: (engine: EditorEngine) => void): void => {
      const engine = engineRef.current
      if (engine === null) return
      fn(engine)
      engine.focus()
      setActive(readActiveFormats(engine))
      emit(toCanonicalHtml(engine.getHTML()))
    },
    [emit],
  )

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

  // Inline-image insertion (M2.7): the upload hook drives this via the imperative handle; the
  // objectURL previews immediately, `data-cid` carries the future `cid:` reference (canonicalized
  // out on the next getHTML). Goes through runCommand so `lastEmittedRef` tracks the canonical body.
  const insertInlineImage = useCallback(
    (objectUrl: string, cid: string, alt: string): boolean => {
      if (engineRef.current === null) return false // not mounted yet — caller falls back to attach
      runCommand((engine) => engine.insertImage(objectUrl, { 'data-cid': cid, alt }))
      return true
    },
    [runCommand],
  )

  const flush = useCallback((): void => {
    if (debounceRef.current !== undefined) {
      window.clearTimeout(debounceRef.current)
      debounceRef.current = undefined
    }
    // The plain surface has no engine, and returning early on that was the whole defect: `send`
    // calls this to collect the last keystrokes, so in plain-text mode it collected the body from
    // BEFORE the switch — an empty signature, or a reply's bare quote, with the typed message gone.
    if (plainModeRef.current) {
      emit(plainTextToHtml(plainValueRef.current))
      return
    }
    const engine = engineRef.current
    if (engine === null) return
    emit(toCanonicalHtml(engine.getHTML()))
  }, [emit])

  useImperativeHandle(
    ref,
    () => ({ insertInlineImage, flush, focus: () => engineRef.current?.focus() }),
    [insertInlineImage, flush],
  )

  function splitByImage(files: File[]): { images: File[]; others: File[] } {
    return {
      images: files.filter((file) => file.type.startsWith('image/')),
      others: files.filter((file) => !file.type.startsWith('image/')),
    }
  }

  // Paste inlines an image (a screenshot) and attaches a file; a text/html paste falls through to
  // Squire. Drag & drop is owned by ComposerWindow (it routes an editor-targeted drop to inline).
  function onSurfacePaste(event: ClipboardEvent<HTMLDivElement>): void {
    if (onAddFiles === undefined) return
    const files = event.clipboardData?.files
    if (files === undefined || files.length === 0) return
    event.preventDefault()
    const { images, others } = splitByImage(Array.from(files))
    if (images.length > 0) onAddFiles(images, 'inline')
    if (others.length > 0) onAddFiles(others, 'attach')
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

  /**
   * Push whichever surface is live into the owner, then ASK it to switch (the mode is its state).
   *
   * The side effects used to sit inside a `setMode` updater — updaters run twice under StrictMode,
   * and emitting from one is a pattern that breaks the next time this component is touched.
   */
  const togglePlainText = (): void => {
    flush()
    onPlainTextToggle?.(mode !== 'plain')
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
            const text = event.target.value
            setPlainValue(text)
            // Into the SAME store field, on the SAME 200 ms debounce as a rich-text edit — the body
            // is html in both modes. Without this no keystroke typed here ever left the component:
            // send, autosave and close all read the body from before the switch (R-02).
            if (debounceRef.current !== undefined) window.clearTimeout(debounceRef.current)
            debounceRef.current = window.setTimeout(() => {
              debounceRef.current = undefined
              emit(plainTextToHtml(text))
            }, DEBOUNCE_MS)
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
            onPaste={onSurfacePaste}
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
