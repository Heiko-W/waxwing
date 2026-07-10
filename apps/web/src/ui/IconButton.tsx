import type { ReactNode } from 'react'
import { Button, type ButtonProps } from './Button'
import styles from './IconButton.module.css'
import { cx } from './internal/cx'

export interface IconButtonProps extends Omit<ButtonProps, 'children' | 'block'> {
  /** Required accessible name — an icon-only control has no visible text (FR-A11Y-01). */
  label: string
  /** The icon element (e.g. a lucide-react icon). */
  children: ReactNode
}

/**
 * Square, icon-only button (44×44 touch target). Built on Button so it inherits variants,
 * loading and disabled behaviour; adds the mandatory `aria-label`. Wrap in a Tooltip when a
 * visible hint is wanted — the label is what assistive tech announces regardless.
 */
export function IconButton({
  label,
  variant = 'ghost',
  className,
  children,
  ...rest
}: IconButtonProps) {
  return (
    <Button
      aria-label={label}
      variant={variant}
      className={cx(styles.iconButton, className)}
      {...rest}
    >
      {/* The label is the accessible name; the icon is decorative, so hide it from AT here
          rather than relying on every caller to remember `aria-hidden`. */}
      <span aria-hidden="true" className={styles.icon}>
        {children}
      </span>
    </Button>
  )
}
