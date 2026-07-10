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

import { type JmapClient, JmapHttpError } from '@waxwing/jmap'
import { type ReactNode, useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import type { AuthController } from '../../auth'
import { AuthExpiredError } from '../../auth'
import type { WaxwingConfig } from '../config'
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

function errToOnboard(error: unknown): OnboardError {
  if (error instanceof NoAccountError) return { key: 'onboarding.error.noAccount' }
  if (error instanceof JmapHttpError) {
    if (error.status === 401 || error.status === 403) {
      return { key: 'auth.error.invalidCredentials' }
    }
    return { key: 'onboarding.error.generic' }
  }
  if (error instanceof AuthExpiredError) return { key: 'auth.error.generic' }
  if (error instanceof TypeError) return { key: 'onboarding.error.network' }
  return { key: 'onboarding.error.generic' }
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
  const targetRef = useRef<ConnectTarget | null>(null)
  const bootedRef = useRef(false)
  // Remembers the Basic "stay signed in" opt-in so a later re-auth (FR-AUTH-06) preserves it
  // instead of wiping the persisted credentials (FR-AUTH-04).
  const basicStayRef = useRef(false)

  const fallbackTarget = useCallback((): ConnectTarget => {
    if (config.server.sessionUrl !== null) return pinnedTarget(config.server.sessionUrl)
    const durable = readStored<ConnectTarget>(local(), DURABLE_TARGET_KEY)
    return durable ?? sameOriginTarget(window.location.origin)
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
      controllerRef.current = controller
      targetRef.current = target
      writeStored(local(), DURABLE_TARGET_KEY, target)
      return {
        client,
        jmapSession,
        accountId,
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
      if (controller.isRedirectCallback()) {
        dispatch({ type: 'connecting' })
        removeStored(session(), STASH_TARGET_KEY)
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
  }, [config, ensureController, connectSession, goToLogin, fallbackTarget, services])

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

  const chooseOAuth = useCallback(() => {
    void (async () => {
      const current = stateRef.current
      const target = current.status === 'onboarding' ? current.view.target : null
      if (!target) return
      dispatch({ type: 'submitBusy' })
      try {
        writeStored(session(), STASH_TARGET_KEY, target)
        await ensureController(target.issuer).startLogin({ method: 'oauth' })
      } catch (error) {
        dispatch({ type: 'loginError', error: errToOnboard(error) })
      }
    })()
  }, [ensureController])

  const submitBasic = useCallback(
    (username: string, password: string, staySignedIn: boolean) => {
      void (async () => {
        const current = stateRef.current
        const target = current.status === 'onboarding' ? current.view.target : null
        if (!target) return
        dispatch({ type: 'submitBusy' })
        try {
          basicStayRef.current = staySignedIn
          const controller = ensureController(target.issuer)
          await controller.startLogin({ method: 'basic', username, password, staySignedIn })
          // Stay on the (busy) login step through connect, so a failure surfaces as a
          // loginError there rather than being swallowed from a 'connecting' state.
          const connected = await connectSession(controller, target, 'basic')
          dispatch({ type: 'connected', connected })
        } catch (error) {
          dispatch({ type: 'loginError', error: errToOnboard(error) })
        }
      })()
    },
    [ensureController, connectSession],
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
        // FR-AUTH-05. TODO(M1.3): stop the sync engine / release the Web Lock BEFORE a wipe,
        // or deleting IndexedDB blocks on the open Dexie connection.
        await controllerRef.current?.logout(wipeData ? { wipeData: true } : {}).catch(() => {})
        clientRef.current = null
        controllerRef.current = null
        controllerIssuerRef.current = null
        removeStored(local(), DURABLE_TARGET_KEY)
        goToLogin(targetRef.current ?? fallbackTarget())
      })()
    },
    [goToLogin, fallbackTarget],
  )

  const signOut = useCallback(() => endSession(false), [endSession])
  const signOutAndWipe = useCallback(() => endSession(true), [endSession])
  const cancelReauth = useCallback(() => endSession(false), [endSession])
  const getClient = useCallback(() => clientRef.current, [])

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
  ])

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}
