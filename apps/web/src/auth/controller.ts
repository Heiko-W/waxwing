/**
 * {@link AuthController} — the small, typed auth surface the app drives (SP.4 throwaway UI,
 * M1.4 real UX). It orchestrates OAuth (discovery → redirect → callback → silent refresh),
 * the Basic-auth fallback, token storage and logout, and exposes the `@waxwing/jmap`
 * {@link AuthProvider} to inject into the client.
 *
 * UI is deliberately out of scope: every browser side effect (navigation, `location.href`,
 * history rewrite, data wipe) is an injectable hook so this is fully unit-testable.
 */

import type { AuthProvider } from '@waxwing/jmap'
import { basic, bearer } from '@waxwing/jmap'
import type { AuthorizationServer } from 'oauth4webapi'
import { AuthConfigError, AuthError, AuthExpiredError, OAuthCallbackError } from './errors'
import {
  beginAuthorization,
  completeAuthorization,
  DEFAULT_CLIENT_ID,
  DEFAULT_SCOPES,
  discover,
  isPermanentRefreshError,
  type OAuthDeps,
  type PkceTransaction,
  type ResolvedOAuthConfig,
  refreshTokens,
  revokeToken,
  type TokenResult,
} from './oauth'
import { SecretName, SecretStore } from './secret-store'
import { TokenStore } from './token-store'
import type {
  AuthMethod,
  AuthSession,
  BasicCredentials,
  LoginRequest,
  LogoutOptions,
  OAuthConfig,
  StartLoginResult,
} from './types'
import { type WipeEnvironment, wipeLocalData } from './wipe'

/** Persisted descriptor of the last session, used by {@link AuthController.restore}. */
interface AuthRecord {
  method: AuthMethod
  username: string | null
  oauth?: ResolvedOAuthConfig
}

/** Injectable construction options. All environment hooks default to browser globals. */
export interface AuthControllerOptions {
  /** OAuth config; required to use `method: 'oauth'`. Absent = Basic-only deployment. */
  oauth?: OAuthConfig
  /**
   * Account scope (FR-AUTH-07). Namespaces the default {@link SecretStore} so a future
   * second account is additive (no key/DB collision, no migration). V1 ships single sign-in
   * and omits it; ignored when a `store` is supplied. See docs/adr/004.
   */
  accountId?: string
  /** Encrypted secret store. Defaults to a fresh {@link SecretStore} over browser globals. */
  store?: SecretStore
  /** Token store options (clock, skew). */
  now?: () => number
  skewMs?: number
  /** Full-page redirect to the authorization endpoint. */
  navigate?: (url: string) => void
  /** Current URL (callback consumption). */
  getHref?: () => string
  /** `document.baseURI` — reflects Stalwart's `<base href>` rewrite (FR-DEP-02). */
  getBaseUri?: () => string
  /** Replace the URL after a callback to strip `code`/`state`. */
  replaceUrl?: (url: string) => void
  /** Surfaces wiped by "remove data" logout; defaults to browser globals. */
  wipe?: WipeEnvironment
}

export class AuthController {
  private readonly oauthConfig: OAuthConfig | undefined
  private readonly store: SecretStore
  private readonly tokens: TokenStore
  private readonly now: () => number
  private readonly navigate: (url: string) => void
  private readonly getHref: () => string
  private readonly getBaseUri: () => string
  private readonly replaceUrl: (url: string) => void
  private readonly wipeEnvOverride: WipeEnvironment | undefined

  private session: AuthSession | null = null
  private resolvedOAuth: ResolvedOAuthConfig | null = null
  private as: AuthorizationServer | null = null
  /** De-dupes concurrent {@link refresh} calls into one in-flight token grant. */
  private refreshInFlight: Promise<void> | null = null

