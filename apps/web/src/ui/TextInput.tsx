import type { InputHTMLAttributes, Ref } from 'react'
import { cx } from './internal/cx'
import styles from './TextInput.module.css'

export interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Mark the field invalid: sets `aria-invalid` and a danger boundary. */
  invalid?: boolean
  ref?: Ref<HTMLInputElement>
}

/**
 * Fields that hold an IDENTIFIER rather than prose, recognised from what the caller already says
 * about them.
 *
 * The three attributes below are the difference between typing `heiko@example.com` and typing
 * `Heiko@exsmple.com` on a phone: iOS capitalises the first letter of a field by default and runs
 * its autocorrect dictionary over what follows, and a domain name is exactly the kind of string
 * that dictionary is confident and wrong about. HIG `virtual-keyboards`: "Choose a keyboard that
 * matches the type of content people are editing."
 *
 * Derived rather than required at each call site, because the call site has ALREADY declared the
 * content type — `autoComplete="username"`, `inputMode="email"` — and a rule that has to be
 * repeated is a rule that gets missed. Measured before this change: `autoCapitalize` and
 * `autoCorrect` appeared **zero** times in the whole source tree. `spellCheck={false}` alone, which
 * two of these fields did carry, turns off neither on iOS.
 */
const IDENTIFIER_TYPES = new Set(['email', 'url', 'password'])
const IDENTIFIER_MODES = new Set(['email', 'url'])
const IDENTIFIER_AUTOCOMPLETE = /^(username|email|url|(new|current)-password|one-time-code)$/

function holdsAnIdentifier(props: InputHTMLAttributes<HTMLInputElement>): boolean {
  return (
    IDENTIFIER_TYPES.has(props.type ?? '') ||
    IDENTIFIER_MODES.has(props.inputMode ?? '') ||
    IDENTIFIER_AUTOCOMPLETE.test(props.autoComplete ?? '')
  )
}

/**
 * Styled text input. Deliberately just the control — labelling, hint and error text are the
 * caller's job (associate a `<label htmlFor>` and, for errors, `aria-describedby`), which
 * keeps it composable for the various forms across the app. Resting boundary uses
 * `--waxwing-border-strong` (>= 3:1); focus uses the global ring.
 *
 * One thing it does decide for the caller: a field that holds an address, a URL or a password gets
 * the software keyboard's capitalisation and autocorrection turned off — see above. Every part of
 * that is still overridable, because `rest` is spread last.
 */
export function TextInput({ invalid, className, ref, ...rest }: TextInputProps) {
  const identifier = holdsAnIdentifier(rest)
  return (
    <input
      ref={ref}
      className={cx(styles.input, invalid && styles.invalid, className)}
      aria-invalid={invalid || undefined}
      {...(identifier
        ? { autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false }
        : undefined)}
      {...rest}
    />
  )
}
