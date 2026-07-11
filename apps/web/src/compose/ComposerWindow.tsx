/**
 * One draft window (M2.2). Renders the window chrome (subject summary + minimize / full-screen /
 * close), the subject field and the {@link RichTextEditor}. Docked and minimized windows are
 * NON-modal (`aria-modal="false"`) so several coexist and the mail UI stays interactive; the
 * full-screen window is MODAL (focus trap + body-scroll-lock + backdrop).
 *
 * Escape de-escalates one reversible step (owner-directed, Apple-Mail-aligned) and never loses data
 * because the draft is autosaved (M2.6): full screen → docked, docked → minimized. The editor's link
 * sub-dialog and the discard confirm own their Escape first via the ui dismiss stack. Close SAVES the
 * draft to the Drafts folder and closes the window (Apple ⌘W); Discard deletes it (an empty draft
 * discards silently, a non-empty one asks first).
 */

import { Maximize2, Minimize2, Minus, Paperclip, Trash2, X } from 'lucide-react'
import {
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import type { LayoutTier } from '../app/shell/layout'
import { Button, Dialog, IconButton, TextInput, useFocusTrap } from '../ui'
import { AttachmentChips } from './AttachmentChips'
import type { BlobUploader } from './attachment-upload'
import styles from './composer.module.css'
import { type DraftWindow, useComposerStore } from './composer-store'
import { isEmptyDraft } from './draft-email'
import type { EditorFactory } from './editor-engine'
import { FromField } from './FromField'
import { getInlineObjectUrl } from './inline-image-registry'
import { RecipientFields } from './RecipientFields'
import { RichTextEditor, type RichTextEditorHandle } from './RichTextEditor'
import type { RecipientSuggestionSource } from './recipient-suggestions'
import { useAttachmentUpload } from './use-attachment-upload'
import { useDraftSync } from './use-draft-sync'

export interface ComposerWindowProps {
  readonly draft: DraftWindow
  readonly tier: LayoutTier
  /** Injectable editor factory (tests pass a fake; production uses the real Squire adapter). */
  readonly editorFactory?: EditorFactory | undefined
  /** Injectable recipient-suggestion source (tests pass a fake; production uses the recents source). */
  readonly recipientSuggestions?: RecipientSuggestionSource | undefined
  /** Injectable blob uploader (tests pass a fake; production builds one from the session). */
  readonly uploader?: BlobUploader | undefined
}

export function ComposerWindow({
  draft,
  tier,
  editorFactory,
  recipientSuggestions,
  uploader,
}: ComposerWindowProps) {
  const { t } = useTranslation()
  const setMode = useComposerStore((state) => state.setMode)
  const updateBody = useComposerStore((state) => state.updateBody)
  const updateSubject = useComposerStore((state) => state.updateSubject)
  const focusDraft = useComposerStore((state) => state.focusDraft)
  const draftSync = useDraftSync()

  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const windowRef = useRef<HTMLDivElement>(null)
  const subjectRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const editorRef = useRef<RichTextEditorHandle>(null)
  const focusedOnce = useRef(false)
  const titleId = useId()

  const insertInlineImage = useCallback(
    (url: string, cid: string, alt: string): boolean =>
      editorRef.current?.insertInlineImage(url, cid, alt) ?? false,
    [],
  )
  const attachments = useAttachmentUpload(draft.id, {
    insertInlineImage,
    ...(uploader ? { uploader } : {}),
  })
  const subjectId = useId()

  const fullscreen = tier === 'phone' || draft.mode === 'expanded'
  const minimized = draft.mode === 'minimized' && tier !== 'phone'

  // Full-screen = modal: trap focus (initial = subject) and lock body scroll (mirrors ui/Dialog).
  useFocusTrap(fullscreen, windowRef, { initialFocusRef: subjectRef })
  useEffect(() => {
    if (!fullscreen) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [fullscreen])

  // Focus the subject once when a docked window first appears (the modal trap owns modal focus).
  useEffect(() => {
    if (focusedOnce.current || fullscreen || minimized) return
    focusedOnce.current = true
    subjectRef.current?.focus()
  }, [fullscreen, minimized])

  // Close = save to Drafts, then close (Apple ⌘W). Discard = delete; only a non-empty draft asks first.
  const requestClose = (): void => {
    void draftSync.close(draft.id)
  }
  const requestDiscard = (): void => {
    if (isEmptyDraft(draft)) void draftSync.discard(draft.id)
    else setConfirmDiscard(true)
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'Escape') return
    event.preventDefault()
    setMode(draft.id, fullscreen ? 'docked' : 'minimized')
  }

  // Attach: the paperclip opens the file picker; the picked files become attachments.
  function onPickFiles(event: ChangeEvent<HTMLInputElement>): void {
    const files = event.target.files
    if (files !== null && files.length > 0) attachments.addFiles(Array.from(files), 'attach')
    event.target.value = '' // let the same file be picked again later
  }

  // Drag & drop is owned here: a drop onto the editor surface inlines images (Apple Mail); a drop
  // anywhere else in the window attaches. The overlay hint shows only while files hover the window.
  function onWindowDragOver(event: DragEvent<HTMLDivElement>): void {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault() // never let the browser navigate to / natively insert a dropped file
    if (attachments.canUpload) setDragActive(true)
  }
  function onWindowDragLeave(event: DragEvent<HTMLDivElement>): void {
    if (!windowRef.current?.contains(event.relatedTarget as Node | null)) setDragActive(false)
  }
  function onWindowDrop(event: DragEvent<HTMLDivElement>): void {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    setDragActive(false)
    if (!attachments.canUpload) return
    const files = Array.from(event.dataTransfer.files)
    if (files.length === 0) return
    const inEditor =
      event.target instanceof Element && event.target.closest('[role="textbox"]') !== null
    if (inEditor) {
      const images = files.filter((file) => file.type.startsWith('image/'))
      const others = files.filter((file) => !file.type.startsWith('image/'))
      if (images.length > 0) attachments.addFiles(images, 'inline')
      if (others.length > 0) attachments.addFiles(others, 'attach')
    } else {
      attachments.addFiles(files, 'attach')
    }
  }

  if (minimized) {
    return (
      <button
        type="button"
        className={styles.chip}
        onClick={() => {
          setMode(draft.id, 'docked')
          focusDraft(draft.id)
        }}
      >
        <span className={styles.chipTitle}>{draft.subject || t('compose.noSubject')}</span>
      </button>
    )
  }

  const windowClass = [styles.window, fullscreen ? styles.fullscreen : styles.docked].join(' ')

  return (
    <>
      {fullscreen && <div className={styles.backdrop} />}
      {/* A compose window is an ARIA dialog — modal in full screen, non-modal when docked; the
          native <dialog> element cannot express the non-modal, coexisting-windows case. */}
      <div
        ref={windowRef}
        className={windowClass}
        role="dialog"
        aria-modal={fullscreen}
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onMouseDownCapture={() => focusDraft(draft.id)}
        onDragOver={onWindowDragOver}
        onDragLeave={onWindowDragLeave}
        onDrop={onWindowDrop}
      >
        {dragActive && (
          <div className={styles.dropOverlay} aria-hidden="true">
            {t('compose.dropHint')}
          </div>
        )}
        <div className={styles.titleBar}>
          <span id={titleId} className={styles.title}>
            {draft.subject || t('compose.noSubject')}
          </span>
          <div className={styles.titleActions}>
            <IconButton
              label={t('compose.attach')}
              variant="ghost"
              size="sm"
              disabled={!attachments.canUpload}
              onClick={() => fileInputRef.current?.click()}
            >
              <Paperclip />
            </IconButton>
            <IconButton
              label={t('compose.discard')}
              variant="ghost"
              size="sm"
              onClick={requestDiscard}
            >
              <Trash2 />
            </IconButton>
            <IconButton
              label={t('compose.minimize')}
              variant="ghost"
              size="sm"
              onClick={() => setMode(draft.id, 'minimized')}
            >
              <Minus />
            </IconButton>
            <IconButton
              label={fullscreen ? t('compose.restore') : t('compose.expand')}
              variant="ghost"
              size="sm"
              aria-pressed={fullscreen}
              onClick={() => setMode(draft.id, fullscreen ? 'docked' : 'expanded')}
            >
              {fullscreen ? <Minimize2 /> : <Maximize2 />}
            </IconButton>
            <IconButton label={t('compose.close')} variant="ghost" size="sm" onClick={requestClose}>
              <X />
            </IconButton>
          </div>
        </div>

        <FromField draft={draft} />

        <RecipientFields
          draft={draft}
          {...(recipientSuggestions ? { suggestionSource: recipientSuggestions } : {})}
        />

        <div className={styles.field}>
          <label className={styles.subjectLabel} htmlFor={subjectId}>
            {t('compose.subjectLabel')}
          </label>
          <TextInput
            ref={subjectRef}
            id={subjectId}
            value={draft.subject}
            placeholder={t('compose.subjectPlaceholder')}
            onChange={(event) => updateSubject(draft.id, event.target.value)}
          />
        </div>

        <AttachmentChips draftId={draft.id} controller={attachments} />

        <div className={styles.editorWrap}>
          <RichTextEditor
            ref={editorRef}
            value={draft.body}
            onChange={(html) => updateBody(draft.id, html)}
            ariaLabel={t('compose.editorLabel')}
            resolveInlineImage={getInlineObjectUrl}
            {...(attachments.canUpload ? { onAddFiles: attachments.addFiles } : {})}
            {...(editorFactory ? { factory: editorFactory } : {})}
          />
        </div>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          className={styles.hiddenFileInput}
          tabIndex={-1}
          aria-hidden="true"
          onChange={onPickFiles}
        />
      </div>

      {confirmDiscard && (
        <Dialog
          open
          onClose={() => setConfirmDiscard(false)}
          title={t('compose.discardTitle')}
          size="sm"
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirmDiscard(false)}>
                {t('compose.discardCancel')}
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  setConfirmDiscard(false)
                  void draftSync.discard(draft.id)
                }}
              >
                {t('compose.discardConfirm')}
              </Button>
            </>
          }
        >
          <p>{t('compose.discardBody')}</p>
        </Dialog>
      )}
    </>
  )
}