  constructor(options: AuthControllerOptions = {}) {
    this.oauthConfig = options.oauth
    this.store =
      options.store ??
      new SecretStore(options.accountId !== undefined ? { scope: options.accountId } : {})
    const tokenOptions = options.skewMs !== undefined ? { skewMs: options.skewMs } : {}
    this.tokens = new TokenStore(this.store, {
      now: options.now ?? (() => Date.now()),
      ...tokenOptions,
    })
    this.now = options.now ?? (() => Date.now())
    this.navigate = options.navigate ?? ((url) => globalThis.location.assign(url))
    this.getHref = options.getHref ?? (() => globalThis.location.href)
    this.getBaseUri = options.getBaseUri ?? (() => globalThis.document.baseURI)
    this.replaceUrl =
      options.replaceUrl ?? ((url) => globalThis.history.replaceState(null, '', url))
    this.wipeEnvOverride = options.wipe
  }

  /** The current session snapshot, or `null` when signed out. */
  getSession(): AuthSession | null {
    return this.session
  }

  /** The `@waxwing/jmap` provider for the active session. Throws if signed out. */
  getAuthProvider(): AuthProvider {
    if (!this.session) throw new AuthError('No active session')
    return this.session.authProvider
  }

  /** Heuristic: does the current URL look like an OAuth redirect callback? */
  isRedirectCallback(): boolean {
    const params = new URL(this.getHref()).searchParams
    return params.has('code') || params.has('error')
  }

  /** Starts a login. OAuth navigates away (`redirect`); Basic returns a `session`. */
  startLogin(request: LoginRequest): Promise<StartLoginResult> {
    return request.method === 'basic' ? this.startBasicLogin(request) : this.startOAuthLogin()
  }

  private async startOAuthLogin(): Promise<StartLoginResult> {
    const config = this.requireResolvedOAuth()
    const as = await this.ensureDiscovery(config)
    const { url, transaction } = await beginAuthorization(as, config)
    await this.store.put(SecretName.PkceTransaction, JSON.stringify(transaction))
    this.navigate(url.href)
    return { kind: 'redirect', url: url.href }
  }

  private async startBasicLogin(
    request: Extract<LoginRequest, { method: 'basic' }>,
  ): Promise<StartLoginResult> {
    const credentials: BasicCredentials = {
      username: request.username,
      password: request.password,
    }
    const session = this.buildBasicSession(credentials)
    this.session = session
    // Persist only on opt-in ("stay signed in"), and only via the wrapped store — never
    // plaintext (FR-AUTH-04). Without opt-in, nothing survives a reload.
    if (request.staySignedIn) {
      await this.store.put(SecretName.BasicCredentials, JSON.stringify(credentials))
      await this.store.put(
        SecretName.AuthRecord,
        JSON.stringify({ method: 'basic', username: credentials.username } satisfies AuthRecord),
      )
    } else {
      await this.store.delete(SecretName.BasicCredentials)
      await this.store.delete(SecretName.AuthRecord)
    }
    return { kind: 'session', session }
  }

  /** Consumes the OAuth redirect: validates state/iss, exchanges the code, stores tokens. */
  async completeRedirect(): Promise<AuthSession> {
    try {
      const raw = await this.store.get(SecretName.PkceTransaction)
      if (!raw) throw new OAuthCallbackError('No pending authorization request')
      const transaction = JSON.parse(raw) as PkceTransaction
      const config = transaction.config
      const as = await this.ensureDiscovery(config)
      let result: TokenResult
      try {
        result = await completeAuthorization(as, transaction, this.getHref(), this.oauthDeps())
      } catch (error) {
        if (error instanceof AuthError) throw error
        throw new OAuthCallbackError('OAuth callback failed', { cause: error })
      } finally {
        // Single-use: drop the transaction whether or not the exchange succeeded.
        await this.store.delete(SecretName.PkceTransaction)
      }
      this.resolvedOAuth = config
      await this.tokens.apply(result)
      await this.store.put(
        SecretName.AuthRecord,
        JSON.stringify({ method: 'oauth', username: null, oauth: config } satisfies AuthRecord),
      )
      const session = this.buildOAuthSession(null, result.expiresAt)
      this.session = session
      return session
    } finally {
      // Scrub the one-time `code`/`state`/`error` params on EVERY exit path — success,
      // exchange failure (provider `?error=`, state/iss mismatch, token-endpoint failure),
      // or no pending transaction — so they never linger in the address bar or browser
      // history on a shared device (NFR-SEC-04).
      this.stripCallbackParams()
    }
  }

