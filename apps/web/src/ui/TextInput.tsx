import type { InputHTMLAttributes, Ref } from 'react'
import { cx } from './internal/cx'
import styles from './TextInput.module.css'

export interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Mark the field invalid: sets `aria-invalid` and a danger boundary. */
  invalid?: boolean
  ref?: Ref<HTMLInputElement>
}

/**
 * Styled text input. Deliberately just the control — labelling, hint and error text are the
 * caller's job (associate a `<label htmlFor>` and, for errors, `aria-describedby`), which
 * keeps it composable for the various forms across the app. Resting boundary uses
 * `--waxwing-border-strong` (>= 3:1); focus uses the global ring.
 */
export function TextInput({ invalid, className, ref, ...rest }: TextInputProps) {
  return (
    <input
      ref={ref}
      className={cx(styles.input, invalid && styles.invalid, className)}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  )
}
