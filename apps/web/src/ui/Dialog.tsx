import { X } from 'lucide-react'
import {
  type MouseEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from './Button'
import styles from './Dialog.module.css'
import { IconButton } from './IconButton'
import { cx } from './internal/cx'
import { Portal } from './internal/Portal'
import { useDismiss } from './internal/useDismiss'
import { useFocusTrap } from './internal/useFocusTrap'

export type DialogSize = 'sm' | 'md' | 'lg'

export interface DialogProps {
  open: boolean
  /**
   * Called on Escape, the close button, or a backdrop press. An inline arrow is fine — this used to
   * ask for a `useCallback`, and that instruction was the only thing standing between eighteen call
   * sites and a real bug (R-39): an unmemoised `onClose` re-registered the dialog's Escape entry on
   * every render and moved it above any menu open inside the dialog. `useDismiss` now binds the
   * stack entry to the layer instead of to the closure.
   * Never called when {@link dismissible} is false — the dialog then has no dismiss gesture.
   */
  onClose: () => void
  title: ReactNode
  children: ReactNode
  footer?: ReactNode
  /** Element focused when the dialog opens; defaults to its first focusable. */
  initialFocusRef?: RefObject<HTMLElement | null>
  /** Close when the backdrop is pressed. Default true. */
  dismissOnBackdrop?: boolean
  /**
   * Whether the universal "get me out of here" gestures may close this dialog at all. Default true.
   *
   * `false` hides the ✕ and makes Escape and a backdrop press do nothing, for the one shape of
   * dialog where every dismissal is destructive and there is nothing behind it to return to — the
   * re-auth prompt, whose "close" used to be Sign out (and, in public-computer mode, a wipe of the
   * local copy) while the text above it promised "your place is kept". The way out is then the
   * dialog's own labelled buttons, which is the only honest option: a reader cannot be expected to
   * know that this particular ✕ signs them out.
   *
   * The Escape listener stays REGISTERED (see `useDismiss`'s LIFO stack) so the press is swallowed
   * here rather than falling through to whatever overlay sits behind the modal.
   */
  dismissible?: boolean
  /**
   * Guard user-entered content (HIG `modality`: "help people avoid data loss by getting
   * confirmation before closing a modal view … regardless of whether people use a dismiss gesture
   * or a button").
   *
   * Opt-in per dialog rather than on by default, because most dialogs here hold a choice rather
   * than typing and an extra confirmation on those is friction for nothing. Where it IS on, the
   * dialog watches its own subtree for input instead of asking the form for a dirty flag: the
   * flag is what every one of these forms would have had to grow, and a form that forgets one
   * field is worse than a dialog that occasionally asks about a field the reader put back.
   */
  confirmDiscard?: boolean
  /** Accessible name for the close button; defaults to the localized "Close". */
  closeLabel?: string
  size?: DialogSize
  className?: string
}

/**
 * Modal dialog (APG dialog pattern). While open it traps focus, restores focus to the
 * opener on close, closes on Escape, and locks body scroll. Labelled by its title via
 * `aria-labelledby`. Rendered through a Portal so it escapes ancestor stacking/overflow.
 */
export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  initialFocusRef,
  dismissOnBackdrop = true,
  dismissible = true,
  confirmDiscard = false,
  closeLabel,
  size = 'md',
  className,
}: DialogProps) {
  const { t } = useTranslation()
  const titleId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  /**
   * A ref, not state: this is written on every keystroke and read only when the reader tries to
   * leave. As state it would re-render the whole dialog for each character typed into it.
   */
  const touched = useRef(false)
  const [confirming, setConfirming] = useState(false)

  /** The single way out. Every dismissal path goes through it, which is the point of the guard. */
  const requestClose = useCallback((): void => {
    if (!dismissible) return
    if (confirmDiscard && touched.current) {
      setConfirming(true)
      return
    }
    onClose()
  }, [dismissible, confirmDiscard, onClose])

  useFocusTrap(open, panelRef, { initialFocusRef })
  useDismiss(open, panelRef, requestClose, { escape: true, outsidePointer: false })

  useEffect(() => {
    if (open) return
    // Reopening the same dialog for a different record must not inherit the last one's edits.
    touched.current = false
    setConfirming(false)
  }, [open])

  useEffect(() => {
    if (!open) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [open])

  if (!open) return null

  function onBackdropPointerDown(event: MouseEvent<HTMLDivElement>): void {
    if (dismissOnBackdrop && event.target === event.currentTarget) requestClose()
  }

  return (
    <Portal>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: backdrop press-to-dismiss; keyboard dismissal is Escape (useDismiss) */}
      <div className={styles.backdrop} onMouseDown={onBackdropPointerDown}>
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          className={cx(styles.panel, styles[size], className)}
          // Any typing or picking inside the panel counts. `onInput` covers text fields and
          // contenteditable, `onChange` the controls that only report on commit (select, checkbox,
          // radio, file) — both are React synthetic events and bubble from the whole subtree.
          onInput={confirmDiscard ? () => (touched.current = true) : undefined}
          onChange={confirmDiscard ? () => (touched.current = true) : undefined}
        >
          {/* <div>, NOT <header>/<footer>. A `role="dialog"` container is not sectioning content,
              so an HTML <header> inside it still maps to the `banner` LANDMARK — giving the page a
              second banner alongside the shell's, both unnamed and indistinguishable. Measured by
              the browser sweep as `landmark-unique` on every screen with a dialog open. */}
          <div className={styles.header}>
            <h2 id={titleId} className={styles.title}>
              {title}
            </h2>
            {dismissible ? (
              <IconButton label={closeLabel ?? t('ui.dialog.close')} onClick={requestClose}>
                <X aria-hidden="true" />
              </IconButton>
            ) : null}
          </div>
          <div className={styles.body}>{children}</div>
          {footer ? <div className={styles.footer}>{footer}</div> : null}
        </div>
      </div>
      {confirming ? (
        <Dialog
          open
          onClose={() => setConfirming(false)}
          title={t('ui.dialog.discardTitle')}
          size="sm"
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirming(false)}>
                {t('ui.dialog.discardCancel')}
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  setConfirming(false)
                  onClose()
                }}
              >
                {t('ui.dialog.discardConfirm')}
              </Button>
            </>
          }
        >
          <p>{t('ui.dialog.discardBody')}</p>
        </Dialog>
      ) : null}
    </Portal>
  )
}
