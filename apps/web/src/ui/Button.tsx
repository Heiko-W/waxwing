import type { ButtonHTMLAttributes, MouseEvent, Ref } from 'react'
import { useId } from 'react'
import styles from './Button.module.css'
import { cx } from './internal/cx'
import { Spinner } from './Spinner'
import { VisuallyHidden } from './VisuallyHidden'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive'
export type ButtonSize = 'md' | 'sm'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Stretch to fill the inline axis. */
  block?: boolean
  /** Show a spinner, mark `aria-busy`, and block activation while a task runs. */
  loading?: boolean
  /**
   * Why this control cannot act right now — a finished, localized sentence.
   *
   * Renders `aria-disabled` plus an accessible description and deliberately KEEPS the button
   * focusable. `disabled` would remove it from the tab order, which means the one user who most
   * needs the explanation is the only one who can never reach it (FR-A11Y-01). Activation is
   * swallowed here, so a caller cannot forget to guard its handler.
   *
   * For a control that is structurally absent — no such folder, a self-move — keep hiding it.
   * This is for a refusal the user should be TOLD about, chiefly a permission they lack.
   */
  unavailableReason?: string | undefined
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
  unavailableReason,
  type,
  className,
  children,
  onClick,
  ref,
  ...rest
}: ButtonProps) {
  const reasonId = useId()
  // `disabled` wins where both apply: a hard-disabled control needs no explanation, and this keeps
  // every existing call site byte-for-byte what it was.
  const unavailable = unavailableReason !== undefined && !disabled && !loading
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={cx(
        styles.button,
        styles[variant],
        styles[size],
        block && styles.block,
        unavailable && styles.unavailable,
        className,
      )}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      aria-disabled={unavailable || undefined}
      aria-describedby={unavailable ? reasonId : undefined}
      onClick={
        unavailable ? (event: MouseEvent<HTMLButtonElement>) => event.preventDefault() : onClick
      }
      {...rest}
    >
      {loading ? <Spinner size="sm" label="" /> : null}
      <span className={styles.label}>{children}</span>
      {unavailable && <VisuallyHidden id={reasonId}>{unavailableReason}</VisuallyHidden>}
    </button>
  )
}
