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

import { Maximize2, Minimize2, Minus, Trash2, X } from 'lucide-react'
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { LayoutTier } from '../app/shell/layout'
import { Button, Dialog, IconButton, TextInput, useFocusTrap } from '../ui'
import styles from './composer.module.css'
import { type DraftWindow, useComposerStore } from './composer-store'
import { isEmptyDraft } from './draft-email'
import type { EditorFactory } from './editor-engine'
import { FromField } from './FromField'
import { RecipientFields } from './RecipientFields'
import { RichTextEditor } from './RichTextEditor'
import type { RecipientSuggestionSource } from './recipient-suggestions'
import { useDraftSync } from './use-draft-sync'

export interface ComposerWindowProps {
  readonly draft: DraftWindow
  readonly tier: LayoutTier
  /** Injectable editor factory (tests pass a fake; production uses the real Squire adapter). */
  readonly editorFactory?: EditorFactory | undefined
  /** Injectable recipient-suggestion source (tests pass a fake; production uses the recents source). */
  readonly recipientSuggestions?: RecipientSuggestionSource | undefined
}

export function ComposerWindow({
  draft,
  tier,
  editorFactory,
  recipientSuggestions,
}: ComposerWindowProps) {
  const { t } = useTranslation()
  const setMode = useComposerStore((state) => state.setMode)
  const updateBody = useComposerStore((state) => state.updateBody)
  const updateSubject = useComposerStore((state) => state.updateSubject)
  const focusDraft = useComposerStore((state) => state.focusDraft)
  const draftSync = useDraftSync()

  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const windowRef = useRef<HTMLDivElement>(null)
  const subjectRef = useRef<HTMLInputElement>(null)
  const focusedOnce = useRef(false)
  const titleId = useId()
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
      >
        <div className={styles.titleBar}>
          <span id={titleId} className={styles.title}>
            {draft.subject || t('compose.noSubject')}
          </span>
          <div className={styles.titleActions}>
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

        <div className={styles.editorWrap}>
          <RichTextEditor
            value={draft.body}
            onChange={(html) => updateBody(draft.id, html)}
            ariaLabel={t('compose.editorLabel')}
            {...(editorFactory ? { factory: editorFactory } : {})}
          />
        </div>
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