  /**
   * Returns a valid access token, refreshing silently when the cached one is missing or near
   * expiry. Throws {@link AuthExpiredError} when no token can be obtained (FR-AUTH-06).
   */
  async getAccessToken(): Promise<string> {
    if (this.tokens.isFresh()) {
      const token = this.tokens.getAccessToken()
      if (token) return token
    }
    await this.refresh()
    const token = this.tokens.getAccessToken()
    if (!token) throw new AuthExpiredError()
    return token
  }

  /**
   * Silent refresh from the persisted refresh token, single-flighted: concurrent callers
   * (parallel JMAP requests after the access token expires, or several fetches racing on an
   * offline cold start) share ONE token grant. Without this each fires its own
   * `refresh_token` grant; if the server rotates the refresh token (Stalwart does near
   * expiry) the first rotation invalidates the token the others still hold, failing them
   * with `invalid_grant` and tearing down an otherwise-valid session.
   */
  refresh(): Promise<void> {
    this.refreshInFlight ??= this.doRefresh().finally(() => {
      this.refreshInFlight = null
    })
    return this.refreshInFlight
  }

  private async doRefresh(): Promise<void> {
    const config = this.requireResolvedOAuth()
    const refreshToken = await this.tokens.getRefreshToken()
    if (!refreshToken) throw new AuthExpiredError('No refresh token available')
    const as = await this.ensureDiscovery(config)
    let result: TokenResult
    try {
      result = await refreshTokens(as, config, refreshToken, this.oauthDeps())
    } catch (error) {
      this.tokens.clearAccessToken()
      // On a TERMINAL grant rejection the refresh token is definitively dead, so also drop
      // it from storage: otherwise restore() keys off its mere presence and resurrects a
      // phantom session that re-fails on first use. Transient (network) errors keep the
      // token so a brief offline blip is not a permanent logout.
      if (isPermanentRefreshError(error)) await this.tokens.clear()
      throw new AuthExpiredError('Token refresh failed', { cause: error })
    }
    await this.tokens.apply(result)
    if (this.session?.method === 'oauth') {
      this.session = { ...this.session, expiresAt: result.expiresAt }
    }
  }

  /**
   * Restores a session on cold boot without a fresh login (offline start, FR-AUTH-03). For
   * OAuth the access token is fetched lazily on first {@link getAccessToken}; for Basic the
   * persisted (opt-in) credentials are re-loaded. Returns `null` when nothing is persisted.
   */
  async restore(): Promise<AuthSession | null> {
    const raw = await this.store.get(SecretName.AuthRecord)
    if (!raw) return null
    const record = JSON.parse(raw) as AuthRecord
    if (record.method === 'basic') {
      const credsRaw = await this.store.get(SecretName.BasicCredentials)
      if (!credsRaw) return null
      const credentials = JSON.parse(credsRaw) as BasicCredentials
      const session = this.buildBasicSession(credentials)
      this.session = session
      return session
    }
    if (!record.oauth) return null
    const refreshToken = await this.tokens.getRefreshToken()
    if (!refreshToken) return null
    this.resolvedOAuth = record.oauth
    const session = this.buildOAuthSession(record.username, null)
    this.session = session
    return session
  }

