import { type FormEvent, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styles from './demo.module.css'

export interface LoginViewProps {
  serverUrl: string
  onServerUrlChange: (value: string) => void
  onBasicSubmit: (username: string, password: string) => void
  onOAuth: () => void
  /** `window.isSecureContext && crypto.subtle` — OAuth PKCE needs a secure context. */
  oauthAvailable: boolean
  defaultUsername: string
  defaultPassword: string
  busy: boolean
}

/**
 * Raw demo login. A real <form> with <label>ed inputs for Basic sign-in plus an OAuth
 * button. On an insecure origin (plain-http LAN IP) `crypto.subtle` is undefined, so PKCE
 * cannot run — the OAuth button is then marked `aria-disabled`, its click is a no-op, and a
 * translated note explains why (Basic still works). Purely presentational so it is unit- and
 * axe-testable without a JMAP client.
 */
export function LoginView(props: LoginViewProps) {
  const { t } = useTranslation()
  const [username, setUsername] = useState(props.defaultUsername)
  const [password, setPassword] = useState(props.defaultPassword)

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    props.onBasicSubmit(username, password)
  }

  function handleOAuth(): void {
    if (!props.oauthAvailable || props.busy) return
    props.onOAuth()
  }

  const oauthNoteId = 'demo-oauth-note'

  return (
    <section className={styles.card} aria-labelledby="demo-login-heading">
      <h2 id="demo-login-heading" className={styles.cardHeading}>
        {t('demo.login.heading')}
      </h2>
      <form className={styles.form} onSubmit={handleSubmit}>
        <div className={styles.field}>
          <label htmlFor="demo-server">{t('demo.login.server')}</label>
          <input
            id="demo-server"
            type="url"
            value={props.serverUrl}
            onChange={(event) => props.onServerUrlChange(event.target.value)}
            autoComplete="url"
            spellCheck={false}
          />
          <p className={styles.hint}>{t('demo.login.serverHint')}</p>
        </div>
        <div className={styles.field}>
          <label htmlFor="demo-username">{t('demo.login.username')}</label>
          <input
            id="demo-username"
            type="text"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            spellCheck={false}
            required
          />
        </div>
        <div className={styles.field}>
          <label htmlFor="demo-password">{t('demo.login.password')}</label>
          <input
            id="demo-password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
          />
        </div>
        <div className={styles.actions}>
          <button type="submit" className={styles.primary} disabled={props.busy}>
            {t('demo.login.signIn')}
          </button>
          <button
            type="button"
            className={styles.secondary}
            onClick={handleOAuth}
            aria-disabled={!props.oauthAvailable || props.busy || undefined}
            aria-describedby={props.oauthAvailable ? undefined : oauthNoteId}
          >
            {t('demo.login.oauth')}
          </button>
        </div>
        {!props.oauthAvailable && (
          <p id={oauthNoteId} className={styles.warning}>
            {t('demo.login.oauthUnavailable')}
          </p>
        )}
      </form>
    </section>
  )
}
