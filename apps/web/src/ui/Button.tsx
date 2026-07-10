import type { ButtonHTMLAttributes, Ref } from 'react'
import styles from './Button.module.css'
import { cx } from './internal/cx'
import { Spinner } from './Spinner'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive'
export type ButtonSize = 'md' | 'sm'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Stretch to fill the inline axis. */
  block?: boolean
  /** Show a spinner, mark `aria-busy`, and block activation while a task runs. */
  loading?: boolean
  ref?: Ref<HTMLButtonElement>
}

/**
 * The primary action control. Defaults to `type="button"` so a Button inside a form never
 * submits by accident (pass `type="submit"` explicitly). Every size keeps the 44px minimum
 * touch target (FR-A11Y-01); `size="sm"` trims horizontal padding and type, not height.
 * Focus uses the global `:focus-visible` ring (global.css).
 */
export function Button({
  variant = 'secondary',
  size = 'md',
  block = false,
  loading = false,
  disabled,
  type,
  className,
  children,
  ref,
  ...rest
}: ButtonProps) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={cx(styles.button, styles[variant], styles[size], block && styles.block, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner size="sm" label="" /> : null}
      <span className={styles.label}>{children}</span>
    </button>
  )
}
