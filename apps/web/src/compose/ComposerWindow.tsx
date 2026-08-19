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

import {
  Clock,
  FileText,
  Maximize2,
  Minimize2,
  Minus,
  Paperclip,
  Send,
  Trash2,
  X,
} from 'lucide-react'
import {
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import { useSessionOptional } from '../app/session/context'
import type { LayoutTier } from '../app/shell/layout'
import { formatDate } from '../i18n/formatters'
import { Button, Dialog, IconButton, Menu, TextInput, useFocusTrap, useToast } from '../ui'
import { AttachmentChips } from './AttachmentChips'
import { isPlausibleEmail } from './address-validation'
import { mentionsAttachment } from './attachment-mention'
import { maxScheduleMs } from './scheduled-send'

const ScheduleSendDialog = lazy(() => import('./ScheduleSendDialog'))

import type { BlobUploader } from './attachment-upload'
import { useUndoSendSeconds } from './compose-prefs'
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
import { useTemplates } from './use-templates'

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
  const { toast } = useToast()
  const setMode = useComposerStore((state) => state.setMode)
  const updateBody = useComposerStore((state) => state.updateBody)
  const updateSubject = useComposerStore((state) => state.updateSubject)
  const focusDraft = useComposerStore((state) => state.focusDraft)
  const draftSync = useDraftSync()
  const undoSendSeconds = useUndoSendSeconds()
  const connected = useSessionOptional()
  /** How far ahead this account may schedule; `0` hides the control entirely (FR-CMP-11). */
  const scheduleMaxMs = maxScheduleMs(connected?.jmapSession ?? null, connected?.accountId ?? null)
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const templates = useTemplates()
  // Only an ACTIVE upload blocks Send — an errored chip must not wedge it (the user can send
  // without the failed file). Completed uploads have already left the slice for `draft.attachments`.
  const uploadsInFlight = useComposerStore((state) =>
    (state.uploads.get(draft.id) ?? []).some((upload) => upload.status === 'uploading'),
  )

  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [confirmMention, setConfirmMention] = useState(false)
  const [dragActive, setDragActive] = useState(false)

  const hasRecipients = draft.to.length + draft.cc.length + draft.bcc.length > 0
  const allRecipientsValid = [...draft.to, ...draft.cc, ...draft.bcc].every((address) =>
    isPlausibleEmail(address.email),
  )
  const windowRef = useRef<HTMLDivElement>(null)
  const chipRef = useRef<HTMLButtonElement>(null)
  /** Did focus live inside this window when it was collapsed? Decides whether the chip claims it. */
  const heldFocusRef = useRef(false)

  /** Record that focus was inside, so the minimized chip knows to take it. */
  function rememberFocus(): void {
    heldFocusRef.current = windowRef.current?.contains(document.activeElement) ?? false
  }
  const subjectRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const editorRef = useRef<RichTextEditorHandle>(null)
  const sendingRef = useRef(false)
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

  const canSend = hasRecipients && allRecipientsValid && !uploadsInFlight && !attachments.oversized
  const sendLabel = uploadsInFlight
    ? t('compose.sendWaitUploads')
    : attachments.oversized
      ? t('compose.sendTooLarge')
      : hasRecipients && !allRecipientsValid
        ? t('compose.sendFixRecipients')
        : t('compose.send')

  // Prune inline attachments whose <img> the user deleted from the body (frees size budget + URL).
  const syncInlineRef = useRef(attachments.syncInlineImages)
  syncInlineRef.current = attachments.syncInlineImages
  useEffect(() => {
    syncInlineRef.current(draft.body)
  }, [draft.body])

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
    if (uploadsInFlight) {
      // Closing now would flush the draft WITHOUT the in-flight attachment (and the unmount would
      // abort it) — a silent loss. Keep the window + upload alive by minimizing; autosave persists it.
      setMode(draft.id, 'minimized')
      toast({ title: t('compose.closeWaitUploads') })
      return
    }
    void draftSync.close(draft.id)
  }
  const requestDiscard = (): void => {
    if (isEmptyDraft(draft)) void draftSync.discard(draft.id)
    else setConfirmDiscard(true)
  }

  // Send: queue the message, close the window, and offer Undo for the grace window (M2.8, FR-CMP-07/08).
  const doSend = useCallback(
    async (scheduleAt?: Date): Promise<void> => {
      if (sendingRef.current) return // guard against a double ⌘Enter / double-click while awaiting
      sendingRef.current = true
      const result = await draftSync.send(draft.id, {
        undoMs: undoSendSeconds * 1000,
        ...(scheduleAt === undefined ? {} : { scheduleAt }),
      })
      if (!result.ok) {
        sendingRef.current = false
        const key =
          result.reason === 'noIdentity'
            ? 'compose.sendNoIdentity'
            : result.reason === 'noSentMailbox'
              ? 'compose.sendNoSentMailbox'
              : result.reason === 'engineUnavailable'
                ? 'compose.sendUnavailable'
                : 'compose.sendNoRecipients'
        toast({ tone: 'danger', title: t(key) })
        return
      }
      useComposerStore.getState().closeDraft(draft.id) // do NOT flush (that would race the send)
      // Offline the message is QUEUED, not sending: say so, and say it stickily (a 10 s toast that
      // claims "Sending message…" and vanishes would be a lie the user never gets to correct). The
      // durable QueuedSends chip carries it from there; Undo stays available either way.
      const offline = !navigator.onLine
      const undo = {
        label: t('compose.sendUndo'),
        onAction: () => void draftSync.undoSend(draft.id),
      }
      if (offline) {
        toast({ title: t('outbox.send.queuedOffline'), duration: 0, action: undo })
        return
      }
      if (scheduleAt !== undefined) {
        // Says WHEN, because that is the whole promise being made — and the server keeps it whether
        // or not this app is running.
        toast({
          title: t('compose.schedule.queued', {
            when: formatDate(scheduleAt, { dateStyle: 'medium', timeStyle: 'short' }),
          }),
          duration: result.undoMs > 0 ? result.undoMs : 5000,
          action: undo,
        })
        return
      }
      if (result.undoMs > 0) {
        toast({ title: t('compose.sendUndoToast'), duration: result.undoMs, action: undo })
      }
    },
    [draftSync, draft.id, undoSendSeconds, toast, t],
  )

  const requestSend = useCallback((): void => {
    if (!canSend) return
    editorRef.current?.flush() // push the last (debounced) keystrokes into the store before we send
    const current = useComposerStore.getState().drafts.get(draft.id)
    if (current === undefined) return
    // FR-CMP-10: warn if the text mentions an attachment but none is attached.
    const keywords = t('compose.attachMentionKeywords', { returnObjects: true }) as string[]
    if (current.attachments.length === 0 && mentionsAttachment(current.body, keywords)) {
      setConfirmMention(true)
      return
    }
    void doSend()
  }, [canSend, t, draft.id, doSend])

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      requestSend()
      return
    }
    if (event.key !== 'Escape') return
    // Belt-and-braces beside the listbox's `stopPropagation` (M4.7): honour a veto from anything
    // nested that already handled this Escape, the same rule `ShortcutProvider` follows. A window
    // that collapses on an Escape meant for an inner layer loses the user's place in the draft.
    if (event.defaultPrevented) return
    event.preventDefault()
    rememberFocus()
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

  /**
   * Focus the chip when a window the user was IN collapses (M4.7, WCAG 2.4.3).
   *
   * Minimizing unmounts the whole subtree — the subject input, the Squire body, or the Minimize
   * button itself — and replaces it with this chip. Nothing focused it, so `document.activeElement`
   * fell back to `<body>` and the next Tab restarted at the top of the document. Both routes hit
   * this: the Escape handler and the Minimize button.
   *
   * Guarded on `heldFocus`, so a draft RESTORED as a chip on page load does not steal focus from
   * whatever the user is actually doing — the fix must not become its own focus bug.
   */
  useEffect(() => {
    if (minimized && heldFocusRef.current) {
      heldFocusRef.current = false
      chipRef.current?.focus()
    }
  }, [minimized])

  if (minimized) {
    return (
      <button
        type="button"
        ref={chipRef}
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
              label={sendLabel}
              variant="primary"
              size="sm"
              disabled={!canSend}
              onClick={requestSend}
            >
              <Send />
            </IconButton>
            {templates.templates.length > 0 && (
              // Only shown once the account HAS templates — an empty menu is a control that
              // teaches the user nothing except that it does nothing.
              <Menu
                trigger={<FileText />}
                triggerLabel={t('compose.templates.insert')}
                triggerVariant="ghost"
                align="end"
                items={templates.templates.map((entry) => ({
                  id: entry.id,
                  label: entry.name,
                  onSelect: () => templates.insert(draft.id, entry),
                }))}
              />
            )}
            {scheduleMaxMs > 0 && (
              // Offered only where the SERVER can hold the message (FR-CMP-11). Without
              // FUTURERELEASE this would be a promise the app could not keep with its tab closed.
              <IconButton
                label={t('compose.schedule.open')}
                variant="ghost"
                size="sm"
                disabled={!canSend}
                onClick={() => setScheduleOpen(true)}
              >
                <Clock />
              </IconButton>
            )}
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
            {/* Also not on a phone, and for the same reason: line 129 defines `minimized` as
                `draft.mode === 'minimized' && tier !== 'phone'`, so on a phone the mode is stored
                and then ignored. ComposerHost picks the visible draft by `focusedId`, which this
                button does not touch, so nothing moved — the window stayed exactly where it was.
                On a phone the way to put a draft aside is Close: it is autosaved (M2.6) and waits
                in Drafts, which is what every mail app on a phone does. */}
            {tier !== 'phone' && (
              <IconButton
                label={t('compose.minimize')}
                variant="ghost"
                size="sm"
                onClick={() => {
                  rememberFocus()
                  setMode(draft.id, 'minimized')
                }}
              >
                <Minus />
              </IconButton>
            )}
            {/* Not on a phone, where this button was inert. `fullscreen` is
                `tier === 'phone' || mode === 'expanded'`, so on a phone it stays true whatever the
                mode is: the button rendered as "Restore", set the mode to `docked`, and the window
                did not change — a control that reports a state it cannot leave. Removing it also
                returns ~44 px to the title, which at 390 px was being truncated to "Thursd…". */}
            {tier !== 'phone' && (
              <IconButton
                label={fullscreen ? t('compose.restore') : t('compose.expand')}
                variant="ghost"
                size="sm"
                aria-pressed={fullscreen}
                onClick={() => setMode(draft.id, fullscreen ? 'docked' : 'expanded')}
              >
                {fullscreen ? <Minimize2 /> : <Maximize2 />}
              </IconButton>
            )}
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
          {/* No placeholder. It used to repeat the label word for word — "Betreff" above an empty
              box that also said "Betreff" — which costs a line of the narrowest screen for no
              information. A placeholder earns its place by giving an EXAMPLE (as
              `settings.vacation.subject.placeholder` does with "Nicht im Büro"); a subject has no
              generic example, so the label carries it alone. */}
          <TextInput
            ref={subjectRef}
            id={subjectId}
            value={draft.subject}
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

      {confirmMention && (
        <Dialog
          open
          onClose={() => setConfirmMention(false)}
          title={t('compose.attachMentionTitle')}
          size="sm"
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirmMention(false)}>
                {t('compose.attachMentionCancel')}
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  setConfirmMention(false)
                  void doSend()
                }}
              >
                {t('compose.attachMentionSend')}
              </Button>
            </>
          }
        >
          <p>{t('compose.attachMentionBody')}</p>
        </Dialog>
      )}

      {scheduleOpen && (
        // Lazy: most messages go out now, and the picker carries its own presets and validation.
        <Suspense fallback={null}>
          <ScheduleSendDialog
            maxMs={scheduleMaxMs}
            onCancel={() => setScheduleOpen(false)}
            onConfirm={(at) => {
              setScheduleOpen(false)
              void doSend(at)
            }}
          />
        </Suspense>
      )}
    </>
  )
}
