import type { ReactNode } from 'react'
import styles from './VisuallyHidden.module.css'

export interface VisuallyHiddenProps {
  children: ReactNode
  /** Element id, so a visually-hidden label can be referenced by aria-labelledby/describedby. */
  id?: string
  /** Make the hidden node a live region so assistive tech announces changes to its content. */
  'aria-live'?: 'polite' | 'assertive'
}

/**
 * Content available to assistive technology but not shown visually (FR-A11Y-01) — e.g. the
 * accessible name of an icon-only control, or a status message read by a screen reader. Uses
 * the standard clip technique that keeps the text in the accessibility tree.
 */
export function VisuallyHidden({ children, id, 'aria-live': ariaLive }: VisuallyHiddenProps) {
  return (
    <span id={id} className={styles.visuallyHidden} aria-live={ariaLive}>
      {children}
    </span>
  )
}
