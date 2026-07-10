import styles from './Avatar.module.css'
import { cx } from './internal/cx'

export type AvatarSize = 'sm' | 'md' | 'lg'

export interface AvatarProps {
  /** Full display name or email; used for the accessible label and the initials. */
  name: string
  size?: AvatarSize
  className?: string
}

/**
 * Derive up to two initials from a display name or email. Two words → first letter of each;
 * a single token → its first two characters; empty → "?".
 */
export function initialsFromName(name: string): string {
  // Strip address angle brackets so "Alice <alice@host>" yields AA, not A<.
  const parts = name.replace(/[<>]/g, ' ').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return (parts[0] ?? '').slice(0, 2).toUpperCase() || '?'
  const first = parts.at(0) ?? ''
  const last = parts.at(-1) ?? ''
  return (first.charAt(0) + last.charAt(0)).toUpperCase()
}

/**
 * Initials avatar (FR-LST-03 — Waxwing never loads remote sender images). Neutral surface
 * with the display name as its accessible label; the initials are decorative
 * (`aria-hidden`) so a screen reader reads the name, not two stray letters.
 */
export function Avatar({ name, size = 'md', className }: AvatarProps) {
  return (
    <span role="img" aria-label={name} className={cx(styles.avatar, styles[size], className)}>
      <span aria-hidden="true">{initialsFromName(name)}</span>
    </span>
  )
}
