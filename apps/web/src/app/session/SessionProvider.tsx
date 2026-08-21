/**
 * SessionProvider (M1.4) — owns the whole authenticated lifecycle above the router: the boot
 * decision tree (OAuth callback → restore → pinned → same-origin probe → manual connect,
 * FR-AUTH-01/02), sign-in (OAuth/Basic, FR-AUTH-03/04), re-auth without losing state
 * (FR-AUTH-06) and sign-out (FR-AUTH-05). It holds the single {@link AuthController} and the
 * connected {@link JmapClient} in refs so identity is stable across renders and the M1.3 sync
 * engine can pull the current client out of React.
 *
 * All pure transitions live in {@link makeSessionReducer}; this component is the impure shell
 * (probe, connect, controller, storage, navigation) that dispatches them. Every browser
 * boundary is reached through the injectable {@link useServices} seam, so the flow is
 * hermetically testable with no network and no real WebCrypto.
 */

import type { AuthProvider, JmapClient, MailAccount } from '@waxwing/jmap'
import { httpStatusOf, JmapSessionOriginError, secondaryMailAccounts } from '@waxwing/jmap'
import { type ReactNode, useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import type { AuthController } from '../../auth'
import { AuthConfigError, AuthExpiredError } from '../../auth'
import { deriveScope } from '../../auth/account-registry'
import { registerAccount } from '../../auth/use-account-registry'
import { resetMailScopedStores, useActiveAccountStore } from '../../mail/active-account'
import { closeAllNotifications } from '../../notify'
import { tearDownPushSubscription } from '../../notify/push-subscribe'
import { getPushRegistration } from '../../notify/registration'
import { probeSharedAreas } from '../../sharing/probe'
import {
  currentReplicaName,
  getReplica,
  newEphemeralDbName,
  releaseEphemeralClaim,
  resetReplica,
  resetStorageFull,
  setReplicaName,
  sweepEphemeral,
  wipeReplica,
} from '../../sync'
import { stopAllEngines } from '../../sync/engine'
import type { AuthMethod, WaxwingConfig } from '../config'
import { useServices } from '../services'
import { deriveDelegation } from './accounts'
import { SessionContext } from './context'
import {
  INITIAL_SESSION_STATE,
  makeSessionReducer,
  type OnboardEnv,
  type SessionAction,
} from './reducer'
import { InvalidTargetError, pinnedTarget, resolveManualTarget, sameOriginTarget } from './target'
import type { ConnectedSession, ConnectTarget, OnboardError, SessionContextValue } from './types'
import { reauthProvider } from './withReauth'

const JMAP_MAIL = 'urn:ietf:params:jmap:mail'
/** One-shot OAuth handshake stash (tab-scoped, auto-clears): survives the redirect leg. */
const STASH_TARGET_KEY = 'waxwing.onboard.target'
const STASH_ROUTE_KEY = 'waxwing.onboard.route'
/**
 * The public-computer choice across the OAuth redirect leg (FR-AUTH-09). Not a credential — a
 * boolean the user ticked — and it has to survive a full-page navigation that destroys every ref in
 * this component, which is exactly what `sessionStorage` is for. The AUTH side of the same choice
 * travels separately, inside the PKCE transaction, because only the controller can act on it.
 */
const STASH_PUBLIC_KEY = 'waxwing.onboard.publicComputer'
/** Durable last-connected target so a reload/restore reconnects to a manual server too. */
const DURABLE_TARGET_KEY = 'waxwing.connect.target'

class NoAccountError extends Error {
  constructor() {
    super('No mail account on this server')
    this.name = 'NoAccountError'
  }
}

function readStored<T>(store: Storage | undefined, key: string): T | null {
  try {
    const raw = store?.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function writeStored(store: Storage | undefined, key: string, value: unknown): void {
  try {
    store?.setItem(key, JSON.stringify(value))
  } catch {
    // Ignore storage failures (private mode / disabled).
  }
}

function removeStored(store: Storage | undefined, key: string): void {
  try {
    store?.removeItem(key)
  } catch {
    // Ignore.
  }
}

function session(): Storage | undefined {
  return typeof sessionStorage !== 'undefined' ? sessionStorage : undefined
}

function local(): Storage | undefined {
  return typeof localStorage !== 'undefined' ? localStorage : undefined
}

/** Server field is editable only for a manually-entered, non-pinned deployment. */
function canEditServer(config: WaxwingConfig, target: ConnectTarget): boolean {
  return !target.fromProbe && config.server.allowCustomServer && config.server.sessionUrl === null
}

/**
 * `host` names the server that was actually contacted, and it is worth threading through.
 *
 * A `TypeError` here is a failed fetch, and the message used to be "Check your connection and try
 * again" — which blames the reader's network for what is most often a right connection to the wrong
 * address. Waxwing derives the server from the email domain (`user@example.com` ->
 * `https://example.com`), and for anyone whose mail lives somewhere else that guess is simply
 * wrong. Naming the host turns an accusation into the one fact that lets the reader fix it, and the
 * server field is already editable.
 */
function errToOnboard(error: unknown, host?: string, basic = false): OnboardError {
  if (error instanceof NoAccountError) return { key: 'onboarding.error.noAccount' }
  /*
   * The one error that already knows exactly what is wrong, and used to be flattened into
   * "Something went wrong. Please try again." (U1).
   *
   * `packages/jmap` refuses a Session document whose `apiUrl`/`downloadUrl`/… names a different
   * origin than the one that served it, because every request would attach the Authorization
   * header to that foreign host. The refusal is right and stays. What was wrong is that it threw
   * away the only three facts that make the misconfiguration fixable — which field, which URL, and
   * which origin the credential may go to — and left an operator with a sentence that describes
   * nothing and an instruction ("try again") that cannot help. Trying again produces the identical
   * refusal, forever.
   */
  if (error instanceof JmapSessionOriginError) {
    return {
      key: 'onboarding.error.sessionOrigin',
      values: { field: error.field, url: error.url, origin: error.expectedOrigin },
    }
  }
  /*
   * THE STATUS, NOT THE CLASS (U2).
   *
   * This read `error instanceof JmapHttpError` and never fired against a real server. Stalwart
   * answers a refused password with a JSON problem document, so `errorFromResponse` builds a
   * `JmapProblemError` — which is NOT a subclass of `JmapHttpError`; the hierarchy branches on the
   * shape of the BODY, not on the transport. A mistyped password therefore fell through every
   * branch of this function to "Something went wrong. Please try again.", and — because
   * `Onboarding` withholds its "reset this app" escape hatch by MATCHING THE TWO CREDENTIAL KEYS —
   * the one failure that must never offer to delete the local mailbox was the one that did.
   *
   * `httpStatusOf` spans all three status-carrying classes. Asking for the status is also the only
   * question this function actually has: what the server said, not which constructor the body
   * happened to select.
   */
  const status = httpStatusOf(error)
  if (status !== undefined) {
    if (status === 401 || status === 403) {
      // A 401 on the PASSWORD path has a second, likelier cause than a typo, and the reader
      // cannot see it: Stalwart accepts a second factor only over OAuth, so an account with
      // 2FA on has its correct password refused here and only an app password gets through.
      // Naming that turns a dead end into an instruction. The OAuth path keeps the plain
      // wording — there a 401 really is a rejected credential.
      return { key: basic ? 'auth.error.invalidCredentialsBasic' : 'auth.error.invalidCredentials' }
    }
    return { key: 'onboarding.error.generic' }
  }
  if (error instanceof AuthExpiredError) return { key: 'auth.error.generic' }
  if (error instanceof TypeError) {
    return host === undefined
      ? { key: 'onboarding.error.network' }
      : { key: 'onboarding.error.networkHost', values: { host } }
  }
  return { key: 'onboarding.error.generic' }
}

/**
 * OAuth failures specifically, because one of them is not a failure the reader caused.
 *
 * The sign-in screen offers whatever `config.server.auth` lists — the SERVER is never asked. So on
 * a deployment whose server has no OAuth, "Sign in securely" is the primary button, discovery
 * throws `AuthConfigError` on the click, and the reader got "Something went wrong. Please try
 * again." Trying again does the same thing, forever. (`docs/configuration.md` claimed "the first
 * one the server supports is the one offered"; nothing supported that.)
 *
 * Probing discovery before rendering was considered and rejected: OAuth runs through a redirect and
 * needs no CORS, while a `fetch` of the discovery document does — so a probe would hide a working
 * OAuth button on any server that omits CORS headers there. Saying what happened costs nothing and
 * cannot be wrong.
 */
function oauthErrToOnboard(error: unknown, methods: readonly AuthMethod[]): OnboardError {
  if (error instanceof AuthConfigError) {
    return methods.includes('basic')
      ? { key: 'onboarding.error.oauthUnavailable' }
      : { key: 'onboarding.error.oauthUnavailableNoFallback' }
  }
  return errToOnboard(error)
}

export interface SessionProviderProps {
  readonly config: WaxwingConfig
  readonly children: ReactNode
}

export function SessionProvider({ config, children }: SessionProviderProps) {
  const services = useServices()
  const oauthAvailable = useMemo(() => services.oauthIsAvailable(), [services])
  const env = useMemo<OnboardEnv>(
    () => ({ methods: config.server.auth, oauthAvailable }),
    [config.server.auth, oauthAvailable],
  )
  const reducer = useMemo(() => makeSessionReducer(env), [env])
  const [state, dispatch] = useReducer(reducer, INITIAL_SESSION_STATE)

  const stateRef = useRef(state)
  stateRef.current = state

  const controllerRef = useRef<AuthController | null>(null)
  const controllerIssuerRef = useRef<string | null>(null)
  const clientRef = useRef<JmapClient | null>(null)
  // The (reauth-wrapped) auth provider the client uses; the M1.3 sync engine reuses it for push.
  const authProviderRef = useRef<AuthProvider | null>(null)
  const targetRef = useRef<ConnectTarget | null>(null)
  const bootedRef = useRef(false)
  // Remembers the Basic "stay signed in" opt-in so a later re-auth (FR-AUTH-06) preserves it
  // instead of wiping the persisted credentials (FR-AUTH-04).
  const basicStayRef = useRef(false)
  /**
   * True for a public-computer session (FR-AUTH-09). A ref, not state: it is read on the sign-out
   * path and inside a `pagehide` listener, neither of which should re-render anything, and it must
   * not be stale in either.
   */
  const ephemeralRef = useRef(false)
  /**
   * The sign-out teardown that is still running behind the login form, or `null`.
   *
   * Since a sign-out clears the screen FIRST (see `endSession`), the login form is usable while
   * the wipe, the push teardown and the credential delete are still in flight — several seconds of
   * it. A sign-in started in that window would race the teardown: `resetReplica()`,
   * `releaseEphemeralClaim()` and `controllerRef.current = null` would land AFTER the new session
   * had opened and quietly dismantle it. Both sign-in paths await this first, so the race cannot
   * exist rather than being unlikely.
   */
  const teardownRef = useRef<Promise<void> | null>(null)

  /**
   * Switch this session to a throwaway replica (FR-AUTH-09). Shared by BOTH sign-in paths — the
   * checkbox used to be wired to Basic alone, so on a default deployment (where OAuth is the
   * primary button) ticking it produced a durable replica and a persisted refresh token while the
   * hint underneath promised the opposite.
   *
   * The ref is set only AFTER `setReplicaName` succeeded. The old order left `ephemeralRef` true
   * after a throw, which then wiped the NEXT — ordinary — session's mail on sign-out.
   */
  const markEphemeral = useCallback((): void => {
    if (ephemeralRef.current) return
    setReplicaName(newEphemeralDbName())
    ephemeralRef.current = true
  }, [])

  /**
   * Where to connect when nothing else decides: the pinned URL, the last one used, or this origin.
   *
   * It must not throw, and it used to. `pinnedTarget` runs `new URL()` on an operator-supplied
   * string and a durable target is whatever is in `localStorage`, so a malformed value threw inside
   * `boot()` — whose catch called this function AGAIN (with `targetRef` still null at boot), threw a
   * second time, and left an unhandled rejection out of `void boot()`. No error rendered and no
   * ErrorBoundary caught it (React boundaries do not see async rejections): the state stayed
   * `booting` and the user watched a spinner forever.
   *
   * `config.ts` now rejects an unparseable `sessionUrl` before it ever gets here, which removes the
   * known trigger. This removes the FAILURE MODE, which is the part that matters: a boot path whose
   * only error handler can itself throw has no error handling.
   */
  const fallbackTarget = useCallback((): ConnectTarget => {
    try {
      if (config.server.sessionUrl !== null) return pinnedTarget(config.server.sessionUrl)
      const durable = readStored<ConnectTarget>(local(), DURABLE_TARGET_KEY)
      if (durable) return durable
    } catch {
      // Fall through to the origin, which is always parseable in a browser.
    }
    return sameOriginTarget(window.location.origin)
  }, [config.server.sessionUrl])

  const ensureController = useCallback(
    (issuer: string): AuthController => {
      if (controllerRef.current && controllerIssuerRef.current === issuer) {
        return controllerRef.current
      }
      const controller = services.makeAuthController(issuer)
      controllerRef.current = controller
      controllerIssuerRef.current = issuer
      return controller
    },
    [services],
  )

  const reportAuthExpired = useCallback(() => {
    const current = stateRef.current
    if (current.status !== 'ready' || current.reauth) return
    dispatch({
      type: 'reauthRequired',
      method: current.connected.method,
      requiresRedirect: current.connected.method === 'oauth',
    })
  }, [])

  const connectSession = useCallback(
    async (
      controller: AuthController,
      target: ConnectTarget,
      method: ConnectedSession['method'],
    ): Promise<ConnectedSession> => {
      const provider = reauthProvider(controller.getAuthProvider(), reportAuthExpired)
      const client = await services.connect(target.connectUrl, provider)
      const jmapSession = client.session
      const accountId = jmapSession.primaryAccounts[JMAP_MAIL]
      if (accountId === undefined) throw new NoAccountError()
      clientRef.current = client
      authProviderRef.current = provider
      controllerRef.current = controller
      targetRef.current = target
      writeStored(local(), DURABLE_TARGET_KEY, target)
      // Lift EVERY account this session grants into the model (M4.4): the user's own account
      // first, then any delegated/shared one.
      const own = jmapSession.accounts[accountId]
      const primary: MailAccount = {
        id: accountId,
        name: own?.name ?? (jmapSession.username || accountId),
        isPersonal: own?.isPersonal ?? true,
        isReadOnly: own?.isReadOnly ?? false,
      }
      const advertised = secondaryMailAccounts(jmapSession, accountId)
      /*
       * ASK, once, before anything is built on the answer (S-4).
       *
       * The capability list is a false positive by construction: measured against Stalwart v0.16.18,
       * sharing ONE address book made the whole account appear with all seventeen capabilities,
       * `urn:ietf:params:jmap:mail` included. Deciding from it started a sync engine for an account
       * whose every `Mailbox/get` answers `forbidden`, and put a folder tree on screen that could
       * never fill.
       *
       * It belongs HERE rather than in the rail that noticed it first: the engine fleet reads
       * `connected.accounts` and never renders anything, so a probe living in the sidebar could not
       * reach it. One batch, one call per account and area, and only when something is actually
       * shared — `probeSharedAreas` sends nothing for an empty list, so the overwhelmingly common
       * single-account sign-in costs exactly what it did before.
       */
      const verdicts = await probeSharedAreas(
        client,
        advertised.map((account) => account.id),
      )
      const { accounts, delegated } = deriveDelegation(primary, advertised, verdicts)
      return {
        client,
        jmapSession,
        accountId,
        accounts,
        delegated,
        username: jmapSession.username || accountId,
        method,
      }
    },
    [services, reportAuthExpired],
  )

  const goToLogin = useCallback(
    (target: ConnectTarget, error?: OnboardError) => {
      targetRef.current = target
      const action: SessionAction = {
        type: 'showLogin',
        target,
        canEditServer: canEditServer(config, target),
        ...(error ? { error } : {}),
      }
      dispatch(action)
    },
    [config],
  )

  const boot = useCallback(async () => {
    try {
      // The handshake stash is single-use for the OAuth REDIRECT leg only. Read it, but the
      // controller issuer is irrelevant to the callback check (completeRedirect discovers from
      // the stored PKCE transaction, not the controller), so a stash issuer only seeds it.
      const stashed = readStored<ConnectTarget>(session(), STASH_TARGET_KEY)
      const controller = ensureController((stashed ?? fallbackTarget()).issuer)

      // A. OAuth redirect callback — highest priority (single-use PKCE transaction).
      if (await controller.isRedirectCallback()) {
        dispatch({ type: 'connecting' })
        removeStored(session(), STASH_TARGET_KEY)
        // BEFORE `connectSession` opens the replica (FR-AUTH-09). The redirect wiped every ref in
        // this component, so the choice is re-read from the tab-scoped stash rather than remembered.
        if (readStored<boolean>(session(), STASH_PUBLIC_KEY) === true) {
          markEphemeral()
        }
        removeStored(session(), STASH_PUBLIC_KEY)
        await controller.completeRedirect()
        // Restore the pre-redirect route BEFORE the router mounts (dispatch 'connected'),
        // since the OAuth redirect_uri strips back to the app root.
        const route = readStored<string>(session(), STASH_ROUTE_KEY)
        if (route) {
          try {
            window.history.replaceState(null, '', route)
          } catch {
            // Ignore — router falls back to the app root.
          }
          removeStored(session(), STASH_ROUTE_KEY)
        }
        const connected = await connectSession(controller, stashed ?? fallbackTarget(), 'oauth')
        dispatch({ type: 'connected', connected })
        return
      }

      // Not a callback: any lingering stash is from an ABANDONED OAuth flow and is stale. Drop
      // it so it can never drive a later wrong-server reconnect, and boot from the durable /
      // pinned / same-origin target instead.
      removeStored(session(), STASH_TARGET_KEY)
      removeStored(session(), STASH_ROUTE_KEY)
      const bootTarget = fallbackTarget()
      const activeController = ensureController(bootTarget.issuer)

      // B. Restore a persisted session (offline/cold start, FR-AUTH-03).
      const restored = await activeController.restore().catch(() => null)
      if (restored) {
        dispatch({ type: 'connecting' })
        // A restored session only exists because it was persisted (Basic = opt-in "stay signed
        // in"), so keep it durable across a later re-auth (FR-AUTH-04).
        if (restored.method === 'basic') basicStayRef.current = true
        const connected = await connectSession(activeController, bootTarget, restored.method)
        dispatch({ type: 'connected', connected })
        return
      }

      // C. Choose the onboarding entry.
      if (config.server.sessionUrl !== null) {
        goToLogin(pinnedTarget(config.server.sessionUrl))
        return
      }
      if (!config.server.allowCustomServer) {
        goToLogin(sameOriginTarget(window.location.origin))
        return
      }
      const present = await services.probe(window.location.origin)
      if (present) {
        goToLogin(sameOriginTarget(window.location.origin))
      } else {
        dispatch({ type: 'showConnect' })
      }
    } catch (error) {
      /*
       * NAMED, even when the message on screen cannot name it (U2).
       *
       * A start-up that fails without a single failed network call — stale local state was the
       * observed trigger, though which part of it was never established — reaches this catch and
       * renders whatever `errToOnboard` can make of it, which for an unrecognised error is the
       * generic sentence. The error object itself is the only thing that says more, and it was
       * being dropped here. One console line is not a fix, but it is the difference between a
       * report that says "it says something went wrong" and one that can be acted on.
       */
      console.error('[waxwing] start-up failed', error)
      goToLogin(targetRef.current ?? fallbackTarget(), errToOnboard(error))
    }
  }, [config, ensureController, connectSession, goToLogin, fallbackTarget, services, markEphemeral])

  // Boot exactly once. The ref guard is load-bearing: React 19 StrictMode double-invokes the
  // effect, and `completeRedirect()` consumes the single-use PKCE transaction, so a second run
  // would fall through to `restore()` and double-connect.
  useEffect(() => {
    if (bootedRef.current) return
    bootedRef.current = true
    void boot()
  }, [boot])

  const submitConnect = useCallback(
    (input: string) => {
      try {
        goToLogin(resolveManualTarget(input))
      } catch (error) {
        const onboardError: OnboardError =
          error instanceof InvalidTargetError
            ? { key: 'onboarding.error.generic' }
            : errToOnboard(error)
        dispatch({ type: 'showConnect', error: onboardError })
      }
    },
    [goToLogin],
  )

  const chooseOAuth = useCallback(
    (publicComputer = false) => {
      void (async () => {
        const current = stateRef.current
        const target = current.status === 'onboarding' ? current.view.target : null
        if (!target) return
        dispatch({ type: 'submitBusy' })
        // A sign-out clears the screen before it finishes cleaning up; see `teardownRef`.
        await teardownRef.current
        try {
          writeStored(session(), STASH_TARGET_KEY, target)
          // Two halves, because they are consumed by different owners after the redirect: the
          // controller needs it to keep the refresh token out of storage (it rides in the PKCE
          // transaction), and THIS component needs it to name the replica when the callback lands.
          if (publicComputer) writeStored(session(), STASH_PUBLIC_KEY, true)
          else removeStored(session(), STASH_PUBLIC_KEY)
          await ensureController(target.issuer).startLogin({ method: 'oauth', publicComputer })
        } catch (error) {
          removeStored(session(), STASH_PUBLIC_KEY)
          dispatch({ type: 'loginError', error: oauthErrToOnboard(error, config.server.auth) })
        }
      })()
    },
    [ensureController, config.server.auth],
  )

  // The crash guard and the tab-close attempt (FR-AUTH-09).
  //
  // `sweepEphemeral` runs at startup, before anything opens a session, and deletes every ephemeral
  // replica this profile knows about except the current one. That is what covers a crash, a killed
  // browser or a power cut — the cases `pagehide` cannot, because a page gets very little time
  // there and `deleteDatabase` is not guaranteed to finish. Both, therefore, not either.
  useEffect(() => {
    void sweepEphemeral(ephemeralRef.current ? currentReplicaName() : undefined).then((n) => {
      if (n > 0) console.info(`[waxwing] removed ${n} leftover public-computer database(s)`)
    })
    const onHide = () => {
      if (ephemeralRef.current) void wipeReplica(getReplica()).catch(() => {})
    }
    window.addEventListener('pagehide', onHide)
    return () => window.removeEventListener('pagehide', onHide)
  }, [])

  const submitBasic = useCallback(
    (username: string, password: string, staySignedIn: boolean, publicComputer = false) => {
      void (async () => {
        const current = stateRef.current
        const target = current.status === 'onboarding' ? current.view.target : null
        if (!target) return
        dispatch({ type: 'submitBusy' })
        // A sign-out clears the screen before it finishes cleaning up; see `teardownRef`. Awaited
        // BEFORE `markEphemeral` below, because the teardown's `resetReplica()` would undo it.
        await teardownRef.current
        try {
          // BEFORE any replica work (FR-AUTH-09). `setReplicaName` throws once a replica is open,
          // and the first `getReplica()` happens inside `connectSession` below — so this is the one
          // window in which the choice can still be honoured.
          if (publicComputer) markEphemeral()
          basicStayRef.current = staySignedIn
          const controller = ensureController(target.issuer)
          await controller.startLogin({ method: 'basic', username, password, staySignedIn })
          // Stay on the (busy) login step through connect, so a failure surfaces as a
          // loginError there rather than being swallowed from a 'connecting' state.
          const connected = await connectSession(controller, target, 'basic')
          dispatch({ type: 'connected', connected })
        } catch (error) {
          dispatch({ type: 'loginError', error: errToOnboard(error, target.displayHost, true) })
        }
      })()
    },
    [ensureController, connectSession, markEphemeral],
  )

  const editServer = useCallback(() => {
    dispatch({ type: 'showConnect' })
  }, [])

  const resolveReauthOAuth = useCallback(() => {
    void (async () => {
      const current = stateRef.current
      const target = targetRef.current
      if (current.status !== 'ready' || !current.reauth || !target) return
      dispatch({ type: 'reauthBusy' })
      try {
        writeStored(session(), STASH_TARGET_KEY, target)
        writeStored(session(), STASH_ROUTE_KEY, window.location.pathname)
        const controller = controllerRef.current ?? ensureController(target.issuer)
        await controller.startLogin({ method: 'oauth' })
      } catch (error) {
        dispatch({ type: 'reauthError', error: errToOnboard(error) })
      }
    })()
  }, [ensureController])

  const resolveReauthBasic = useCallback(
    (username: string, password: string) => {
      void (async () => {
        const current = stateRef.current
        const target = targetRef.current
        if (current.status !== 'ready' || !current.reauth || !target) return
        dispatch({ type: 'reauthBusy' })
        try {
          const controller = controllerRef.current ?? ensureController(target.issuer)
          // Preserve the original "stay signed in" choice so re-auth does not wipe a durable
          // session's persisted credentials (FR-AUTH-04).
          await controller.startLogin({
            method: 'basic',
            username,
            password,
            staySignedIn: basicStayRef.current,
          })
          const connected = await connectSession(controller, target, 'basic')
          dispatch({ type: 'reconnected', connected })
        } catch (error) {
          dispatch({ type: 'reauthError', error: errToOnboard(error, undefined, true) })
        }
      })()
    },
    [ensureController, connectSession],
  )

  const endSession = useCallback(
    (wipeData: boolean) => {
      /*
       * THE SCREEN IS CLEARED FIRST, AND EVERYTHING ELSE HAPPENS BEHIND THE LOGIN FORM.
       *
       * This used to be the last statement of the async block below, after stopping the sync
       * engines, wiping the replica, closing OS notifications, tearing down the push subscription
       * and awaiting the controller's logout. Measured against the fixture, that took a mean of
       * 6.1 s (4–8 s), and for all of it the menu had closed and NOTHING else had changed: the
       * account name in the header, the folder tree and the whole Inbox with its subject lines and
       * preview text stayed on screen. On a shared machine that is the worst moment this app has —
       * you press "Sign out", you walk away, and the mailbox stands open behind you for six
       * seconds.
       *
       * Clearing the display is also the only part that is instantaneous and cannot fail. The
       * teardown is I/O with locks, network calls and a database delete in it; it belongs behind
       * the login form, not in front of it. Nothing that stays on screen depends on it — the
       * in-memory session goes with this dispatch, every screen unmounts, and the refs below are
       * dropped in the same task.
       *
       * The one thing that must NOT overtake it is a new sign-in: `teardownRef` holds this promise
       * so `submitBasic`/`chooseOAuth` wait for it before opening a session that this teardown
       * would otherwise wipe out from under them.
       */
      goToLogin(targetRef.current ?? fallbackTarget())
      teardownRef.current = (async () => {
        // FR-AUTH-05 / FR-AUTH-06. Stop the sync engines and release their Web Locks BEFORE any wipe —
        // otherwise `deleteDatabase` blocks on an open Dexie/IndexedDB connection (M1.3). EVERY engine
        // (M4.4 Etappe 4): since the fleet, each shared account's engine holds a handle of its own, and
        // `SyncEngineHost`'s effect cleanup cannot run before this function awaits the wipe in the same
        // tick — so stopping only the primary left the wipe hanging on still-writing shared engines.
        await stopAllEngines()
        // Whether any part of "remove my data" failed. A sign-out always proceeds — the in-memory
        // session must go regardless — but the user is told when the local copy outlived it, rather
        // than being shown a login form that implies everything was cleaned up (FR-AUTH-05).
        let incomplete = false
        // An EPHEMERAL session always wipes, whichever sign-out was chosen (FR-AUTH-09). The whole
        // promise of public-computer mode is that leaving does not depend on picking the right menu
        // item on the way out — that is precisely the step someone in a hurry skips.
        if (wipeData || ephemeralRef.current) {
          await wipeReplica(getReplica()).catch(() => {
            incomplete = true
          })
        }
        // A notification is local data this app put on the OPERATING SYSTEM's screen, and the OS keeps
        // it there across sign-out, reload and browser restart. Wiping IndexedDB while three banners
        // reading "Alice Weber — Kündigung Arbeitsvertrag" sit in the notification centre would make a
        // liar of FR-AUTH-05, and clicking one would still deep-link into the mailbox we just left.
        await closeAllNotifications()
        // And the SUBSCRIPTION, not just the banners already on screen (M4.0). A Web Push
        // subscription lives on the SERVER and knows nothing about a sign-out: left in place, this
        // browser keeps waking up and announcing "New message" for a mailbox nobody is signed into —
        // possibly to the next person at the machine. It says nothing about the message, but it does
        // say this account still receives mail, and the click opens the app. Ordered before the
        // client is dropped below, because destroying the subscription is an authenticated call.
        await tearDownPushSubscription({
          registration: await getPushRegistration(),
          client: clientRef.current,
        })
        // The "storage is full" signal is a module singleton (M3.4): without this, a stale event from
        // the PREVIOUS session re-fires its toast on the next sign-in, whose notifier starts fresh.
        resetStorageFull()
        // The keyboard layer's state is module-scoped too (M3.8), and sign-out is an in-SPA
        // transition — the module graph survives it. Left alone, the NEXT account inherits this
        // account's list window: its selected email ids, its roving row, its open message's action
        // handlers. JMAP ids are per-account and short (`a`, `b`, …) and the window key carries no
        // account, so account B's Inbox key can be byte-identical to account A's — and one `e` would
        // then dispatch a move for account A's ids against account B's mailbox. The M4.4 account
        // SWITCH runs the very same reset for the identical reason, so both share one definition.
        resetMailScopedStores()
        // And the active-account pointer itself (M4.4): the next session's granted accounts may differ,
        // so a stale shared-account id must not carry over.
        useActiveAccountStore.getState().reset()
        // A rejected logout means the credential store is STILL on disk — another connection blocked
        // the delete. That is the one outcome this used to swallow entirely, and it is precisely the
        // one the user must hear about: the next cold start would restore the session they just
        // ended (SecretStoreBlockedError).
        await controllerRef.current?.logout(wipeData ? { wipeData: true } : {}).catch(() => {
          incomplete = true
        })
        clientRef.current = null
        authProviderRef.current = null
        controllerRef.current = null
        controllerIssuerRef.current = null
        // Back to the durable default, and give up the ephemeral claim, so the next sign-in in this
        // page load starts from a clean slate in BOTH directions (FR-AUTH-09).
        ephemeralRef.current = false
        releaseEphemeralClaim()
        resetReplica()
        removeStored(local(), DURABLE_TARGET_KEY)
        removeStored(session(), STASH_PUBLIC_KEY)
        // Only the BAD news arrives late, and it arrives on the login form the user is already
        // looking at: "your data is still on this machine" is not something to swallow because the
        // screen has moved on. A clean sign-out says nothing, which is what a clean sign-out looks
        // like everywhere else.
        if (incomplete) {
          dispatch({ type: 'loginError', error: { key: 'auth.error.signOutIncomplete' } })
        }
      })().catch((error: unknown) => {
        // Nothing awaits this for its own sake, and a rejection here would surface in whichever
        // sign-in happens to await `teardownRef` next — as a failure of THAT sign-in, which it is
        // not. Named in the console instead, where a start-up failure can be looked up.
        console.error('[waxwing] sign-out clean-up did not finish', error)
      })
    },
    [goToLogin, fallbackTarget],
  )

  /**
   * "Remove my data" for someone who never got in (U2). See {@link SessionContextValue.wipeLocalState}.
   *
   * Deliberately NOT routed through `endSession`: there is no session to end, no engine to stop and
   * no controller to log out — and `endSession`'s first act is to render the very screen this is
   * being triggered from. The service drops the storages and reloads; if the reload does not
   * happen the error stays on screen, which is the honest outcome.
   */
  const wipeLocalState = useCallback(() => {
    void services.resetLocalData().catch((error: unknown) => {
      console.error('[waxwing] resetting local data failed', error)
    })
  }, [services])

  const signOut = useCallback(() => endSession(false), [endSession])
  const signOutAndWipe = useCallback(() => endSession(true), [endSession])
  const cancelReauth = useCallback(() => endSession(false), [endSession])
  const getClient = useCallback(() => clientRef.current, [])
  const getAuthProvider = useCallback(() => authProviderRef.current, [])

  /**
   * Record the signed-in account in the registry (M5.14, FR-AUTH-07).
   *
   * An effect rather than part of the reducer: the registry is persisted state outside React, and
   * a reducer that wrote to `localStorage` would do it twice under StrictMode. `registerAccount`
   * is idempotent — the scope is derived from (issuer, username) — so a re-render, a reconnect or
   * a second tab all land on the same row rather than accumulating duplicates.
   *
   * The issuer is the JMAP API's ORIGIN rather than the OAuth issuer: it is present for Basic
   * sign-ins too, and it is what actually distinguishes two mailboxes with the same username.
   */
  const connectedForRegistry = state.status === 'ready' ? state.connected : null
  useEffect(() => {
    if (connectedForRegistry === null) return
    let origin: string | null = null
    try {
      origin = new URL(connectedForRegistry.jmapSession.apiUrl, window.location.href).origin
    } catch {
      origin = null
    }
    const username = connectedForRegistry.username
    registerAccount({
      scope: deriveScope(origin, username),
      issuer: origin,
      username,
      label: username,
      addedAt: Date.now(),
    })
  }, [connectedForRegistry])

  const value = useMemo<SessionContextValue>(() => {
    const onboarding = state.status === 'onboarding' ? state.view : null
    const connected = state.status === 'ready' ? state.connected : null
    const reauth = state.status === 'ready' ? state.reauth : null
    return {
      status: state.status,
      onboarding,
      connected,
      reauth,
      submitConnect,
      chooseOAuth,
      submitBasic,
      editServer,
      reportAuthExpired,
      resolveReauthOAuth,
      resolveReauthBasic,
      cancelReauth,
      signOut,
      signOutAndWipe,
      wipeLocalState,
      getClient,
      getAuthProvider,
    }
  }, [
    state,
    submitConnect,
    chooseOAuth,
    submitBasic,
    editServer,
    reportAuthExpired,
    resolveReauthOAuth,
    resolveReauthBasic,
    cancelReauth,
    signOut,
    signOutAndWipe,
    wipeLocalState,
    getClient,
    getAuthProvider,
  ])

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}
