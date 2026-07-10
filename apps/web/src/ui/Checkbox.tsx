import { type InputHTMLAttributes, type ReactNode, type Ref, useEffect, useRef } from 'react'
import styles from './Checkbox.module.css'
import { cx } from './internal/cx'

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** Visible label; omit and pass `aria-label` for a control-only checkbox (e.g. select-all). */
  label?: ReactNode
  /** Tri-state visual. Reflected onto the DOM node's `.indeterminate` (not an HTML attribute). */
  indeterminate?: boolean
  ref?: Ref<HTMLInputElement>
}

/**
 * A native checkbox styled with `accent-color`, so it keeps native keyboard, screen-reader
 * and tri-state semantics. Always sits in a `<label>` with a 44px row so the whole target is
 * clickable (FR-A11Y-01); pass `aria-label` when there is no visible `label`.
 */
export function Checkbox({ label, indeterminate = false, className, ref, ...rest }: CheckboxProps) {
  const innerRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (innerRef.current) innerRef.current.indeterminate = indeterminate
  }, [indeterminate])

  function setRef(node: HTMLInputElement | null): void {
    innerRef.current = node
    if (typeof ref === 'function') ref(node)
    else if (ref) ref.current = node
  }

  return (
    <label className={cx(styles.row, label === undefined && styles.bare)}>
      <input ref={setRef} type="checkbox" className={cx(styles.input, className)} {...rest} />
      {label !== undefined ? <span className={styles.label}>{label}</span> : null}
    </label>
  )
}
