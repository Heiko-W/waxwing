/**
 * A single decorative label swatch (M3.2): a colored dot ringed by `--waxwing-border-strong` so it
 * stays perceivable regardless of hue. It carries NO accessible name of its own — color is never the
 * sole signal, so every caller pairs it with the label's name in text (visible or VisuallyHidden).
 */

import type { LabelColor } from './label-model'
import styles from './labels.module.css'

export interface LabelSwatchProps {
  readonly color: LabelColor
  readonly size?: 'sm' | 'md'
  readonly className?: string
}

export function LabelSwatch({ color, size = 'md', className }: LabelSwatchProps) {
  const sizeClass = size === 'sm' ? styles.swatchSm : styles.swatchMd
  return (
    <span
      aria-hidden="true"
      className={`${styles.swatch} ${sizeClass}${className ? ` ${className}` : ''}`}
      style={{ backgroundColor: `var(--waxwing-label-${color})` }}
    />
  )
}
