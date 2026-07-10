/**
 * Pure session/onboarding state machine (M1.4). All transitions live here so they unit-test
 * without React or async I/O; the {@link SessionProvider} owns the impure orchestration
 * (probe, connect, AuthController) and dispatches these actions.
 *
 * `makeSessionReducer(env)` bakes in the deployment's enabled methods + OAuth availability so
 * a `showLogin` action carries only the resolved target — the view is derived here, keeping
 * the provider from re-deriving it at every call site.
 */

import type { AuthMethod } from '../../auth'
import type {
  ConnectedSession,
  ConnectTarget,
  OnboardError,
  OnboardingView,
  ReauthState,
} from './types'

/** Deployment-fixed inputs to the onboarding view (from config + secure-context check). */
export interface OnboardEnv {
  readonly methods: readonly AuthMethod[]
  readonly oauthAvailable: boolean
}

export type SessionState =
  | { readonly status: 'booting' }
  | { readonly status: 'onboarding'; readonly view: OnboardingView }
  | { readonly status: 'connecting' }
  | {
      readonly status: 'ready'
      readonly connected: ConnectedSession
      readonly reauth: ReauthState | null
    }

export type SessionAction =
  | { readonly type: 'showConnect'; readonly error?: OnboardError }
  | {
      readonly type: 'showLogin'
      readonly target: ConnectTarget
      readonly canEditServer: boolean
      readonly error?: OnboardError
    }
  | { readonly type: 'submitBusy' }
  | { readonly type: 'loginError'; readonly error: OnboardError }
  | { readonly type: 'connecting' }
  | { readonly type: 'connected'; readonly connected: ConnectedSession }
  | {
      readonly type: 'reauthRequired'
      readonly method: AuthMethod
      readonly requiresRedirect: boolean
    }
  | { readonly type: 'reauthBusy' }
  | { readonly type: 'reauthError'; readonly error: OnboardError }
  | { readonly type: 'reauthCleared' }
  | { readonly type: 'reconnected'; readonly connected: ConnectedSession }

export const INITIAL_SESSION_STATE: SessionState = { status: 'booting' }

function connectView(error: OnboardError | null): OnboardingView {
  return {
    step: 'connect',
    target: null,
    methods: [],
    oauthAvailable: false,
    canEditServer: true,
    busy: false,
    error,
  }
}

function loginView(
  env: OnboardEnv,
  target: ConnectTarget,
  canEditServer: boolean,
  error: OnboardError | null,
): OnboardingView {
  return {
    step: 'login',
    target,
    methods: env.methods,
    oauthAvailable: env.oauthAvailable,
    canEditServer,
    busy: false,
    error,
  }
}

export function makeSessionReducer(env: OnboardEnv) {
  return function reduce(state: SessionState, action: SessionAction): SessionState {
    switch (action.type) {
      case 'showConnect':
        return { status: 'onboarding', view: connectView(action.error ?? null) }
      case 'showLogin':
        return {
          status: 'onboarding',
          view: loginView(env, action.target, action.canEditServer, action.error ?? null),
        }
      case 'submitBusy':
        if (state.status !== 'onboarding') return state
        return { status: 'onboarding', view: { ...state.view, busy: true, error: null } }
      case 'loginError':
        if (state.status !== 'onboarding') return state
        return { status: 'onboarding', view: { ...state.view, busy: false, error: action.error } }
      case 'connecting':
        return { status: 'connecting' }
      case 'connected':
        return { status: 'ready', connected: action.connected, reauth: null }
      case 'reauthRequired':
        // Idempotent: many parallel failing calls flip the overlay only once (FR-AUTH-06).
        if (state.status !== 'ready' || state.reauth) return state
        return {
          ...state,
          reauth: {
            method: action.method,
            requiresRedirect: action.requiresRedirect,
            busy: false,
            error: null,
          },
        }
      case 'reauthBusy':
        if (state.status !== 'ready' || !state.reauth) return state
        return { ...state, reauth: { ...state.reauth, busy: true, error: null } }
      case 'reauthError':
        if (state.status !== 'ready' || !state.reauth) return state
        return { ...state, reauth: { ...state.reauth, busy: false, error: action.error } }
      case 'reauthCleared':
        if (state.status !== 'ready') return state
        return { ...state, reauth: null }
      case 'reconnected':
        return { status: 'ready', connected: action.connected, reauth: null }
    }
  }
}
