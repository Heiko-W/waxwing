import type { ReactNode } from 'react'
import { Button, type ButtonProps } from './Button'
import styles from './IconButton.module.css'
import { cx } from './internal/cx'

export interface IconButtonProps extends Omit<ButtonProps, 'children' | 'block'> {
  /** Required accessible name — an icon-only control has no visible text (FR-A11Y-01). */
  label: string
  /** The icon element (e.g. a lucide-react icon). */
  children: ReactNode
}

/**
 * Square, icon-only button (44×44 touch target). Built on Button so it inherits variants,
 * loading and disabled behaviour; adds the mandatory `aria-label` — and the same string as a
 * `title`, which is what a pointer user sees.
 *
 * The tooltip is not an accessibility measure and must never be read as one; `aria-label` is the
 * name, and it was always there. It is a MAC convention, and the HIG states it as a fact about the
 * platform rather than as advice: "In macOS and visionOS, the system displays a tooltip after
 * people hover over a button for a moment", together with "buttons that contain text don't need to
 * display a tooltip" — the contrapositive of which is this component's entire job description.
 *
 * Why it lives here and not at the 62 call sites: the header, the reading toolbar, the view
 * options, the folder row menu and the composer are all icon-only, and every one of them had an
 * accessible name and nothing a pointer could read. `ui/Tooltip` exists and is fully built, and
 * outside the dev gallery it had not one caller — which says plainly that a per-site opt-in was
 * never going to happen. `title` also degrades correctly: touch shows nothing, which is right,
 * because there is no hover to answer.
 *
 * Overridable, because `rest` is spread after it: a caller with a longer hint than its name (a
 * shortcut, a current value) sets `title` itself.
 */
export function IconButton({
  label,
  variant = 'ghost',
  className,
  children,
  ...rest
}: IconButtonProps) {
  return (
    <Button
      aria-label={label}
      title={label}
      variant={variant}
      className={cx(styles.iconButton, className)}
      {...rest}
    >
      {/* The label is the accessible name; the icon is decorative, so hide it from AT here
          rather than relying on every caller to remember `aria-hidden`. */}
      <span aria-hidden="true" className={styles.icon}>
        {children}
      </span>
    </Button>
  )
}
