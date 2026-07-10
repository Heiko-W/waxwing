/**
 * Re-auth overlay (FR-AUTH-06). Rendered by {@link AppShell} while a hard re-auth is pending;
 * the shell stays MOUNTED behind this modal {@link Dialog}, so the route, selection and any
 * unsent work survive (the common token-expiry case is handled silently by the controller and
 * never reaches here). OAuth re-auth is a full-page redirect (the route is stashed and
 * restored); Basic re-auth re-enters credentials inline and reconnects in place. Declining
 * ("cancel") signs out.
 */

import { type FormEvent, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Dialog, TextInput } from '../../ui'
import { useSession } from '../session/context'
import styles from './shell.module.css'

export function ReauthDialog() {
  const { t } = useTranslation()
  const { reauth, resolveReauthOAuth, resolveReauthBasic, cancelReauth } = useSession()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const usernameId = useId()
  const passwordId = useId()

  if (!reauth) return null

  function handleBasicSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    resolveReauthBasic(username, password)
  }

  return (
    <Dialog
      open
      onClose={cancelReauth}
      title={t('auth.reauth.title')}
      dismissOnBackdrop={false}
      {...(reauth.requiresRedirect
        ? {
            footer: (
              <>
                <Button variant="secondary" onClick={cancelReauth}>
                  {t('auth.reauth.cancel')}
                </Button>
                <Button variant="primary" loading={reauth.busy} onClick={resolveReauthOAuth}>
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
