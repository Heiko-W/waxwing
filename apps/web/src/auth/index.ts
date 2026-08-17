/**
 * Waxwing auth module (SP.2, FR-AUTH-01..06, NFR-SEC-02).
 *
 * OAuth 2.0 Authorization-Code + PKCE (oauth4webapi) with an HTTP Basic fallback behind the
 * same `@waxwing/jmap` auth-scheme abstraction; access token in memory, refresh token
 * wrapped at rest by a non-extractable WebCrypto key. The app drives the
 * {@link AuthController}; UI lives in SP.4/M1.4.
 */

export type { AuthControllerOptions } from './controller'
export { AuthController, computeRedirectUri, isLoopbackHttp } from './controller'
export {
  AuthConfigError,
  AuthError,
  AuthExpiredError,
  OAuthCallbackError,
  SecretStoreBlockedError,
} from './errors'
export type {
  AuthorizationUrlInput,
  OAuthDeps,
  PkceTransaction,
  ResolvedOAuthConfig,
  TokenResult,
} from './oauth'
export {
  buildAuthorizationUrl,
  DEFAULT_CLIENT_ID,
  DEFAULT_SCOPES,
} from './oauth'
export type { SecretStoreOptions } from './secret-store'
export { SecretName, SecretStore } from './secret-store'
export type { TokenStoreOptions } from './token-store'
export { TokenStore } from './token-store'
export type {
  AuthMethod,
  AuthSession,
  BasicCredentials,
  DiscoveryAlgorithm,
  LoginRequest,
  LogoutOptions,
  OAuthConfig,
  StartLoginResult,
} from './types'
export type { WipeEnvironment } from './wipe'
export { wipeLocalData } from './wipe'
