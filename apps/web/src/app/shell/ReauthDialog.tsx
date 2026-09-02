/**
 * Re-auth overlay (FR-AUTH-06). Rendered by {@link AppShell} while a hard re-auth is pending;
 * the shell stays MOUNTED behind this modal {@link Dialog}, so the route, selection and any
 * unsent work survive (the common token-expiry case is handled silently by the controller and
 * never reaches here). OAuth re-auth is a full-page redirect (the route is stashed and
 * restored); Basic re-auth re-enters credentials inline and reconnects in place. Declining
 * ("Sign out") signs out — and ONLY that button does.
 *
 * The dialog is deliberately not dismissible. Escape and the ✕ are the two gestures every reader
 * uses to mean "never mind", and here they were wired to `cancelReauth`, i.e. Sign out — for a
 * public-computer session, Sign out plus a wipe of the local copy — under a body text that
 * promises "your place is kept". A reflex press during a session that expired mid-read ended the
 * session; screen-reader users, for whom Escape is the standard way out of a modal, met it first.
 * There is no non-destructive dismissal to offer instead (the session IS gone), so the dialog
 * offers none, and the way out is its two labelled buttons.
 */

import { type FormEvent, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Dialog, TextInput } from '../../ui'
import { useSession } from '../session/context'
import styles from './shell.module.css'

/** Never invoked — {@link Dialog} calls `onClose` only for a dismissal, and this one has none. */
const noDismissal = (): void => {}

export function ReauthDialog() {
  const { t } = useTranslation()
  const { reauth, resolveReauthOAuth, resolveReauthBasic, cancelReauth } = useSession()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const usernameId = useId()
  const passwordId = useId()
  /**
   * Focus starts on "Sign in", not on the first focusable in DOM order — which, with the ✕ gone,
   * is "Sign out". A dialog that opens unannounced over what someone was reading must not put the
   * destructive button under the next Enter. (The Basic variant needs no override: its first
   * focusable is the username field, which is where a reader wants to be anyway.)
   */
  const submitRef = useRef<HTMLButtonElement>(null)

  if (!reauth) return null

  function handleBasicSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    resolveReauthBasic(username, password)
  }

  return (
    <Dialog
      open
      onClose={noDismissal}
      title={t('auth.reauth.title')}
      dismissible={false}
      {...(reauth.requiresRedirect
        ? {
            initialFocusRef: submitRef,
            footer: (
              <>
                <Button variant="secondary" onClick={cancelReauth}>
                  {t('auth.reauth.cancel')}
                </Button>
                <Button
                  ref={submitRef}
                  variant="primary"
                  loading={reauth.busy}
                  onClick={resolveReauthOAuth}
                >
                  {t('auth.reauth.submit')}
                </Button>
              </>
            ),
          }
        : {})}
    >
      <p>{t('auth.reauth.body')}</p>
      {reauth.error && (
        <p className={styles.reauthError} role="alert">
          {t(reauth.error.key, reauth.error.values ?? {})}
        </p>
      )}
      {!reauth.requiresRedirect && (
        <form className={styles.reauthForm} onSubmit={handleBasicSubmit}>
          <div className={styles.reauthField}>
            <label className={styles.reauthLabel} htmlFor={usernameId}>
              {t('auth.basic.username')}
            </label>
            <TextInput
              id={usernameId}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              required
            />
          </div>
          <div className={styles.reauthField}>
            <label className={styles.reauthLabel} htmlFor={passwordId}>
              {t('auth.basic.password')}
            </label>
            <TextInput
              id={passwordId}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
            />
          </div>
          <div className={styles.reauthActions}>
            <Button type="button" variant="secondary" onClick={cancelReauth}>
              {t('auth.reauth.cancel')}
            </Button>
            <Button type="submit" variant="primary" loading={reauth.busy}>
              {t('auth.reauth.submit')}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  )
}
