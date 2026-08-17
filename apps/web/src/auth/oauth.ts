/**
 * OAuth 2.0 Authorization-Code + PKCE against Stalwart's built-in OIDC provider, via
 * `oauth4webapi` v3 (FR-AUTH-03, tech-stack §4.7).
 *
 * This module is transport-only: pure discovery, authorization-URL construction, code
 * exchange, refresh and revocation. It never touches the DOM or storage — the
 * {@link AuthController} owns the redirect, PKCE persistence and token lifecycle. That keeps
 * the load-bearing bit ({@link buildAuthorizationUrl}) a pure, hermetically testable function.
 *
 * v3 note: client authentication is an explicit argument (`oauth.None()` for a public
 * client), not a `token_endpoint_auth_method` on the client object.
 */

import * as oauth from 'oauth4webapi'
import type { DiscoveryAlgorithm } from './types'

/** Default public client id. Stalwart requires no pre-registration by default. */
export const DEFAULT_CLIENT_ID = 'waxwing'

/**
 * Default scopes: JMAP mail access plus `offline_access` (required for a refresh token).
 * `openid` is intentionally omitted — we do not consume an id_token, so no OIDC id-token
 * validation is needed and the `oauth2` discovery path stays clean.
 */
export const DEFAULT_SCOPES = ['urn:ietf:params:oauth:scope:mail', 'offline_access']

/** A fully-resolved OAuth config (every field defaulted/derived by the controller). */
export interface ResolvedOAuthConfig {
  issuer: string
  clientId: string
  scopes: string[]
  redirectUri: string
  discovery: DiscoveryAlgorithm
  allowInsecureRequests: boolean
}

/**
 * Injectable side-effect dependencies for the OAuth requests. Network I/O goes through the
 * global `fetch` that oauth4webapi uses (hermetic tests stub the global), so only the clock
 * is injected here.
 */
export interface OAuthDeps {
  /** Monotonic-enough clock for expiry math. */
  now: () => number
}

/** Normalized token-endpoint result the controller stores. */
export interface TokenResult {
  accessToken: string
  expiresAt: number
  /** Present when the server issued (or we retain) a refresh token. */
  refreshToken?: string
}

/** Persisted single-use PKCE transaction, JSON-serialized across the redirect. */
export interface PkceTransaction {
  verifier: string
  state: string
  config: ResolvedOAuthConfig
  /**
   * The user ticked "public or shared computer" before being sent to the authorization server
   * (FR-AUTH-09). A full-page redirect destroys every bit of in-memory state, and this transaction
   * is the only thing that survives it — so the choice travels here, and the callback honours it by
   * keeping the refresh token in memory and writing no AuthRecord.
   */
  ephemeral?: boolean
  /** Epoch ms the transaction was created, so a stale one can be refused (see completeRedirect). */
  createdAt?: number
}

/** Pure inputs for {@link buildAuthorizationUrl}. */
export interface AuthorizationUrlInput {
  authorizationEndpoint: string
  clientId: string
  redirectUri: string
  scopes: string[]
  codeChallenge: string
  state: string
}

type HttpOptions = {
  [oauth.allowInsecureRequests]?: boolean
}

function httpOptions(config: ResolvedOAuthConfig): HttpOptions {
  const options: HttpOptions = {}
  if (config.allowInsecureRequests) options[oauth.allowInsecureRequests] = true
  return options
}

function client(config: ResolvedOAuthConfig): oauth.Client {
  return { client_id: config.clientId }
}

/**
 * Drops an **unsolicited** `id_token` from a token-endpoint response before oauth4webapi
 * processes it.
 *
 * We run the pure-OAuth2 flow (`openid` intentionally not requested — see
 * {@link DEFAULT_SCOPES}) and never consume an id_token. Stalwart nonetheless returns one
 * (ES256) from `/auth/token` on both the code exchange and refresh. oauth4webapi validates
 * any id_token it sees; because our RFC 8414 metadata omits
 * `id_token_signing_alg_values_supported`, it defaults the expected id_token alg to RS256
 * and rejects Stalwart's ES256 token with `unexpected JWT "alg" header parameter`, aborting
 * an otherwise-successful exchange. Stripping the field keeps us cleanly on the OAuth2 path.
 *
 * Only rebuilds the response when a JSON body actually carries `id_token` (the success
 * case); error responses (no `id_token`) pass through untouched so OAuth error bodies still
 * surface as `oauth.ResponseBodyError` for {@link isPermanentRefreshError}.
 */
async function stripUnsolicitedIdToken(response: Response): Promise<Response> {
  if (!(response.headers.get('content-type') ?? '').includes('json')) return response
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => null)
  if (body === null || typeof body !== 'object' || !('id_token' in body)) return response
  const rest: Record<string, unknown> = { ...(body as Record<string, unknown>) }
  delete rest.id_token
  return new Response(JSON.stringify(rest), {
    status: response.status,
    statusText: response.statusText,
    headers: { 'content-type': 'application/json' },
  })
}

