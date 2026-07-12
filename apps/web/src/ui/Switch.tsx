import { type ReactNode, type Ref, useId } from 'react'
import { cx } from './internal/cx'
import styles from './Switch.module.css'

export interface SwitchProps {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  /** Visible label; omit and pass `aria-label` for a control-only switch. */
  label?: ReactNode
  'aria-label'?: string
  /** Id of the element describing the switch (a hint/consequence line) — announced after its name. */
  'aria-describedby'?: string
  disabled?: boolean
  id?: string
  className?: string
  ref?: Ref<HTMLButtonElement>
}

/**
 * On/off toggle following the APG switch pattern: a `role="switch"` button with
 * `aria-checked`, toggled by click and — natively for a button — Space/Enter. State is
 * conveyed by `aria-checked` and the thumb position, not color alone. Provide either a
 * visible `label` or an `aria-label`.
 */
export function Switch({
  checked,
  onCheckedChange,
  label,
  disabled,
  id,
  className,
  ref,
  'aria-label': ariaLabel,
  'aria-describedby': ariaDescribedBy,
}: SwitchProps) {
  const labelId = useId()

  const button = (
    <button
      ref={ref}
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-labelledby={label !== undefined ? labelId : undefined}
      aria-label={label === undefined ? ariaLabel : undefined}
      aria-describedby={ariaDescribedBy}
      disabled={disabled}
      className={cx(styles.switch, checked && styles.checked, className)}
      onClick={() => onCheckedChange(!checked)}
    >
      <span className={styles.track} aria-hidden="true">
        <span className={styles.thumb} />
      </span>
    </button>
  )

  if (label === undefined) return button

  return (
    <span className={styles.row}>
      <span id={labelId} className={styles.label}>
        {label}
      </span>
      {button}
    </span>
  )
}
