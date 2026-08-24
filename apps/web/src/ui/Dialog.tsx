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
  /** Called on Escape, the close button, or a backdrop press. Memoize it (useCallback). */
  onClose: () => void
  title: ReactNode
  children: ReactNode
  footer?: ReactNode
  /** Element focused when the dialog opens; defaults to its first focusable. */
  initialFocusRef?: RefObject<HTMLElement | null>
  /** Close when the backdrop is pressed. Default true. */
  dismissOnBackdrop?: boolean
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
    if (confirmDiscard && touched.current) {
      setConfirming(true)
      return
    }
    onClose()
  }, [confirmDiscard, onClose])

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
            <IconButton label={closeLabel ?? t('ui.dialog.close')} onClick={requestClose}>
              <X aria-hidden="true" />
            </IconButton>
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
