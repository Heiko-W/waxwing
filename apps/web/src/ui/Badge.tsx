import type { ReactNode } from 'react'
import styles from './Badge.module.css'
import { cx } from './internal/cx'

export type BadgeTone = 'neutral' | 'accent' | 'danger' | 'success' | 'warning'

export interface BadgeProps {
  children: ReactNode
  tone?: BadgeTone
  className?: string
}

/**
 * Small status/count pill (e.g. unread counts, folder badges). Every tone is a solid fill
 * whose label color is contrast-verified against it (tokens.contrast.test.ts). A Badge is
 * decorative styling around its text: when the count carries meaning a screen reader needs
 * (e.g. "3 unread"), the caller supplies that as the child or an adjacent label — not the
 * color alone.
 */
export function Badge({ children, tone = 'neutral', className }: BadgeProps) {
  return <span className={cx(styles.badge, styles[tone], className)}>{children}</span>
}
