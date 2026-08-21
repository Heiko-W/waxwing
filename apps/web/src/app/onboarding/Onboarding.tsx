/**
 * Onboarding container (M1.4). Maps the {@link useSession} state onto the presentational
 * connect/sign-in forms and the boot/connect spinner, and renders the hoster branding links
 * (FR-THEME-02) beneath the card. It holds no logic of its own — every action delegates to the
 * session provider — so the flow is driven and tested through the provider, and the forms stay
 * pure. Rendered by {@link App} whenever the session is not yet `ready`; the branded product
 * name comes from config, never hardcoded.
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Dialog, Spinner } from '../../ui'
import { BrandLinks } from '../BrandLinks'
import { useConfig } from '../config-context'
import { useSession } from '../session/context'
import { ConnectForm } from './ConnectForm'
import { LoginForm } from './LoginForm'
import styles from './onboarding.module.css'

/**
 * Errors after which offering to delete everything would be worse than not offering it.
 *
 * A refused password is the one failure whose cause is known, is not local, and is one keystroke
 * from being fixed — putting "reset this app" under it invites someone who mistyped their password
 * to throw away their offline mail. Every other error, including the generic one, is a candidate
 * for "the local state is what is wrong", which is exactly the case with no other way out (U2).
 */
const CREDENTIAL_ERROR_KEYS: ReadonlySet<string> = new Set([
  'auth.error.invalidCredentials',
  'auth.error.invalidCredentialsBasic',
])

export function Onboarding() {
  const { t } = useTranslation()
  const {
    status,
    onboarding,
    submitConnect,
    chooseOAuth,
    submitBasic,
    editServer,
    wipeLocalState,
  } = useSession()
  const [resetOpen, setResetOpen] = useState(false)
  const branding = useConfig().branding
  const productName = branding.productName
  // Resolved against `document.baseURI`, like the shell header — the app can be mounted under any
  // prefix (`/webmail/`), and a root-relative path would 404 there. An empty configured value means
  // "no logo", which a hoster is allowed to want.
  const logoSrc = branding.logo ? new URL(branding.logo, document.baseURI).href : undefined

  if (status === 'booting' || status === 'connecting' || !onboarding) {
    return (
      <div className={styles.loading}>
        <Spinner />
      </div>
    )
  }

  const form =
    onboarding.step === 'connect' ? (
      <ConnectForm
        productName={productName}
        busy={onboarding.busy}
        onSubmit={submitConnect}
        {...(onboarding.error ? { error: onboarding.error } : {})}
      />
    ) : onboarding.target ? (
      <LoginForm
        target={onboarding.target}
        productName={productName}
        {...(logoSrc !== undefined ? { logoSrc } : {})}
        methods={onboarding.methods}
        oauthAvailable={onboarding.oauthAvailable}
        canEditServer={onboarding.canEditServer}
        busy={onboarding.busy}
        onOAuth={chooseOAuth}
        onBasicSubmit={submitBasic}
        {...(onboarding.canEditServer ? { onBack: editServer } : {})}
        {...(onboarding.error ? { error: onboarding.error } : {})}
      />
    ) : (
      <Spinner />
    )

  /*
   * THE WAY OUT OF A SCREEN THAT WILL NOT LET YOU PAST IT (U2).
   *
   * An error here can mean the app cannot start at all — observed with stale local state and no
   * failed request anywhere — and until now the screen offered nothing but the button that had just
   * failed. The only known remedy was deleting IndexedDB and localStorage by hand in the browser's
   * developer tools: an instruction for an operator, not for a user.
   *
   * It appears only once something HAS gone wrong, and never under a rejected credential — a
   * permanent "delete everything" under a sign-in form is an invitation, not an affordance. The
   * dialog is the exception to this project's "undo beats confirm": there is nothing to undo
   * afterwards, so the sentence has to arrive before the click.
   */
  const canReset = onboarding.error !== null && !CREDENTIAL_ERROR_KEYS.has(onboarding.error.key)

  return (
    <div className={styles.page}>
      {/* A <main>, because sign-in is a full page and not a fragment of one. Without it the screen
          has no main landmark at all — `landmark-one-main` — so landmark navigation has nothing to
          jump to, on the one screen every single user passes through. */}
      <main className={styles.stack}>
        {form}
        {canReset && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={styles.reset}
            onClick={() => setResetOpen(true)}
          >
            {t('onboarding.reset.action')}
          </Button>
        )}
        <BrandLinks className={styles.footer} />
      </main>
      {resetOpen && (
        <Dialog
          open
          title={t('onboarding.reset.title')}
          onClose={() => setResetOpen(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setResetOpen(false)}>
                {t('onboarding.reset.cancel')}
              </Button>
              <Button variant="destructive" onClick={wipeLocalState}>
                {t('onboarding.reset.confirm')}
              </Button>
            </>
          }
        >
          <p>{t('onboarding.reset.body', { product: productName })}</p>
        </Dialog>
      )}
    </div>
  )
}
