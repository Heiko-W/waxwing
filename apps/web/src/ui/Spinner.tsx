import { useTranslation } from 'react-i18next'
import { cx } from './internal/cx'
import styles from './Spinner.module.css'
import { VisuallyHidden } from './VisuallyHidden'

export type SpinnerSize = 'sm' | 'md' | 'lg'

export interface SpinnerProps {
  size?: SpinnerSize
  /** Accessible loading label; defaults to the localized "Loading". Pass `''` when a
   *  surrounding live region already announces the loading state, to avoid double reading. */
  label?: string
  className?: string
}

/**
 * Indeterminate loading indicator. Wrapped in `role="status"` with a visually-hidden label
 * so assistive tech announces "Loading"; the ring itself is decorative (`aria-hidden`).
 * The spin honors `prefers-reduced-motion` via the global reset (global.css).
 */
export function Spinner({ size = 'md', label, className }: SpinnerProps) {
  const { t } = useTranslation()
  const text = label ?? t('ui.spinner.label')
  return (
    <span role="status" className={cx(styles.spinner, styles[size], className)}>
      <span className={styles.ring} aria-hidden="true" />
      {text ? <VisuallyHidden>{text}</VisuallyHidden> : null}
    </span>
  )
}
