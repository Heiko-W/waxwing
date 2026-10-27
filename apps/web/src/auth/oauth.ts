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

/**
 * Public client id for a server that does not identify web apps by a document: Stalwart 0.16
 * requires no pre-registration and takes any. Stalwart 1.0 refuses it ("Unknown client id") —
 * there the controller uses the app's own client document instead, see {@link applicationClientId}.
 */
export const DEFAULT_CLIENT_ID = 'waxwing'

/**
 * Default scopes: JMAP mail access plus `offline_access` (required for a refresh token).
 * `openid` is intentionally omitted — we do not consume an id_token, so no OIDC id-token
 * validation is needed and the `oauth2` discovery path stays clean.
 */
export const DEFAULT_SCOPES = ['urn:ietf:params:oauth:scope:mail', 'offline_access']

/**
 * Scopes for the parts of the app beyond mail. Requested only from a server that lists them in
 * `scopes_supported` AND identifies the app by a client document (Stalwart 1.0): there the scope set
 * is part of what the user consents to, so it has to name what Waxwing actually uses. A 0.16 token
 * carries the same access whatever is asked, so nothing is added there.
 */
export const EXTRA_SCOPES = [
  'urn:ietf:params:oauth:scope:contacts',
  'urn:ietf:params:oauth:scope:calendars',
  'urn:ietf:params:oauth:scope:files',
]

/** The file in the Stalwart bundle that names the app to the server (`scripts/release.mjs`). */
export const APP_CLIENT_DOCUMENT = 'oauth-client.json'

/**
 * Where the browser comes back to, relative to the app's base. **Not the base itself**: the
 * bundle's `oauth-client.json` lists its redirect URIs as relative paths and an empty one is
 * invalid. Stalwart's own WebUI uses the same `oauth/callback`.
 */
export const APP_CALLBACK_PATH = 'oauth/callback'

function withoutQuery(baseUri: string): URL {
  const url = new URL(baseUri)
  url.search = ''
  url.hash = ''
  return url
}

/**
 * The client id of an app that Stalwart 1.0 serves from its own bundle: the URL of its
 * `oauth-client.json` — `https://mail.example.com/webmail/oauth-client.json` for an app mounted at
 * `/webmail/`. The server answers that URL itself, with the document resolved against the host the
 * request came in on, so the id is right under any mount prefix without being configured.
 */
export function applicationClientId(baseUri: string): string {
  return new URL(APP_CLIENT_DOCUMENT, withoutQuery(baseUri)).href
}

/** {@link APP_CALLBACK_PATH} under the app's base. */
export function applicationRedirectUri(baseUri: string): string {
  return new URL(APP_CALLBACK_PATH, withoutQuery(baseUri)).href
}

/** True when `href` is the dedicated callback page of the app mounted at `baseUri`. */
export function isApplicationCallback(href: string, baseUri: string): boolean {
  return new URL(href).pathname === new URL(applicationRedirectUri(baseUri)).pathname
}

/**
 * Does the server identify web apps by a client document? (Client ID Metadata Documents,
 * draft-ietf-oauth-client-id-metadata-document.) Stalwart 1.0 says so in its discovery document;
 * 0.16 does not, and still takes any client id.
 */
export function supportsClientDocuments(as: oauth.AuthorizationServer): boolean {
  return as.client_id_metadata_document_supported === true
}

/** `scopes` plus whichever of {@link EXTRA_SCOPES} the server lists and the request lacks. */
export function withExtraScopes(scopes: string[], as: oauth.AuthorizationServer): string[] {
  const supported = Array.isArray(as.scopes_supported) ? as.scopes_supported : []
  const extra = EXTRA_SCOPES.filter((scope) => supported.includes(scope) && !scopes.includes(scope))
  return [...scopes, ...extra]
}

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
 * The authorization server's own error code (RFC 6749 §4.1.2.1 / §5.2), or `undefined` when the
 * failure was not the server saying no.
 *
 * Both shapes count and they arrive from different legs: `AuthorizationResponseError` is the
 * `?error=` on the redirect — `access_denied` when the user pressed "Deny" — and
 * `ResponseBodyError` is the token endpoint's JSON refusal of the code. Everything else (a
 * `TypeError` from a dead endpoint, a state mismatch, a consumed transaction) has no code,
 * because none of it is the server's verdict.
 */
export function authorizationErrorCode(error: unknown): string | undefined {
  if (error instanceof oauth.AuthorizationResponseError) return error.error
  if (error instanceof oauth.ResponseBodyError) return error.error
  return undefined
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
