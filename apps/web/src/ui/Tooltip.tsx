import {
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
  useCallback,
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

/**
 * Supplementary hint shown on hover and keyboard focus (APG tooltip pattern). The trigger
 * gets `aria-describedby` pointing at the bubble; the tooltip itself is not focusable and
 * does not trap. Escape dismisses it while the trigger keeps focus. Because a tooltip can be
 * missed, use it only for supplementary hints — an icon-only control still needs its own
 * `aria-label` (see IconButton), not just a Tooltip.
 */
export function Tooltip({ content, children, placement = 'top', openDelay = 300 }: TooltipProps) {
  const id = useId()
  const wrapperRef = useRef<HTMLSpanElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
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

  const clearTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
  }, [])

  const show = useCallback(() => {
    position()
    setOpen(true)
  }, [position])

  const hide = useCallback(() => {
    clearTimer()
    setOpen(false)
  }, [clearTimer])

  const onEnter = useCallback(() => {
    clearTimer()
    timerRef.current = setTimeout(show, openDelay)
  }, [clearTimer, show, openDelay])

  useDismiss(open, wrapperRef, hide, { escape: true, outsidePointer: false })

  if (!isValidElement(children)) return children

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover/focus wrapper drives a supplementary tooltip; the trigger child stays the interactive element and keeps its own role
    <span
      ref={wrapperRef}
      className={styles.wrapper}
      onPointerEnter={onEnter}
      onPointerLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {open ? cloneElement(children, { 'aria-describedby': id }) : children}
      {open ? (
        <Portal>
          <div
            id={id}
            role="tooltip"
            className={cx(styles.tooltip, styles[placement])}
            style={{ position: 'fixed', top: coords.top, left: coords.left }}
          >
            {content}
          </div>
        </Portal>
      ) : null}
    </span>
  )
}
