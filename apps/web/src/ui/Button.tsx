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
   * This control cannot act right now, and it has to LOOK that way — while staying focusable.
   *
   * Renders `aria-disabled`, mirrors `:disabled` visually (dimmed, `not-allowed`) and swallows
   * activation, but keeps the button in the tab order: `disabled` would remove it, and the reader
   * who most needs to know why is then the only one who can never reach it (FR-A11Y-01).
   *
   * Use this when the explanation is ALREADY ON SCREEN beside the control — an onboarding card has
   * the room for a sentence, and a note nobody can see is not a statement. Use
   * {@link unavailableReason} when it does not, which implies this and adds the sentence as a
   * hidden description.
   *
   * The split exists because passing a bare `aria-disabled` through looked like the whole job and
   * was only half of it: the attribute went through `...rest` while the CLASS that dims the button
   * did not, so the offline sign-in buttons announced themselves as unavailable to a screen reader
   * and rendered in full primary blue to everybody else. Found by looking at the screen, not by any
   * of 5900 tests.
   */
  unavailable?: boolean
  /**
   * Why this control cannot act right now — a finished, localized sentence. Implies
   * {@link unavailable}.
   *
   * Renders `aria-disabled` plus an accessible description and deliberately KEEPS the button
   * focusable. `disabled` would remove it from the tab order, which means the one user who most
   * needs the explanation is the only one who can never reach it (FR-A11Y-01). Activation is
   * swallowed here, so a caller cannot forget to guard its handler.
   *
   * The sentence is rendered as a SIBLING of the button, not inside it. Inside, it was part of the
   * button's own content and therefore part of its accessible NAME: "Move" became "Move You are
   * offline. Files can only be changed while connected.", which `aria-describedby` then read out a
   * second time. An icon-only button hid the damage behind its `aria-label`; a text button did not,
   * and two file actions were left un-gated offline rather than have their names wrecked.
   * `VisuallyHidden` is absolutely positioned, so the extra node costs no layout.
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
  unavailable = false,
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
  const refused = (unavailable || unavailableReason !== undefined) && !disabled && !loading
  // The hidden sentence is the SECOND half and only follows the reason. A control whose reason is
  // already on screen must not also carry an invisible copy of it — that is the same statement
  // twice for a screen reader and once for everyone else.
  const describeReason = refused && unavailableReason !== undefined
  return (
    <>
      <button
        ref={ref}
        type={type ?? 'button'}
        className={cx(
          styles.button,
          styles[variant],
          styles[size],
          block && styles.block,
          refused && styles.unavailable,
          className,
        )}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        aria-disabled={refused || undefined}
        aria-describedby={describeReason ? reasonId : undefined}
        onClick={
          refused ? (event: MouseEvent<HTMLButtonElement>) => event.preventDefault() : onClick
        }
        {...rest}
      >
        {loading ? <Spinner size="sm" label="" /> : null}
        <span className={styles.label}>{children}</span>
      </button>
      {/* OUTSIDE the button, so it describes the control without becoming part of its name. */}
      {describeReason && <VisuallyHidden id={reasonId}>{unavailableReason}</VisuallyHidden>}
    </>
  )
}
