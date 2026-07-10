import { type FormEvent, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, TextInput } from '../../ui'
import type { OnboardError } from '../session/types'
import styles from './onboarding.module.css'

export interface ConnectFormProps {
  /** Branding name (FR-THEME-02) — the product is never hardcoded in the view. */
  readonly productName: string
  /** Pre-fill (e.g. a value the user typed before a failed attempt). */
  readonly initialValue?: string
  readonly busy: boolean
  readonly error?: OnboardError
  /** Raw email/server string; the parent resolves it into a target (FR-AUTH-02). */
  readonly onSubmit: (emailOrServer: string) => void
}

/**
 * Manual connect step (FR-AUTH-02): the user names their mailbox by email address or server
 * URL. Purely presentational — the parent owns discovery and the resulting {@link ConnectTarget}
 * — so it unit-tests without any network or auth. The input accepts either form; validation
 * and reachability are the parent's job (a bad value comes back as `error`).
 */
export function ConnectForm({
  productName,
  initialValue,
  busy,
  error,
  onSubmit,
}: ConnectFormProps) {
  const { t } = useTranslation()
  const [value, setValue] = useState(initialValue ?? '')

  const id = useId()
  const inputId = `${id}-server`
  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  const headingId = `${id}-heading`
  const describedBy = error ? `${hintId} ${errorId}` : hintId

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    onSubmit(value.trim())
  }

  return (
    <section className={styles.card} aria-labelledby={headingId}>
      <h1 id={headingId} className={styles.heading}>
        {t('onboarding.welcome', { product: productName })}
      </h1>
      <p className={styles.subtitle}>{t('onboarding.connect.title')}</p>

      <form className={styles.form} onSubmit={handleSubmit} noValidate>
        <div className={styles.field}>
          <label className={styles.label} htmlFor={inputId}>
            {t('onboarding.connect.label')}
          </label>
          <TextInput
            id={inputId}
            type="text"
            inputMode="email"
            autoComplete="email"
            spellCheck={false}
            placeholder={t('onboarding.connect.placeholder')}
            value={value}
            invalid={error !== undefined}
            aria-describedby={describedBy}
            onChange={(event) => setValue(event.target.value)}
          />
          <p id={hintId} className={styles.hint}>
            {t('onboarding.connect.hint', { product: productName })}
          </p>
        </div>

        <div className={styles.errorRegion} aria-live="polite">
          {error ? (
            <p id={errorId} className={styles.error}>
              {t(error.key, error.values ?? {})}
            </p>
          ) : null}
        </div>

        <Button type="submit" variant="primary" block loading={busy}>
          {t('onboarding.connect.submit')}
        </Button>
      </form>
    </section>
  )
}
