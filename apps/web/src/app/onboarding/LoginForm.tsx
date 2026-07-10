import { type FormEvent, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AuthMethod } from '../../auth'
import { Button, Checkbox, TextInput } from '../../ui'
import type { ConnectTarget, OnboardError } from '../session/types'
import styles from './onboarding.module.css'

export interface LoginFormProps {
  readonly target: ConnectTarget
  /** Branding name (FR-THEME-02). */
  readonly productName: string
  /** Enabled methods in preference order; the first is the primary action. */
  readonly methods: readonly AuthMethod[]
  /** OAuth PKCE needs a secure context (`isSecureContext && crypto.subtle`). */
  readonly oauthAvailable: boolean
  /** False for a pinned/same-origin target — the "different server" link is hidden. */
  readonly canEditServer: boolean
  readonly busy: boolean
  readonly error?: OnboardError
  readonly onOAuth: () => void
  readonly onBasicSubmit: (username: string, password: string, staySignedIn: boolean) => void
  readonly onBack?: () => void
}

/**
 * Sign-in step (FR-AUTH-03 OAuth primary, FR-AUTH-04 Basic fallback). Presentational: it
 * renders whichever methods the deployment enabled and calls back with the user's intent; the
 * parent drives the {@link AuthController}. On an insecure origin `crypto.subtle` is absent so
 * OAuth PKCE cannot run — the OAuth button is then `aria-disabled` with an explanatory note and
 * a no-op click (mirrors the SP.4 demo), while Basic still works.
 */
export function LoginForm({
  target,
  methods,
  oauthAvailable,
  canEditServer,
  busy,
  error,
  onOAuth,
  onBasicSubmit,
  onBack,
}: LoginFormProps) {
  const { t } = useTranslation()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [staySignedIn, setStaySignedIn] = useState(false)

  const id = useId()
  const headingId = `${id}-heading`
  const usernameId = `${id}-username`
  const passwordId = `${id}-password`
  const oauthNoteId = `${id}-oauth-note`
  const errorId = `${id}-error`

  const hasOAuth = methods.includes('oauth')
  const hasBasic = methods.includes('basic')
  const oauthPrimary = methods[0] === 'oauth'

  function handleOAuth(): void {
    if (!oauthAvailable || busy) return
    onOAuth()
  }

  function handleBasicSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    onBasicSubmit(username, password, staySignedIn)
  }

  return (
    <section className={styles.card} aria-labelledby={headingId}>
      <h1 id={headingId} className={styles.heading}>
        {t('auth.signInTitle', { host: target.displayHost })}
      </h1>

      {/* Always mounted so the polite live region is already observed when the error text
          appears — a region inserted together with its content is not reliably announced. */}
      <div className={styles.errorRegion} aria-live="polite">
        {error ? (
          <p id={errorId} className={styles.error}>
            {t(error.key, error.values ?? {})}
          </p>
        ) : null}
      </div>

      {hasOAuth ? (
        <div className={styles.oauth}>
          <Button
            type="button"
            variant={oauthPrimary ? 'primary' : 'secondary'}
            block
            loading={busy}
            aria-disabled={!oauthAvailable || undefined}
            aria-describedby={oauthAvailable ? undefined : oauthNoteId}
            onClick={handleOAuth}
          >
            {t('auth.oauth.button')}
          </Button>
          {!oauthAvailable ? (
            <p id={oauthNoteId} className={styles.note}>
              {t('auth.oauth.unavailable')}
            </p>
          ) : null}
        </div>
      ) : null}

      {hasOAuth && hasBasic ? <div className={styles.separator} aria-hidden="true" /> : null}

      {hasBasic ? (
        <form className={styles.form} onSubmit={handleBasicSubmit}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor={usernameId}>
              {t('auth.basic.username')}
            </label>
            <TextInput
              id={usernameId}
              type="text"
              autoComplete="username"
              spellCheck={false}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              required
            />
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor={passwordId}>
              {t('auth.basic.password')}
            </label>
            <TextInput
              id={passwordId}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </div>
          <Checkbox
            label={t('auth.basic.staySignedIn')}
            checked={staySignedIn}
            onChange={(event) => setStaySignedIn(event.target.checked)}
          />
          <p className={styles.hint}>{t('auth.basic.appPasswordHint')}</p>
          <Button
            type="submit"
            variant={oauthPrimary ? 'secondary' : 'primary'}
            block
            loading={busy}
          >
            {t('auth.basic.submit')}
          </Button>
        </form>
      ) : null}

      {canEditServer && onBack ? (
        <Button type="button" variant="ghost" onClick={onBack} className={styles.back}>
          {t('auth.back')}
        </Button>
      ) : null}
    </section>
  )
}
