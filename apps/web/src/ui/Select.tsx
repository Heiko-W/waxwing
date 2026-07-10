import { ChevronDown } from 'lucide-react'
import type { Ref, SelectHTMLAttributes } from 'react'
import { cx } from './internal/cx'
import styles from './Select.module.css'

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  /** Mark the field invalid: sets `aria-invalid` and a danger boundary. */
  invalid?: boolean
  ref?: Ref<HTMLSelectElement>
}

/**
 * A styled NATIVE `<select>`. This is a deliberate design choice (recorded in
 * docs/design-system.md): the native control gives correct keyboard handling, screen-reader
 * support and mobile pickers for free, which a hand-rolled listbox has to re-earn and
 * routinely gets wrong. A custom listbox/combobox is deferred to the one place that truly
 * needs it. `appearance: none` + a decorative chevron keep it on-brand.
 */
export function Select({ invalid, className, children, ref, ...rest }: SelectProps) {
  return (
    <div className={styles.wrapper}>
      <select
        ref={ref}
        className={cx(styles.select, invalid && styles.invalid, className)}
        aria-invalid={invalid || undefined}
        {...rest}
      >
        {children}
      </select>
      <ChevronDown aria-hidden="true" className={styles.chevron} />
    </div>
  )
}
