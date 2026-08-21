import type { ReactNode } from 'react'
import styles from './SectionLabel.module.css'

/**
 * The heading for a group of controls inside a panel or a dialog.
 *
 * It exists because the same rank had grown five different looks, all of them under the same
 * dialog chrome: 12px uppercase dimmed (contacts detail), 14px sentence-case dimmed (file
 * sharing), 14px uppercase dimmed (shortcut help), and 16px sentence-case at full strength in two
 * more (contacts import/export, install steps). The sharpest pair was inside a single feature —
 * `contacts` shipped the 12px uppercase form and the 16px sentence form for the same rank, one
 * third larger and a different case.
 *
 * The form it settles on is the one seven other places in the app already used, and the one iOS
 * uses above a grouped list: small, uppercase, tracked open, dimmed. A label above a group of
 * controls is not competing with the dialog's own title — it is telling you which group this is.
 *
 * `as` because the rank is a document question, not a visual one: this is an `h3` under a dialog's
 * `h2` in most callers, and a `span` where a wrapper already carries the name via
 * `aria-labelledby`.
 */
export interface SectionLabelProps {
  readonly children: ReactNode
  /** Heading level, or `span` where the name is supplied some other way. Default `h3`. */
  readonly as?: 'h2' | 'h3' | 'h4' | 'span'
  readonly id?: string
}

export function SectionLabel({ children, as: Tag = 'h3', id }: SectionLabelProps) {
  return (
    <Tag className={styles.label} {...(id === undefined ? {} : { id })}>
      {children}
    </Tag>
  )
}