  /**
   * Logs out (FR-AUTH-05): best-effort token revocation where the server supports it, then a
   * full wipe of persisted credentials. With `{ wipeData: true }` ("Sign out & remove
   * data") it additionally clears all IndexedDB, Cache Storage and service-worker state.
   */
  async logout(options: LogoutOptions = {}): Promise<void> {
    if (this.resolvedOAuth && this.as) {
      const refreshToken = await this.tokens.getRefreshToken().catch(() => null)
      if (refreshToken) {
        await revokeToken(this.as, this.resolvedOAuth, refreshToken)
      }
    }
    this.session = null
    this.resolvedOAuth = null
    this.as = null
    this.tokens.clearAccessToken()
    // Destroy the encrypted store (refresh token, basic creds, PKCE, record + wrapping key).
    await this.store.wipe()
    if (options.wipeData) {
      await wipeLocalData(this.resolveWipeEnv())
    }
  }

  private buildOAuthSession(username: string | null, expiresAt: number | null): AuthSession {
    return {
      method: 'oauth',
      username,
      expiresAt,
      // The JMAP client pulls a fresh token per request via this closure (FR-AUTH-04 path).
      authProvider: bearer(() => this.getAccessToken()),
    }
  }

  private buildBasicSession(credentials: BasicCredentials): AuthSession {
    return {
      method: 'basic',
      username: credentials.username,
      expiresAt: null,
      authProvider: basic(credentials.username, credentials.password),
    }
  }

  private requireResolvedOAuth(): ResolvedOAuthConfig {
    if (this.resolvedOAuth) return this.resolvedOAuth
    if (!this.oauthConfig) throw new AuthConfigError('OAuth is not configured for this deployment')
    this.resolvedOAuth = this.resolveConfig(this.oauthConfig)
    return this.resolvedOAuth
  }

  private resolveConfig(config: OAuthConfig): ResolvedOAuthConfig {
    const scopes = config.scopes.length > 0 ? config.scopes : DEFAULT_SCOPES
    return {
      issuer: config.issuer,
      clientId: config.clientId || DEFAULT_CLIENT_ID,
      scopes,
      redirectUri: config.redirectUri ?? computeRedirectUri(this.getBaseUri()),
      discovery: config.discovery ?? 'oauth2',
      allowInsecureRequests: config.allowInsecureRequests ?? isLoopbackHttp(config.issuer),
    }
  }

  private async ensureDiscovery(config: ResolvedOAuthConfig): Promise<AuthorizationServer> {
    if (this.as) return this.as
    this.as = await discover(config)
    return this.as
  }

  private oauthDeps(): OAuthDeps {
    return { now: this.now }
  }

  private stripCallbackParams(): void {
    const url = new URL(this.getHref())
    for (const key of ['code', 'state', 'iss', 'error', 'error_description']) {
      url.searchParams.delete(key)
    }
    this.replaceUrl(url.href)
  }

  private resolveWipeEnv(): WipeEnvironment {
    if (this.wipeEnvOverride) return this.wipeEnvOverride
    return {
      caches: typeof caches !== 'undefined' ? caches : undefined,
      indexedDB: typeof indexedDB !== 'undefined' ? indexedDB : undefined,
      serviceWorker:
        typeof navigator !== 'undefined' && 'serviceWorker' in navigator
          ? navigator.serviceWorker
          : undefined,
    }
  }
}

/**
 * Derives the OAuth redirect URI from `document.baseURI` (query/hash stripped) so the same
 * static bundle redirects back to itself under any mount prefix (FR-DEP-02).
 */
export function computeRedirectUri(baseUri: string): string {
  const url = new URL(baseUri)
  url.search = ''
  url.hash = ''
  return url.href
}

/** True for `http://` loopback issuers (local dev) — enables oauth4webapi's insecure opt-in. */
export function isLoopbackHttp(issuer: string): boolean {
  try {
    const url = new URL(issuer)
    if (url.protocol !== 'http:') return false
    return (
      url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname === '[::1]' ||
      url.hostname === '::1'
    )
  } catch {
    return false
  }
}
