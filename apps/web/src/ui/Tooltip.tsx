import {
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import { cx } from './internal/cx'
import { Portal } from './internal/Portal'
import { useDismiss } from './internal/useDismiss'
import styles from './Tooltip.module.css'

export type TooltipPlacement = 'top' | 'bottom'

export interface TooltipProps {
  /** Tooltip text (a supplementary hint — never the control's only accessible name). */
  content: ReactNode
  /** A single focusable trigger element; it receives `aria-describedby` and the hint. */
  children: ReactElement<{ 'aria-describedby'?: string }>
  placement?: TooltipPlacement
  /** Hover open delay in ms (focus opens immediately). */
  openDelay?: number
}

// Brief grace period so the pointer can travel from the trigger across the gap onto the
// tooltip without it vanishing (WCAG 2.1 SC 1.4.13 "Hoverable").
const CLOSE_GRACE_MS = 120

/**
 * Supplementary hint shown on hover and keyboard focus (APG tooltip pattern). Hover and focus
 * are tracked independently and the tooltip stays open while EITHER is active — so a mouse
 * drifting off the trigger never dismisses a tooltip the keyboard opened, and vice versa. The
 * bubble is itself hoverable (1.4.13). The trigger gets `aria-describedby`; the tooltip does
 * not trap focus. Escape dismisses while the trigger keeps focus. Use only for supplementary
 * hints — an icon-only control still needs its own `aria-label` (see IconButton).
 */
export function Tooltip({ content, children, placement = 'top', openDelay = 300 }: TooltipProps) {
  const id = useId()
  const wrapperRef = useRef<HTMLSpanElement>(null)
  const openTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const hovered = useRef(false)
  const focused = useRef(false)
  const [open, setOpen] = useState(false)
  const [coords, setCoords] = useState({ top: 0, left: 0 })

  const position = useCallback(() => {
    const rect = wrapperRef.current?.getBoundingClientRect()
    if (!rect) return
    const gap = 8
    setCoords({
      top: placement === 'top' ? rect.top - gap : rect.bottom + gap,
      left: rect.left + rect.width / 2,
    })
  }, [placement])

  const clearTimers = useCallback(() => {
    if (openTimer.current) clearTimeout(openTimer.current)
    if (closeTimer.current) clearTimeout(closeTimer.current)
  }, [])

  const openNow = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    position()
    setOpen(true)
  }, [position])

  const scheduleClose = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => {
      if (!hovered.current && !focused.current) setOpen(false)
    }, CLOSE_GRACE_MS)
  }, [])

  const onPointerEnter = useCallback(() => {
    hovered.current = true
    if (closeTimer.current) clearTimeout(closeTimer.current)
    if (openTimer.current) clearTimeout(openTimer.current)
    openTimer.current = setTimeout(openNow, openDelay)
  }, [openNow, openDelay])

  const onPointerLeave = useCallback(() => {
    hovered.current = false
    if (openTimer.current) clearTimeout(openTimer.current)
    scheduleClose()
  }, [scheduleClose])

  const onFocus = useCallback(() => {
    focused.current = true
    openNow()
  }, [openNow])

  const onBlur = useCallback(() => {
    focused.current = false
    scheduleClose()
  }, [scheduleClose])

  const dismiss = useCallback(() => {
    hovered.current = false
    focused.current = false
    clearTimers()
    setOpen(false)
  }, [clearTimers])

  useDismiss(open, wrapperRef, dismiss, { escape: true, outsidePointer: false })

  // Cancel any pending open/close timer if the trigger unmounts mid-hover.
  useEffect(() => clearTimers, [clearTimers])

  if (!isValidElement(children)) return children

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover/focus wrapper drives a supplementary tooltip; the trigger child stays the interactive element and keeps its own role
    <span
      ref={wrapperRef}
      className={styles.wrapper}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onFocus={onFocus}
      onBlur={onBlur}
    >
      {open ? cloneElement(children, { 'aria-describedby': id }) : children}
      {open ? (
        <Portal>
          <div
            id={id}
            role="tooltip"
            className={cx(styles.tooltip, styles[placement])}
            style={{ position: 'fixed', top: coords.top, left: coords.left }}
            onPointerEnter={() => {
              hovered.current = true
              if (closeTimer.current) clearTimeout(closeTimer.current)
            }}
            onPointerLeave={onPointerLeave}
          >
            {content}
          </div>
        </Portal>
      ) : null}
    </span>
  )
}
