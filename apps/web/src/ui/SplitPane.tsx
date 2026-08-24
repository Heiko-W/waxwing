import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
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
  /**
   * The default as a SHARE of the container, clamped to a px range — `clamp(min, fraction, max)`.
   *
   * Takes precedence over `defaultPrimarySize` when given. It exists because a constant cannot be
   * right at two widths: 420px was chosen for a wide desktop (the first audit's answer to A5 — the
   * column carries the search field and the folder title, and at 360px those competed for the width
   * of a phone while ~930px of header sat empty beside them), and the same 420 at the bottom of the
   * same tier left an iPad in landscape with a 352px reading pane — NARROWER than the 410 it gets
   * in portrait, on 278px more screen. A share reads the room it is actually in.
   */
  defaultPrimary?: { fraction: number; min: number; max: number }
  minPrimarySize?: number
  maxPrimarySize?: number
  /**
   * Remember the size the reader dragged to, under this key.
   *
   * Stored as a FRACTION rather than px, so the same window on a different screen keeps the same
   * proportions instead of the same number of pixels. Per device (localStorage), like the
   * reading-pane mode: it is a view choice, not account data.
   */
  storageKey?: string
  /** Keyboard resize step in px. */
  step?: number
  className?: string
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** The stored share for `key`, or null when there is none (or it is nonsense). */
function readStoredFraction(key: string | undefined): number | null {
  if (key === undefined) return null
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return null
    const value = Number.parseFloat(raw)
    // A fraction outside this band is not a layout anyone dragged to; ignore it rather than trust
    // it, so a corrupted value cannot leave the app with an invisible pane and no way back.
    return Number.isFinite(value) && value > 0.05 && value < 0.95 ? value : null
  } catch {
    return null
  }
}

function writeStoredFraction(key: string | undefined, fraction: number): void {
  if (key === undefined) return
  try {
    localStorage.setItem(key, fraction.toFixed(4))
  } catch {
    // Ignore persistence failures (private mode / storage disabled).
  }
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
  defaultPrimary,
  storageKey,
  minPrimarySize = 160,
  maxPrimarySize = 640,
  step = 16,
  className,
}: SplitPaneProps) {
  const isHorizontal = orientation === 'horizontal'
  const [size, setSize] = useState(() => clamp(defaultPrimarySize, minPrimarySize, maxPrimarySize))
  const containerRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)

  /**
   * The container's extent along the split axis, or 0 before it is laid out.
   *
   * `useCallback` because the layout effect below depends on it: as a plain function it would be a
   * new value every render, and listing it would re-run the effect on every render — which is the
   * one thing that effect must not do (it would re-divide the panes under a reader's hands).
   */
  const containerExtent = useCallback((): number => {
    const node = containerRef.current
    if (!node) return 0
    return isHorizontal ? node.clientWidth : node.clientHeight
  }, [isHorizontal])

  /**
   * Adopt the remembered share, or the default one, once the container has a measurable size.
   *
   * `useLayoutEffect` so the correction happens before paint: the initial state is a px guess, and
   * a reader must not see it and then see it move. Deliberately NOT re-run on every container
   * resize — dragging a window wider should give the extra room to the reading pane, not re-divide
   * everything under the reader's hands.
   */
  const fraction = defaultPrimary?.fraction
  const fractionMin = defaultPrimary?.min
  const fractionMax = defaultPrimary?.max
  useLayoutEffect(() => {
    const total = containerExtent()
    if (total <= 0) return
    const stored = readStoredFraction(storageKey)
    const target =
      stored !== null
        ? stored * total
        : fraction !== undefined && fractionMin !== undefined && fractionMax !== undefined
          ? clamp(fraction * total, fractionMin, fractionMax)
          : defaultPrimarySize
    setSize(clamp(target, minPrimarySize, maxPrimarySize))
    // A stored share wins over a changed default, which is what "the reader has an opinion" means.
    // Without a stored one, a tier change re-applies the new default — the case the old
    // `useState` initialiser could never reach, because it runs once and this component stays
    // mounted across the breakpoint.
  }, [
    containerExtent,
    storageKey,
    fraction,
    fractionMin,
    fractionMax,
    defaultPrimarySize,
    minPrimarySize,
    maxPrimarySize,
  ])

  /** Remember what the reader chose, as a share of the room they chose it in. */
  function remember(next: number): void {
    const total = containerExtent()
    if (total > 0) writeStoredFraction(storageKey, next / total)
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>): void {
    draggingRef.current = true
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>): void {
    if (!draggingRef.current || !containerRef.current) return
    // If no button is held (a stray move, or we missed the pointerup), stop dragging so the
    // divider does not follow a button-less cursor.
    if (event.buttons === 0) {
      draggingRef.current = false
      return
    }
    const rect = containerRef.current.getBoundingClientRect()
    const raw = isHorizontal ? event.clientX - rect.left : event.clientY - rect.top
    setSize(clamp(raw, minPrimarySize, maxPrimarySize))
  }

  function endDrag(event: PointerEvent<HTMLDivElement>): void {
    if (draggingRef.current) remember(size)
    draggingRef.current = false
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const decrease = isHorizontal ? 'ArrowLeft' : 'ArrowUp'
    const increase = isHorizontal ? 'ArrowRight' : 'ArrowDown'
    const apply = (next: number): void => {
      setSize(next)
      remember(next)
    }
    if (event.key === decrease) {
      event.preventDefault()
      apply(clamp(size - step, minPrimarySize, maxPrimarySize))
    } else if (event.key === increase) {
      event.preventDefault()
      apply(clamp(size + step, minPrimarySize, maxPrimarySize))
    } else if (event.key === 'Home') {
      event.preventDefault()
      apply(minPrimarySize)
    } else if (event.key === 'End') {
      event.preventDefault()
      apply(maxPrimarySize)
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
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onKeyDown={onKeyDown}
      >
        <span className={styles.grip} aria-hidden="true" />
      </div>
      <div className={styles.secondary}>{children[1]}</div>
    </div>
  )
}
