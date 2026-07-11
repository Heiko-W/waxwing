/**
 * One draft window (M2.2). Renders the window chrome (subject summary + minimize / full-screen /
 * close), the subject field and the {@link RichTextEditor}. Docked and minimized windows are
 * NON-modal (`aria-modal="false"`) so several coexist and the mail UI stays interactive; the
 * full-screen window is MODAL (focus trap + body-scroll-lock + backdrop).
 *
 * Escape is deliberately harmless (owner-directed, Apple-Mail-aligned): on the full-screen window
 * it collapses back to docked (reversible, no data loss); on a docked window it does nothing (the
 * editor's link sub-dialog handles its own Escape first via the ui dismiss stack). Close is an
 * explicit button; a dirty draft asks before discarding (a stub until M2.6 autosaves to Drafts).
 */

import { Maximize2, Minimize2, Minus, X } from 'lucide-react'
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { LayoutTier } from '../app/shell/layout'
import { Button, Dialog, IconButton, TextInput, useFocusTrap } from '../ui'
import styles from './composer.module.css'
import { type DraftWindow, useComposerStore } from './composer-store'
import type { EditorFactory } from './editor-engine'
import { RichTextEditor } from './RichTextEditor'

export interface ComposerWindowProps {
  readonly draft: DraftWindow
  readonly tier: LayoutTier
  /** Injectable editor factory (tests pass a fake; production uses the real Squire adapter). */
  readonly editorFactory?: EditorFactory | undefined
}

export function ComposerWindow({ draft, tier, editorFactory }: ComposerWindowProps) {
  const { t } = useTranslation()
  const setMode = useComposerStore((state) => state.setMode)
  const closeDraft = useComposerStore((state) => state.closeDraft)
  const updateBody = useComposerStore((state) => state.updateBody)
  const updateSubject = useComposerStore((state) => state.updateSubject)
  const focusDraft = useComposerStore((state) => state.focusDraft)

  const [confirmClose, setConfirmClose] = useState(false)
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

  const requestClose = (): void => {
    if (draft.dirty) setConfirmClose(true)
    else closeDraft(draft.id)
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'Escape' || !fullscreen) return
    event.preventDefault()
    setMode(draft.id, 'docked')
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

      {confirmClose && (
        <Dialog
          open
          onClose={() => setConfirmClose(false)}
          title={t('compose.discardTitle')}
          size="sm"
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirmClose(false)}>
                {t('compose.discardCancel')}
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  setConfirmClose(false)
                  closeDraft(draft.id)
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
