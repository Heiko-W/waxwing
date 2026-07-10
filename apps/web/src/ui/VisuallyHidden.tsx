import type { ReactNode } from 'react'
import styles from './VisuallyHidden.module.css'

export interface VisuallyHiddenProps {
  children: ReactNode
  /** Element id, so a visually-hidden label can be referenced by aria-labelledby/describedby. */
  id?: string
}

/**
 * Content available to assistive technology but not shown visually (FR-A11Y-01) — e.g. the
 * accessible name of an icon-only control, or a status message read by a screen reader. Uses
 * the standard clip technique that keeps the text in the accessibility tree.
 */
export function VisuallyHidden({ children, id }: VisuallyHiddenProps) {
  return (
    <span id={id} className={styles.visuallyHidden}>
      {children}
    </span>
  )
}
