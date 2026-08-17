/**
 * Session/onboarding public types (M1.4). The onboarding UI, the shell chrome and the
 * feature panes all consume a single {@link SessionContextValue}; the {@link SessionProvider}
 * implements it. Keeping the surface here lets presentational components (ConnectForm,
 * LoginForm, ReauthDialog, AccountMenu) import types without importing the provider.
 */

import type { AuthProvider, JmapClient, MailAccount } from '@waxwing/jmap'
import type { AuthMethod } from '../../auth'

/** A JMAP `Session` as the client exposes it (avoids naming the wire type directly). */
export type JmapSession = JmapClient['session']

/** A localized error: an i18n key plus optional interpolation values (translated by the view). */
export interface OnboardError {
  readonly key: string
  readonly values?: Readonly<Record<string, string | number>>
}

/**
 * Resolved server target: the connect() input AND the OAuth issuer, reconciled once so the
 * OAuth callback leg reconnects to the same server (FR-AUTH-01/02).
 */
export interface ConnectTarget {
  /** Input to `@waxwing/jmap` `connect()` — an origin, a pinned session URL, or a well-known URL. */
  readonly connectUrl: string
  /** Absolute origin for OAuth discovery (`AuthController` `oauth.issuer`). */
  readonly issuer: string
  /** Host shown in "Sign in to {host}". */
  readonly displayHost: string
  /** True for FR-AUTH-01 same-origin autoconnect: the server field is never offered. */
  readonly fromProbe: boolean
}

export type SessionStatus = 'booting' | 'onboarding' | 'connecting' | 'ready'

/** What the onboarding UI renders while `status === 'onboarding'`. */
export interface OnboardingView {
  /** `connect` = manual server entry (FR-AUTH-02); `login` = choose OAuth/Basic. */
  readonly step: 'connect' | 'login'
  /** The resolved target (present in the `login` step). */
  readonly target: ConnectTarget | null
  /** Enabled sign-in methods in preference order (config.server.auth). */
  readonly methods: readonly AuthMethod[]
  /** OAuth PKCE needs a secure context (`isSecureContext && crypto.subtle`). */
  readonly oauthAvailable: boolean
  /** False when the target came from a pin or same-origin probe — no "different server" link. */
  readonly canEditServer: boolean
  readonly busy: boolean
  readonly error: OnboardError | null
}

/** The connected session M1.5/M1.6 and the sync engine consume. */
export interface ConnectedSession {
  readonly client: JmapClient
  readonly jmapSession: JmapSession
  /** `session.primaryAccounts['urn:ietf:params:jmap:mail']` — the user's own account. */
  readonly accountId: string
  /**
   * Every mail account this session grants, the user's own ({@link accountId}) FIRST followed by
   * the delegated/shared mailboxes (M4.4). Use {@link secondaryMailAccounts} to read just the
   * shared tail. `[accountId]` alone when the server shares nothing.
   */
  readonly accounts: readonly MailAccount[]
  readonly username: string
  readonly method: AuthMethod
}

/** Overlay state while a hard re-auth is pending; the shell stays mounted underneath (FR-AUTH-06). */
export interface ReauthState {
  readonly method: AuthMethod
  /** OAuth navigates the whole page; Basic resolves in place. */
  readonly requiresRedirect: boolean
  readonly busy: boolean
  readonly error: OnboardError | null
}

/** The single surface exposed via {@link useSession}. */
export interface SessionContextValue {
  readonly status: SessionStatus
  readonly onboarding: OnboardingView | null
  readonly connected: ConnectedSession | null
  readonly reauth: ReauthState | null

  // Onboarding (FR-AUTH-01/02/03/04).
  submitConnect(emailOrServer: string): void
  /** `publicComputer` (FR-AUTH-07) applies to OAuth exactly as it does to Basic. */
  chooseOAuth(publicComputer?: boolean): void
  submitBasic(
    username: string,
    password: string,
    staySignedIn: boolean,
    publicComputer?: boolean,
  ): void
  editServer(): void

  // Re-auth without losing state (FR-AUTH-06). `reportAuthExpired` is idempotent.
  reportAuthExpired(): void
  resolveReauthOAuth(): void
  resolveReauthBasic(username: string, password: string): void
  cancelReauth(): void

  // Sign-out (FR-AUTH-05).
  signOut(): void
  signOutAndWipe(): void

  /** Stable accessor for out-of-React consumers (M1.3 sync engine); null until connected. */
  getClient(): JmapClient | null
  /** The (reauth-wrapped) auth provider the client uses; the sync engine reuses it for push. */
  getAuthProvider(): AuthProvider | null
}
