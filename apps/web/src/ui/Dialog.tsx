import { X } from 'lucide-react'
import { type MouseEvent, type ReactNode, type RefObject, useEffect, useId, useRef } from 'react'
import { useTranslation } from 'react-i18next'
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
  closeLabel,
  size = 'md',
  className,
}: DialogProps) {
  const { t } = useTranslation()
  const titleId = useId()
  const panelRef = useRef<HTMLDivElement>(null)

  useFocusTrap(open, panelRef, { initialFocusRef })
  useDismiss(open, panelRef, onClose, { escape: true, outsidePointer: false })

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
    if (dismissOnBackdrop && event.target === event.currentTarget) onClose()
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
        >
          <header className={styles.header}>
            <h2 id={titleId} className={styles.title}>
              {title}
            </h2>
            <IconButton label={closeLabel ?? t('ui.dialog.close')} onClick={onClose}>
              <X aria-hidden="true" />
            </IconButton>
          </header>
          <div className={styles.body}>{children}</div>
          {footer ? <footer className={styles.footer}>{footer}</footer> : null}
        </div>
      </div>
    </Portal>
  )
}
