/**
 * Public auth types (SP.2). The app (SP.4 throwaway UI, M1.4 real UX) drives an
 * {@link AuthController} through these; the JMAP client consumes the {@link AuthProvider}
 * exposed on the {@link AuthSession}.
 */

import type { AuthProvider } from '@waxwing/jmap'

/** The two supported sign-in methods (FR-AUTH-03 OAuth primary, FR-AUTH-04 Basic fallback). */
export type AuthMethod = 'oauth' | 'basic'

/**
 * Which discovery document to consume. `oauth2` = RFC 8414
 * (`/.well-known/oauth-authorization-server`, tech-stack §4.7); `oidc` =
 * `/.well-known/openid-configuration`. Default is `oauth2`.
 */
export type DiscoveryAlgorithm = 'oauth2' | 'oidc'

/** OAuth 2.0 Authorization-Code + PKCE configuration for a Stalwart (OIDC) server. */
export interface OAuthConfig {
  /** Issuer identifier, e.g. `https://mail.example.com` (RFC 8414 discovery base). */
  issuer: string
  /** Public client id. Stalwart needs no pre-registration by default (tech-stack §4.7). */
  clientId: string
  /** Requested scopes. `offline_access` is required to receive a refresh token. */
  scopes: string[]
  /**
   * Absolute redirect URI. Omit to derive it from `document.baseURI` at runtime so the same
   * static bundle works under any mount prefix (FR-DEP-02).
   */
  redirectUri?: string
  /** Discovery document to use. Defaults to `oauth2` (RFC 8414). */
  discovery?: DiscoveryAlgorithm
  /**
   * Permit plaintext-HTTP endpoints (local dev against http://localhost Stalwart). Omit to
   * auto-detect loopback; production is always HTTPS.
   */
  allowInsecureRequests?: boolean
}

/** Basic-auth (FR-AUTH-04) sign-in input. */
export interface BasicCredentials {
  username: string
  password: string
}

/**
 * Discriminated login request passed to {@link AuthController.startLogin}.
 *
 * `publicComputer` (FR-AUTH-09) is the OAuth counterpart of Basic's `staySignedIn: false`, and it
 * has to be its own flag rather than an absence: OAuth persists a refresh token unconditionally,
 * because that is what makes a silent cold start work. On a machine that is not the user's, that
 * durable credential is the whole problem — so the flag rides across the redirect inside the PKCE
 * transaction and makes the callback keep the refresh token in memory only.
 */
export type LoginRequest =
  | { method: 'oauth'; publicComputer?: boolean }
  | ({ method: 'basic'; staySignedIn?: boolean } & BasicCredentials)

/**
 * Result of {@link AuthController.startLogin}: OAuth navigates away (`redirect`), Basic
 * establishes a session synchronously (`session`).
 */
export type StartLoginResult =
  | { kind: 'redirect'; url: string }
  | { kind: 'session'; session: AuthSession }

/** Options for {@link AuthController.logout} (FR-AUTH-05). */
export interface LogoutOptions {
  /**
   * `false` (default) — "Sign out": revoke tokens where supported and drop credentials.
   * `true` — "Sign out & remove data": additionally wipe all IndexedDB, Cache Storage and
   * service-worker registrations for this origin.
   */
  wipeData?: boolean
}

/**
 * A typed snapshot of the active session. `authProvider` is injected into the JMAP client;
 * for OAuth it is `bearer(() => accessToken)` and transparently refreshes.
 */
export interface AuthSession {
  readonly method: AuthMethod
  /** Login name for Basic; may be `null` for OAuth until a JMAP session is fetched. */
  readonly username: string | null
  /** Access-token expiry (epoch ms) for OAuth; `null` for Basic or before the first token. */
  readonly expiresAt: number | null
  /** The auth-scheme provider to hand to `@waxwing/jmap`. */
  readonly authProvider: AuthProvider
}
