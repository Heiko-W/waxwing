import { useState } from 'react'
import styles from './Avatar.module.css'
import { cx } from './internal/cx'

export type AvatarSize = 'sm' | 'md' | 'lg'

export interface AvatarProps {
  /** Full display name or email; used for the accessible label and the initials. */
  name: string
  size?: AvatarSize
  className?: string
  /**
   * A LOCAL photo to show instead of the initials: an object URL from the blob cache, or an inline
   * `data:` URI, sourced from a contact card. This is NOT a remote sender image — FR-LST-03 bars
   * Waxwing from FETCHING remote images (a tracking-pixel vector), which a local blob / `data:` URL
   * is not, so showing one here does not reopen that hole. Falls back to the initials when it is
   * absent or fails to load (`onError`).
   */
  photoSrc?: string
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
 * Initials avatar with an OPTIONAL local photo (FR-LST-03 — Waxwing never loads remote sender images;
 * a `photoSrc` here is a local contact blob, not a remote fetch — see {@link AvatarProps.photoSrc}).
 * Neutral surface with the display name as its accessible label; the initials (or the photo) are
 * decorative (`aria-hidden` / empty `alt`) so a screen reader reads the name, not two stray letters.
 */
export function Avatar({ name, size = 'md', className, photoSrc }: AvatarProps) {
  // Remember which URL failed rather than a bare boolean: a fresh `photoSrc` is a fresh chance to load
  // without an effect to reset the flag (and never re-tries the exact URL that just 404'd).
  const [failedSrc, setFailedSrc] = useState<string | undefined>(undefined)
  const showPhoto = photoSrc !== undefined && photoSrc !== '' && photoSrc !== failedSrc

  return (
    <span role="img" aria-label={name} className={cx(styles.avatar, styles[size], className)}>
      {showPhoto ? (
        <img
          className={styles.image}
          src={photoSrc}
          alt=""
          onError={() => setFailedSrc(photoSrc)}
        />
      ) : (
        <span aria-hidden="true">{initialsFromName(name)}</span>
      )}
    </span>
  )
}
