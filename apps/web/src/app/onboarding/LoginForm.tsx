import { ChevronDown } from 'lucide-react'
import { type FormEvent, useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AuthMethod } from '../../auth'
import { Button, Checkbox, TextInput } from '../../ui'
import type { ConnectTarget, OnboardError } from '../session/types'
import styles from './onboarding.module.css'

export interface LoginFormProps {
  readonly target: ConnectTarget
  /** Branding name (FR-THEME-02). */
  readonly productName: string
  /**
   * Resolved branding logo URL, or undefined when the hoster ships none. Carries the white-label
   * identity on the one screen whose heading names the SERVER rather than the product (B12).
   */
  readonly logoSrc?: string | undefined
  /** Enabled methods in preference order; the first is the primary action. */
  readonly methods: readonly AuthMethod[]
  /** OAuth PKCE needs a secure context (`isSecureContext && crypto.subtle`). */
  readonly oauthAvailable: boolean
  /** False for a pinned/same-origin target — the "different server" link is hidden. */
  readonly canEditServer: boolean
  readonly busy: boolean
  readonly error?: OnboardError
  readonly onOAuth: (publicComputer: boolean) => void
  readonly onBasicSubmit: (
    username: string,
    password: string,
    staySignedIn: boolean,
    publicComputer: boolean,
  ) => void
  /**
   * The device has no connection, so no sign-in can complete (FR-OFF-01).
   *
   * A prop, not a `useOnline()` call: this component is presentational by contract, and the
   * container already knows. It gates the OFFER only — the failure path behind it stays exactly
   * where it was, because `navigator.onLine` is a floor and not a guarantee.
   */
  readonly offline?: boolean
  readonly onBack?: () => void
}

/**
 * Sign-in step (FR-AUTH-03 OAuth primary, FR-AUTH-04 Basic fallback). Presentational: it
 * renders whichever methods the deployment enabled and calls back with the user's intent; the
 * parent drives the {@link AuthController}. On an insecure origin `crypto.subtle` is absent so
 * OAuth PKCE cannot run — the OAuth button is then `aria-disabled` with an explanatory note and
 * a no-op click (mirrors the SP.4 demo), while Basic still works.
 *
 * WHY THE TWO METHODS ARE NO LONGER SIDE BY SIDE. They were, as "Sign in securely" above a full
 * username/password form, and that presented a protocol detail as a choice the reader was
 * expected to make. It is not a choice: Stalwart accepts a second factor ONLY through OAuth
 * ("Two-factor authentication can only be used with mail clients that support OAuth and the
 * OAUTHBEARER or XOAUTH2 SASL mechanism"), so a reader with 2FA who picks the password form gets
 * their correct password refused with nothing on screen naming the reason. The password form is
 * therefore collapsed behind a disclosure whenever OAuth actually leads — one obvious action,
 * with the fallback still one click away for an app password.
 */
