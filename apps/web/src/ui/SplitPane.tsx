import { type KeyboardEvent, type PointerEvent, type ReactNode, useRef, useState } from 'react'
import { cx } from './internal/cx'
import styles from './SplitPane.module.css'

export type SplitOrientation = 'horizontal' | 'vertical'

export interface SplitPaneProps {
  /** 'horizontal' = panes side by side (vertical divider); 'vertical' = stacked (horizontal divider). */
  orientation?: SplitOrientation
  /** Exactly two children: the resizable primary pane, then the flexible secondary pane. */
  children: [ReactNode, ReactNode]
  /** Accessible name for the resize separator (localized by the caller). */
  label: string
  /** Primary pane size in px (inline size when horizontal, block size when vertical). */
  defaultPrimarySize?: number
  minPrimarySize?: number
  maxPrimarySize?: number
  /** Keyboard resize step in px. */
  step?: number
  className?: string
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Resizable two-pane layout (reading-pane split, FR-LST-07). The divider is an APG window
 * splitter: `role="separator"`, focusable, with `aria-valuenow/min/max`. It resizes by
 * pointer drag and by keyboard — Arrow keys along the split axis, Home/End to the limits —
 * so the layout is operable without a mouse (FR-A11Y-01).
 */
export function SplitPane({
  orientation = 'horizontal',
  children,
  label,
  defaultPrimarySize = 320,
  minPrimarySize = 160,
  maxPrimarySize = 640,
  step = 16,
  className,
}: SplitPaneProps) {
  const isHorizontal = orientation === 'horizontal'
  const [size, setSize] = useState(() => clamp(defaultPrimarySize, minPrimarySize, maxPrimarySize))
  const containerRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)

  function onPointerDown(event: PointerEvent<HTMLDivElement>): void {
    draggingRef.current = true
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>): void {
    if (!draggingRef.current || !containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    const raw = isHorizontal ? event.clientX - rect.left : event.clientY - rect.top
    setSize(clamp(raw, minPrimarySize, maxPrimarySize))
  }

  function onPointerUp(event: PointerEvent<HTMLDivElement>): void {
    draggingRef.current = false
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const decrease = isHorizontal ? 'ArrowLeft' : 'ArrowUp'
    const increase = isHorizontal ? 'ArrowRight' : 'ArrowDown'
    if (event.key === decrease) {
      event.preventDefault()
      setSize((current) => clamp(current - step, minPrimarySize, maxPrimarySize))
    } else if (event.key === increase) {
      event.preventDefault()
      setSize((current) => clamp(current + step, minPrimarySize, maxPrimarySize))
    } else if (event.key === 'Home') {
      event.preventDefault()
      setSize(minPrimarySize)
    } else if (event.key === 'End') {
      event.preventDefault()
      setSize(maxPrimarySize)
    }
  }

  const primaryStyle = isHorizontal ? { inlineSize: `${size}px` } : { blockSize: `${size}px` }

  return (
    <div
      ref={containerRef}
      className={cx(
        styles.container,
        isHorizontal ? styles.horizontal : styles.vertical,
        className,
      )}
    >
      <div className={styles.primary} style={primaryStyle}>
        {children[0]}
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: a splitter is an ARIA separator, no HTML equivalent */}
      <div
        role="separator"
        tabIndex={0}
        aria-orientation={isHorizontal ? 'vertical' : 'horizontal'}
        aria-label={label}
        aria-valuenow={Math.round(size)}
        aria-valuemin={minPrimarySize}
        aria-valuemax={maxPrimarySize}
        className={styles.separator}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onKeyDown={onKeyDown}
      >
        <span className={styles.grip} aria-hidden="true" />
      </div>
      <div className={styles.secondary}>{children[1]}</div>
    </div>
  )
}
