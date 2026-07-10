import type { CSSProperties } from 'react'
import { cx } from './internal/cx'
import styles from './Skeleton.module.css'

export interface SkeletonProps {
  /** CSS inline-size; a number is treated as px. */
  width?: number | string
  /** CSS block-size; a number is treated as px. */
  height?: number | string
  /** Render as a circle (avatar placeholder). */
  circle?: boolean
  className?: string
}

function toLength(value: number | string | undefined): string | undefined {
  if (value === undefined) return undefined
  return typeof value === 'number' ? `${value}px` : value
}

/**
 * Content placeholder shown while data loads. Purely decorative (`aria-hidden`): the
 * loading state itself must be announced by a nearby `role="status"`/live region (e.g. a
 * Spinner), so a screen reader is told "loading" once, not read a wall of empty boxes. The
 * shimmer honors `prefers-reduced-motion` via the global reset.
 */
export function Skeleton({ width, height, circle, className }: SkeletonProps) {
  const style: CSSProperties = {
    inlineSize: toLength(width),
    blockSize: toLength(height),
  }
  return (
    <span
      aria-hidden="true"
      className={cx(styles.skeleton, circle && styles.circle, className)}
      style={style}
    />
  )
}