export function LoginForm({
  target,
  productName,
  logoSrc,
  methods,
  oauthAvailable,
  canEditServer,
  busy,
  error,
  onOAuth,
  onBasicSubmit,
  offline = false,
  onBack,
}: LoginFormProps) {
  const { t } = useTranslation()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [staySignedIn, setStaySignedIn] = useState(false)
  const [publicComputer, setPublicComputer] = useState(false)

  const id = useId()
  const headingId = `${id}-heading`
  const usernameId = `${id}-username`
  const passwordId = `${id}-password`
  const oauthNoteId = `${id}-oauth-note`
  const errorId = `${id}-error`
  const basicId = `${id}-basic`
  const basicOfflineId = `${id}-basic-offline`

  const hasOAuth = methods.includes('oauth')
  const hasBasic = methods.includes('basic')
  const oauthPrimary = methods[0] === 'oauth'
  /**
   * Whether OAuth is the way in on THIS load. Not the same as "the deployment lists oauth":
   * on an insecure origin PKCE cannot run at all, and a deployment may rank Basic first. In
   * both cases the password form is the primary path, so it is shown open and un-collapsible —
   * a disclosure the reader must find first would be a dead end, not a simplification.
   */
  const oauthLeads = hasOAuth && oauthAvailable && oauthPrimary
  const collapsible = hasBasic && oauthLeads
  const [basicOpen, setBasicOpen] = useState(!collapsible)
  const usernameRef = useRef<HTMLInputElement>(null)
  /** Set only by the disclosure click, so opening the form moves focus but the initial render never does. */
  const focusOnOpen = useRef(false)

  useEffect(() => {
    if (!basicOpen || !focusOnOpen.current) return
    focusOnOpen.current = false
    usernameRef.current?.focus()
  }, [basicOpen])

  function handleOAuth(): void {
    if (!oauthAvailable || offline || busy) return
    onOAuth(publicComputer)
  }

  function handleBasicSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    // A Return in the password field submits the form without the button necessarily seeing a
    // click, so the guard lives here as well as on the control.
    if (offline) return
    onBasicSubmit(username, password, staySignedIn, publicComputer)
  }

  function toggleBasic(): void {
    focusOnOpen.current = !basicOpen
    setBasicOpen((open) => !open)
  }

  const showBasicForm = hasBasic && (basicOpen || !collapsible)

  return (
    <section className={styles.card} aria-labelledby={headingId}>
      {/* The heading names the HOST, and the logo carries the brand — B12's two halves, which the
          previous layout could only satisfy one at a time. "Sign in to {product}" named the
          software on a screen whose only open question is WHICH SERVER am I about to hand my
          password to; dropping the product entirely left a white-label deployment unbranded at the
          one moment the user decides whether they are in the right place (FR-DEP-04). The logo says
          whose service this is without spending the headline on it, and its alt text is the
          configured name, so the identity reaches a screen reader too. */}
      {logoSrc ? <img className={styles.logo} src={logoSrc} alt={productName} /> : null}
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
            /* Primary until the reader opens the password form, then secondary. ADR-024's first
               decision is "one action leads" — it described the collapsed state, and the open one
               had two: a filled Sign in at the top and an outlined Sign in with a password at the
               bottom, where the outlined one is the one being used. The weight follows the
               choice. */
            variant={oauthPrimary && !basicOpen ? 'primary' : 'secondary'}
            block
            loading={busy}
            // Not a bare `aria-disabled`: that announced the refusal and left the button in full
            // primary blue, which is a promise to the eye that the attribute has just withdrawn.
            // Pre-existing for the insecure-origin case; the offline case inherited it.
            unavailable={!oauthAvailable || offline}
            aria-describedby={oauthAvailable && !offline ? undefined : oauthNoteId}
            onClick={handleOAuth}
          >
            {t('auth.oauth.button')}
          </Button>
          {/* What the button DOES, in the reader's terms: a redirect to their own server, where
              the password and the 2FA code are entered. Without it the redirect looks like the
              app losing them to a strange page. */}
          <p id={oauthNoteId} className={styles.note}>
            {/* Offline first, because it is the reason that applies TODAY: an insecure origin is a
                property of the deployment and will still be true tomorrow, while "you have no
                connection" is the one the reader can do something about. */}
            {offline
              ? t('onboarding.offline')
              : oauthAvailable
                ? t('auth.oauth.explain', { host: target.displayHost })
                : t('auth.oauth.unavailable')}
          </p>
        </div>
      ) : null}

      {collapsible ? (
        <Button
          type="button"
          variant="ghost"
          className={styles.disclosure}
          aria-expanded={basicOpen}
          aria-controls={basicId}
          onClick={toggleBasic}
        >
          {t('auth.basic.disclose')}
          {/* The same rotated glyph the folder tree uses, and for the reason written there:
              "Rotated, not exchanged. Swapping ChevronRight for ChevronDown says 'something
              changed'; turning the same glyph says WHAT changed". This used to be a CSS
              pseudo-element drawing its own triangle at 1.5px — the app's only hand-drawn glyph,
              beside a set whose strokes are 1.33-2px. */}
          <ChevronDown aria-hidden="true" className={styles.disclosureChevron} />
        </Button>
      ) : null}

      {showBasicForm ? (
        <form id={basicId} className={styles.form} onSubmit={handleBasicSubmit}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor={usernameId}>
              {t('auth.basic.username')}
            </label>
            <TextInput
              id={usernameId}
              ref={usernameRef}
              type="text"
              autoComplete="username"
              enterKeyHint="next"
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
              // Last field of the form; its Return key signs in.
              enterKeyHint="go"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </div>
          {/*
            THE CONSEQUENCE IS ON SCREEN, because the label alone could not carry it.

            "Stay signed in" reads, everywhere else on the web, as "across browser restarts" — so
            with the box UNticked people expect a reload to be harmless. Here it is not: without the
            opt-in nothing is persisted at all (`AuthController.startBasicLogin`: "Without opt-in,
            nothing survives a reload"), and pressing F5 lands back on this form. That is deliberate
            and stays — a password is written to this device only when its owner asks — but two of
            four reviewers of the same build filed the behaviour as a bug, and each of them named a
            DIFFERENT checkbox as the cause. When readers cannot tell which control did something,
            the control has not told them.

            So the sentence says what happens WITHOUT the tick, not what the tick is for: the state
            people are actually in when they read it is the unticked one. It is hidden while
            "public or shared computer" is on, where the box is disabled and its own hint already
            says that nothing is kept — one promise per screen, not two that overlap.
          */}
          <Checkbox
            label={t('auth.basic.staySignedIn')}
            checked={staySignedIn}
            disabled={publicComputer}
            onChange={(event) => setStaySignedIn(event.target.checked)}
          />
          {!publicComputer && !staySignedIn && (
            <p className={styles.hint}>{t('auth.basic.staySignedInHint')}</p>
          )}
          {/* Says what the server will DO, not what the reader "should" prefer: with 2FA on, the
              account password is refused here. The variant that points back up to the server
              sign-in is only honest when that button is on screen. */}
          <p className={styles.hint}>
            {hasOAuth ? t('auth.basic.appPasswordHintOAuth') : t('auth.basic.appPasswordHint')}
          </p>
          <Button
            type="submit"
            variant={oauthPrimary && !basicOpen ? 'secondary' : 'primary'}
            block
            loading={busy}
            unavailable={offline}
            // The OAuth note above already carries the sentence when there is one; pointing at it
            // rather than repeating it is what keeps one screen to one statement — and what keeps
            // this from naming an element that is not rendered.
            aria-describedby={offline ? (hasOAuth ? oauthNoteId : basicOfflineId) : undefined}
          >
            {t('auth.basic.submit')}
          </Button>
          {/* Only when the OAuth button is not already carrying the same sentence three inches
              above: one screen, one statement. */}
          {offline && !hasOAuth ? (
            <p id={basicOfflineId} className={styles.note}>
              {t('onboarding.offline')}
            </p>
          ) : null}
        </form>
      ) : null}

      {/* FR-AUTH-09, and deliberately OUTSIDE the Basic form: it governs whichever way the user
          signs in. While it lived inside the form it reached `onBasicSubmit` only, so on a default
          deployment — where OAuth is the primary button sitting right above it — ticking the box
          and clicking that button produced a durable replica and a persisted refresh token, with
          the hint below still promising that nothing would be kept.

          Ticking it also turns "stay signed in" off and holds it off: the two make contradictory
          promises, and letting both be ticked would leave a credential behind on exactly the
          machine the other box is about not leaving anything on. */}
      <div className={styles.publicComputer}>
        <Checkbox
          label={t('auth.basic.publicComputer')}
          checked={publicComputer}
          onChange={(event) => {
            setPublicComputer(event.target.checked)
            if (event.target.checked) setStaySignedIn(false)
          }}
        />
        {publicComputer && (
          <p className={styles.hint}>
            {t('auth.basic.publicComputerHint', { product: productName })}
          </p>
        )}
      </div>

      {canEditServer && onBack ? (
        <Button type="button" variant="ghost" onClick={onBack} className={styles.back}>
          {t('auth.back')}
        </Button>
      ) : null}
    </section>
  )
}