function requireEndpoint(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Authorization server metadata is missing ${name}`)
  return value
}

function toTokenResult(
  tokens: oauth.TokenEndpointResponse,
  now: () => number,
  retainRefresh?: string,
): TokenResult {
  // Stalwart returns expires_in=3600; fall back conservatively if a server omits it.
  const expiresIn = typeof tokens.expires_in === 'number' ? tokens.expires_in : 3600
  const result: TokenResult = {
    accessToken: tokens.access_token,
    expiresAt: now() + expiresIn * 1000,
  }
  const refresh = tokens.refresh_token ?? retainRefresh
  if (refresh) result.refreshToken = refresh
  return result
}

/** RFC 8414 (or OIDC) discovery for the configured issuer. */
export async function discover(config: ResolvedOAuthConfig): Promise<oauth.AuthorizationServer> {
  const issuer = new URL(config.issuer)
  const response = await oauth.discoveryRequest(issuer, {
    ...httpOptions(config),
    algorithm: config.discovery,
  })
  return oauth.processDiscoveryResponse(issuer, response)
}

/**
 * Builds the authorization-endpoint URL with PKCE (S256) and state. Pure and synchronous:
 * the caller supplies an already-computed `codeChallenge`/`state`. This is the param
 * construction the SP.2 unit tests pin.
 */
export function buildAuthorizationUrl(input: AuthorizationUrlInput): URL {
  const url = new URL(input.authorizationEndpoint)
  url.searchParams.set('client_id', input.clientId)
  url.searchParams.set('redirect_uri', input.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', input.scopes.join(' '))
  url.searchParams.set('code_challenge', input.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', input.state)
  return url
}

/**
 * Generates a PKCE verifier/challenge + state and builds the authorization URL. Returns the
 * URL to navigate to and the single-use {@link PkceTransaction} to persist until the
 * redirect returns.
 */
export async function beginAuthorization(
  as: oauth.AuthorizationServer,
  config: ResolvedOAuthConfig,
): Promise<{ url: URL; transaction: PkceTransaction }> {
  const verifier = oauth.generateRandomCodeVerifier()
  const codeChallenge = await oauth.calculatePKCECodeChallenge(verifier)
  const state = oauth.generateRandomState()
  const url = buildAuthorizationUrl({
    authorizationEndpoint: requireEndpoint(as.authorization_endpoint, 'authorization_endpoint'),
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    scopes: config.scopes,
    codeChallenge,
    state,
  })
  return { url, transaction: { verifier, state, config } }
}

/**
 * Validates the redirect callback (state + RFC 9207 `iss`) and exchanges the code for
 * tokens. `currentHref` is the full callback URL (`location.href`), so it works under any
 * path prefix (FR-DEP-02).
 */
export async function completeAuthorization(
  as: oauth.AuthorizationServer,
  transaction: PkceTransaction,
  currentHref: string,
  deps: OAuthDeps,
): Promise<TokenResult> {
  const config = transaction.config
  const c = client(config)
  const params = oauth.validateAuthResponse(as, c, new URL(currentHref), transaction.state)
  const response = await oauth.authorizationCodeGrantRequest(
    as,
    c,
    oauth.None(),
    params,
    config.redirectUri,
    transaction.verifier,
    httpOptions(config),
  )
  const tokens = await oauth.processAuthorizationCodeResponse(
    as,
    c,
    await stripUnsolicitedIdToken(response),
  )
  return toTokenResult(tokens, deps.now)
}

/** Exchanges a refresh token for a fresh access token (silent refresh). */
export async function refreshTokens(
  as: oauth.AuthorizationServer,
  config: ResolvedOAuthConfig,
  refreshToken: string,
  deps: OAuthDeps,
): Promise<TokenResult> {
  const c = client(config)
  const response = await oauth.refreshTokenGrantRequest(
    as,
    c,
    oauth.None(),
    refreshToken,
    httpOptions(config),
  )
  const tokens = await oauth.processRefreshTokenResponse(
    as,
    c,
    await stripUnsolicitedIdToken(response),
  )
  // Stalwart reuses the refresh token unless it rotates near expiry; keep the old one when
  // the response omits a new one so the persisted token stays valid.
  return toTokenResult(tokens, deps.now, refreshToken)
}

/**
 * True when a refresh failure is **terminal** — the authorization server definitively
 * rejected the refresh token (RFC 6749 `invalid_grant`, or `invalid_client`), so neither a
 * retry nor a cold-boot restore from that token can ever succeed. Network / 5xx / parse
 * failures are transient and return `false` so a brief offline blip is not a hard logout.
 */
export function isPermanentRefreshError(error: unknown): boolean {
  return (
    error instanceof oauth.ResponseBodyError &&
    (error.error === 'invalid_grant' || error.error === 'invalid_client')
  )
}

/**
 * Revokes a token when the server advertises a revocation endpoint (RFC 7009). Stalwart
 * v0.16 does **not**, so this commonly returns `false` and logout relies on local wipe plus
 * natural expiry (FR-AUTH-05). Best-effort: never throws on a revocation failure.
 */
export async function revokeToken(
  as: oauth.AuthorizationServer,
  config: ResolvedOAuthConfig,
  token: string,
): Promise<boolean> {
  if (!as.revocation_endpoint) return false
  try {
    const c = client(config)
    const response = await oauth.revocationRequest(as, c, oauth.None(), token, {
      ...httpOptions(config),
      additionalParameters: { token_type_hint: 'refresh_token' },
    })
    await oauth.processRevocationResponse(response)
    return true
  } catch {
    return false
  }
}
