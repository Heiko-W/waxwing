/**
 * Onboarding container (M1.4). Maps the {@link useSession} state onto the presentational
 * connect/sign-in forms and the boot/connect spinner, and renders the hoster branding links
 * (FR-THEME-02) beneath the card. It holds no logic of its own — every action delegates to the
 * session provider — so the flow is driven and tested through the provider, and the forms stay
 * pure. Rendered by {@link App} whenever the session is not yet `ready`; the branded product
 * name comes from config, never hardcoded.
 */

import { Spinner } from '../../ui'
import { BrandLinks } from '../BrandLinks'
import { useConfig } from '../config-context'
import { useSession } from '../session/context'
import { ConnectForm } from './ConnectForm'
import { LoginForm } from './LoginForm'
import styles from './onboarding.module.css'

export function Onboarding() {
  const { status, onboarding, submitConnect, chooseOAuth, submitBasic, editServer } = useSession()
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

  return (
    <div className={styles.page}>
      {/* A <main>, because sign-in is a full page and not a fragment of one. Without it the screen
          has no main landmark at all — `landmark-one-main` — so landmark navigation has nothing to
          jump to, on the one screen every single user passes through. */}
      <main className={styles.stack}>
        {form}
        <BrandLinks className={styles.footer} />
      </main>
    </div>
  )
}
