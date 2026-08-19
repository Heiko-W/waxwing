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
import { JmapHttpError, secondaryMailAccounts } from '@waxwing/jmap'
import { type ReactNode, useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import type { AuthController } from '../../auth'
import { AuthConfigError, AuthExpiredError } from '../../auth'
import { deriveScope } from '../../auth/account-registry'
import { registerAccount } from '../../auth/use-account-registry'
import { resetMailScopedStores, useActiveAccountStore } from '../../mail/active-account'
import { closeAllNotifications } from '../../notify'
import { tearDownPushSubscription } from '../../notify/push-subscribe'
import { getPushRegistration } from '../../notify/registration'
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
function errToOnboard(error: unknown, host?: string): OnboardError {
  if (error instanceof NoAccountError) return { key: 'onboarding.error.noAccount' }
  if (error instanceof JmapHttpError) {
    if (error.status === 401 || error.status === 403) {
      return { key: 'auth.error.invalidCredentials' }
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
      // Lift EVERY mail account this session grants into the model (M4.4): the user's own account
      // first, then any delegated/shared mailboxes. Etappe 3 reads this; today nothing renders it.
      const own = jmapSession.accounts[accountId]
      const accounts: readonly MailAccount[] = [
        {
          id: accountId,
          name: own?.name ?? (jmapSession.username || accountId),
          isPersonal: own?.isPersonal ?? true,
          isReadOnly: own?.isReadOnly ?? false,
        },
        ...secondaryMailAccounts(jmapSession, accountId),
      ]
      return {
        client,
        jmapSession,
        accountId,
        accounts,
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
          dispatch({ type: 'loginError', error: errToOnboard(error, target.displayHost) })
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
          dispatch({ type: 'reauthError', error: errToOnboard(error) })
        }
      })()
    },
    [ensureController, connectSession],
  )

  const endSession = useCallback(
    (wipeData: boolean) => {
      void (async () => {
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
        goToLogin(
          targetRef.current ?? fallbackTarget(),
          incomplete ? { key: 'auth.error.signOutIncomplete' } : undefined,
        )
      })()
    },
    [goToLogin, fallbackTarget],
  )

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
    getClient,
    getAuthProvider,
  ])

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}
