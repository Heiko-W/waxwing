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
  authorizationErrorCode,
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
import { defaultLockManager, type LockManagerLike, withRefreshLock } from './refresh-lock'
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
  StoredJmapSession,
} from './types'
import { type WipeEnvironment, wipeLocalData } from './wipe'

/** How long a stashed PKCE transaction stays usable. Long enough for a slow IdP login. */
const PKCE_MAX_AGE_MS = 30 * 60_000

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
  /**
   * Lock manager serializing the refresh grant across tabs; defaults to `navigator.locks`.
   * Injected so the cross-tab rotation race can be driven deterministically in tests, and so an
   * environment without the API degrades to the unlocked path rather than throwing.
   */
  locks?: LockManagerLike
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
  private readonly locks: LockManagerLike | undefined

  private session: AuthSession | null = null
  private resolvedOAuth: ResolvedOAuthConfig | null = null
  private as: AuthorizationServer | null = null
  /** De-dupes concurrent {@link refresh} calls into one in-flight token grant. */
  private refreshInFlight: Promise<void> | null = null
  /**
   * Bumped by {@link logout}. A token grant that was already in flight when the user signed out
   * must not write its result: {@link SecretStore.put} re-creates the wiped database and a fresh
   * wrapping key, so a refresh landing a few hundred ms after the wipe used to resurrect a fully
   * valid credential at rest while the app showed a clean login form.
   */
  private generation = 0

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
    this.locks = options.locks ?? defaultLockManager()
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

  /**
   * Is the current URL a callback for an authorization WE started?
   *
   * Both halves are required. The URL shape alone is not evidence: `?code=` and `?error=` are
   * ordinary query parameters that anyone can put in a link, and a mail containing
   * `https://mail.example.com/?code=x` used to send the recipient's own client down the callback
   * branch — where `completeRedirect` failed, `boot()` never reached `restore()`, and a signed-in
   * user landed on a login form. Self-healing (a reload fixed it) but entirely attacker-triggered,
   * and it consumed a genuinely pending PKCE transaction if one existed.
   *
   * So the pending single-use transaction is what decides. Asynchronous for that reason.
   */
  async isRedirectCallback(): Promise<boolean> {
    const params = new URL(this.getHref()).searchParams
    if (!params.has('code') && !params.has('error')) return false
    const pending = await this.store.get(SecretName.PkceTransaction).catch(() => null)
    return pending !== null
  }

  /** Starts a login. OAuth navigates away (`redirect`); Basic returns a `session`. */
  startLogin(request: LoginRequest): Promise<StartLoginResult> {
    return request.method === 'basic'
      ? this.startBasicLogin(request)
      : this.startOAuthLogin(request)
  }

  private async startOAuthLogin(
    request: Extract<LoginRequest, { method: 'oauth' }>,
  ): Promise<StartLoginResult> {
    const config = this.requireResolvedOAuth()
    const as = await this.ensureDiscovery(config)
    const { url, transaction } = await beginAuthorization(as, config)
    const stored: PkceTransaction = {
      ...transaction,
      createdAt: this.now(),
      ...(request.publicComputer === true ? { ephemeral: true } : {}),
    }
    await this.store.put(SecretName.PkceTransaction, JSON.stringify(stored))
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
    this.resolvedOAuth = null
    // Persist only on opt-in ("stay signed in"), and only via the wrapped store — never
    // plaintext (FR-AUTH-04). Without opt-in, nothing survives a reload.
    if (request.staySignedIn) {
      // The store holds the secret of the ACTIVE method and no other. Signing in with a password
      // after an OAuth session — the reachable order is an OAuth callback that succeeds and a
      // `connectSession` that then fails, which drops the user back on the login form with the
      // tokens already written — used to leave a refresh token behind: up to 30 days valid, not
      // revocable server-side (ADR-006), and still on the disk of someone who deliberately left
      // "stay signed in" unticked. Here the store must work anyway — that is what the tick asked
      // for — so a failure is the sign-in's failure and is reported as one.
      await this.tokens.clear()
      // And the JMAP session document of whoever was here before, on the same lines and for the
      // same reason (FR-OFF-01). It names an account and an accountId; left behind, the next
      // offline cold start would rebuild a client for the PREVIOUS user's mailbox and hand it
      // THESE credentials. The window is real: a sign-in whose `connectSession` then fails leaves
      // the new record on disk with the old document beside it.
      await this.store.delete(SecretName.JmapSession)
      await this.store.put(SecretName.BasicCredentials, JSON.stringify(credentials))
      await this.store.put(
        SecretName.AuthRecord,
        JSON.stringify({ method: 'basic', username: credentials.username } satisfies AuthRecord),
      )
    } else {
      /*
       * NOTHING IS TO BE PERSISTED HERE, SO NOTHING HERE MAY FAIL THE SIGN-IN.
       *
       * These three are hygiene: they remove what an EARLIER session left, and they touch a store
       * this sign-in does not otherwise need. Where IndexedDB cannot be opened at all — an
       * enterprise policy, a locked-down WebView, some private-browsing configurations — they
       * threw, and a Basic-only user who ticked nothing and wanted nothing kept was refused
       * entirely, with "Something went wrong" and an offer to reset the app. The session they
       * asked for is purely in memory and was already fully constructible.
       *
       * `registry-store.ts` tolerates exactly this environment on the same reasoning. What is NOT
       * swallowed is the branch above: there the reader asked for persistence, and a store that
       * cannot deliver it has to say so.
       */
      await this.tokens.clear().catch(() => undefined)
      await this.store.delete(SecretName.BasicCredentials).catch(() => undefined)
      await this.store.delete(SecretName.AuthRecord).catch(() => undefined)
      await this.store.delete(SecretName.JmapSession).catch(() => undefined)
    }
    // AFTER the store work, not before it. Set first, a login that reported failure still left
    // `getSession()` answering with a live Basic session — the app said "signed out" and the
    // controller said "signed in as alice".
    const session = this.buildBasicSession(credentials)
    this.session = session
    return { kind: 'session', session }
  }

  /** Consumes the OAuth redirect: validates state/iss, exchanges the code, stores tokens. */
  async completeRedirect(): Promise<AuthSession> {
    try {
      const raw = await this.store.get(SecretName.PkceTransaction)
      if (!raw) throw new OAuthCallbackError('No pending authorization request')
      const transaction = JSON.parse(raw) as PkceTransaction
      // An authorization the user walked away from days ago is not one they are completing now.
      // Hygiene rather than a credential control (a code without its state is worthless), but it
      // keeps a verifier from lying around indefinitely.
      if (
        transaction.createdAt !== undefined &&
        this.now() - transaction.createdAt > PKCE_MAX_AGE_MS
      ) {
        throw new OAuthCallbackError('Authorization request expired')
      }
      // BEFORE the exchange: `apply()` below must already know not to persist anything.
      if (transaction.ephemeral === true) this.tokens.setEphemeral()
      const config = transaction.config
      const as = await this.ensureDiscovery(config)
      let result: TokenResult
      try {
        result = await completeAuthorization(as, transaction, this.getHref(), this.oauthDeps())
      } catch (error) {
        if (error instanceof AuthError) throw error
        // Carry the server's verdict, if it gave one. `access_denied` is the user pressing "Deny"
        // at the IdP, and the UI has to be able to say so rather than call the reader's own
        // decision a malfunction.
        const code = authorizationErrorCode(error)
        throw new OAuthCallbackError('OAuth callback failed', {
          cause: error,
          ...(code !== undefined ? { code } : {}),
        })
      } finally {
        // Single-use: drop the transaction whether or not the exchange succeeded.
        await this.store.delete(SecretName.PkceTransaction)
      }
      this.resolvedOAuth = config
      await this.tokens.apply(result)
      // The mirror of the same invariant (see `startBasicLogin`): a password left over from an
      // earlier Basic sign-in with "stay signed in" is inert for `restore()`, which keys off the
      // AuthRecord overwritten below — but it is still decryptable on this device and still valid
      // at the server, which is the half that matters.
      await this.store.delete(SecretName.BasicCredentials)
      // And the previous identity's JMAP session document (FR-OFF-01) — same reasoning as in
      // `startBasicLogin`: it names an account, and an offline cold start would rebuild a client
      // for it out of credentials that now belong to someone else. Outside the `ephemeral` guard
      // below on purpose: a public-computer session must not leave one either, and it is the
      // absence of an AuthRecord that stops `rememberJmapSession` writing a new one.
      await this.store.delete(SecretName.JmapSession)
      // The AuthRecord is what `restore()` keys off on a cold start. Writing one for a
      // public-computer session would sign the NEXT person at this machine in as this user, which
      // is the failure the mode exists to prevent (FR-AUTH-09).
      if (transaction.ephemeral !== true) {
        await this.store.put(
          SecretName.AuthRecord,
          JSON.stringify({ method: 'oauth', username: null, oauth: config } satisfies AuthRecord),
        )
      }
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

  /**
   * One grant, and only one across the whole browser profile at a time (R-30).
   *
   * The single-flight above is per `AuthController`, i.e. per tab, and every tab shares one
   * `waxwing-auth` database (ADR-037). Two tabs restored together therefore read the same refresh
   * token and start two grants; against an IdP that invalidates the old token on rotation the
   * loser is answered `invalid_grant` and used to delete the token the winner had just written.
   * Both tabs signed out, and so did the next cold start.
   *
   * The lock is what makes the second tab READ AFTER the first one wrote: every store access below
   * happens inside the critical section, so there is nothing to re-read and compare. Where the
   * lock is unavailable (see `refresh-lock.ts`) the compare-and-delete in `grantRefresh` is what is
   * left, and it is enough to stop the mutual erasure — it just cannot prevent the double grant.
   */
  private doRefresh(): Promise<void> {
    return withRefreshLock(this.locks, () => this.grantRefresh())
  }

  private async grantRefresh(): Promise<void> {
    const generation = this.generation
    const config = this.requireResolvedOAuth()
    const refreshToken = await this.tokens.getRefreshToken()
    if (!refreshToken) throw new AuthExpiredError('No refresh token available')
    // WHOSE token is that? (W-17)
    //
    // Every controller in this browser profile shares one `waxwing-auth` database — ADR-004
    // designed for per-account scopes, but no production path passes one. So: tab 1 is signed in
    // to server X and holds `resolvedOAuth` for X in memory; someone signs in to server Y in tab
    // 2, which overwrites the shared refresh token; tab 1's access token expires an hour later and
    // this method reads Y's token out of storage and POSTs it to X's token endpoint. A refresh
    // token handed to the wrong server is a credential disclosure, and no XSS is needed for it.
    //
    // The AuthRecord is written by whoever signed in last and names their issuer, so it answers
    // the question without needing the store isolation.
    //
    // It is asked only when the token CAME FROM THE STORE, which the original phrasing got half
    // right: it reasoned "no record ⇒ ephemeral ⇒ already ours" and then ran the check anyway
    // whenever a record happened to exist. But a public-computer session's refresh token never
    // enters the store (`TokenStore.ephemeralRefresh`), so a record left behind by a failed
    // restore — or written by a second tab signed in durably somewhere else — is a statement about
    // a DIFFERENT credential. Matching against it expired a perfectly good ephemeral session after
    // an hour, with no refresh grant even attempted (FR-AUTH-09).
    if (!this.tokens.isEphemeral()) {
      const record = await this.readAuthRecord()
      if (
        record !== null &&
        (record.method !== 'oauth' || record.oauth?.issuer !== config.issuer)
      ) {
        this.tokens.clearAccessToken()
        throw new AuthExpiredError(
          'The stored credential belongs to a different sign-in — refusing to send it',
        )
      }
    }
    const as = await this.ensureDiscovery(config)
    const result = await this.grantWithRotationRetry(as, config, refreshToken, generation)
    // Signed out while this grant was on the wire: the store has just been wiped, and persisting
    // the new token would rebuild it — database, wrapping key and a valid refresh token — behind a
    // login screen. Drop the result on the floor instead. The access token is in-memory only, so
    // nothing durable is lost by discarding it either.
    if (generation !== this.generation) {
      throw new AuthExpiredError('Signed out during token refresh')
    }
    await this.tokens.apply(result)
    if (this.session?.method === 'oauth') {
      this.session = { ...this.session, expiresAt: result.expiresAt }
    }
  }

  /**
   * The grant itself, plus the two guards a shared store needs when the lock could not be had.
   *
   * COMPARE BEFORE DELETING. A terminal rejection means the token WE SENT is dead, which is not
   * the same statement as "the token in the store is dead". Deleting unconditionally is how the
   * losing tab of a rotation race used to erase the winner's freshly written token, taking down a
   * session that was working.
   *
   * And when the stored token has moved on, that difference is itself the answer: someone else
   * rotated it, the new value is valid, and one retry with it turns a re-auth dialog into a
   * successful refresh. Exactly one — a second rejection is the server's real verdict.
   */
  private async grantWithRotationRetry(
    as: AuthorizationServer,
    config: ResolvedOAuthConfig,
    refreshToken: string,
    generation: number,
  ): Promise<TokenResult> {
    try {
      return await refreshTokens(as, config, refreshToken, this.oauthDeps())
    } catch (error) {
      this.tokens.clearAccessToken()
      // Transient (network, 5xx, unparseable) failures keep the token, so a brief offline blip is
      // not a permanent logout — and there is nothing to retry with either.
      if (!isPermanentRefreshError(error)) {
        throw new AuthExpiredError('Token refresh failed', { cause: error })
      }
      // Signed out while this grant was on the wire: touch the store NO FURTHER. Not the delete
      // below and not even the read before it — every `SecretStore` call goes through `openDb()`,
      // which re-creates the database and its object stores, so either one rebuilt `waxwing-auth`
      // moments after "Sign out & remove data" had deleted it. Empty, with no credential in it,
      // but present — and "this origin holds a Waxwing auth database" is precisely the statement
      // the wipe removes (W-05, W-23). The access token was already dropped above, in memory.
      if (generation !== this.generation) {
        throw new AuthExpiredError('Signed out during token refresh', { cause: error })
      }
      const stored = await this.tokens.getRefreshToken().catch(() => null)
      if (stored !== null && stored !== refreshToken) {
        try {
          return await refreshTokens(as, config, stored, this.oauthDeps())
        } catch (retryError) {
          await this.discardDeadToken(generation, isPermanentRefreshError(retryError))
          throw new AuthExpiredError('Token refresh failed', { cause: retryError })
        }
      }
      await this.discardDeadToken(generation, true)
      throw new AuthExpiredError('Token refresh failed', { cause: error })
    }
  }

  /**
   * Delete a definitively dead refresh token — unless the user signed out while it was on the wire.
   *
   * The `generation` guard is the one the SUCCESS path has had since W-05; the retry leg needs it
   * for the same reason (a second network round trip is a second window for a sign-out to land),
   * and it is checked once more here rather than assumed from the caller.
   */
  private async discardDeadToken(generation: number, terminal: boolean): Promise<void> {
    if (!terminal) return
    if (generation !== this.generation) return
    // Definitively dead and still ours, so drop it from storage too: otherwise `restore()` keys
    // off its mere presence and resurrects a phantom session that re-fails on first use.
    await this.tokens.clear()
  }

  /**
   * Restores a session on cold boot without a fresh login (offline start, FR-AUTH-03). For
   * OAuth the access token is fetched lazily on first {@link getAccessToken}; for Basic the
   * persisted (opt-in) credentials are re-loaded. Returns `null` when nothing is persisted.
   */
  /** Drop a {@link PkceTransaction} older than {@link PKCE_MAX_AGE_MS}; unreadable ones too. */
  private async sweepStalePkce(): Promise<void> {
    const raw = await this.store.get(SecretName.PkceTransaction).catch(() => null)
    if (!raw) return
    let stale = true
    try {
      const transaction = JSON.parse(raw) as PkceTransaction
      stale =
        transaction.createdAt === undefined || this.now() - transaction.createdAt > PKCE_MAX_AGE_MS
    } catch {
      // Unparseable: no callback will ever consume it either.
    }
    if (stale) await this.store.delete(SecretName.PkceTransaction).catch(() => undefined)
  }

  /** The persisted {@link AuthRecord}, or `null` when there is none or it is unreadable. */
  private async readAuthRecord(): Promise<AuthRecord | null> {
    const raw = await this.store.get(SecretName.AuthRecord)
    if (!raw) return null
    try {
      return JSON.parse(raw) as AuthRecord
    } catch {
      // A corrupted record is not a reason to fail a refresh differently from a missing one.
      return null
    }
  }

  /**
   * Keep the JMAP Session document beside the credentials it belongs to (FR-OFF-01).
   *
   * **The guard is the whole point, not a nicety.** A document is only ever usable together with
   * a {@link restore}, and {@link restore} needs an `AuthRecord`. Without one — Basic with "stay
   * signed in" unticked, a public-computer OAuth session — nothing can ever read this back, so
   * writing it would leave a username and a server on the disk of a machine where the user asked
   * for the opposite and got it everywhere else. So: no record, no document, silently.
   *
   * Every path that establishes a NEW identity deletes the old document on the same lines that
   * write the new `AuthRecord` ({@link startBasicLogin}, {@link completeRedirect}), and
   * {@link logout} destroys the whole database. That is what makes "the stored document belongs
   * to the stored credentials" structural rather than remembered.
   */
  async rememberJmapSession(connectUrl: string, document: unknown): Promise<void> {
    if ((await this.readAuthRecord()) === null) return
    const stored: StoredJmapSession = { connectUrl, document, storedAt: this.now() }
    await this.store.put(SecretName.JmapSession, JSON.stringify(stored))
  }

  /**
   * The stored JMAP Session document, or `null` when there is none (or it is unreadable).
   *
   * Returns the envelope UNVALIDATED — `document` is `unknown` on purpose. Whether that value is
   * a usable Session is a JMAP question, and `@waxwing/jmap`'s `sessionFromStore` is the one
   * place that answers it (shape + the origin check that keeps the `Authorization` header on the
   * configured host). Answering it here would be a second copy of a security check.
   */
  async recallJmapSession(): Promise<StoredJmapSession | null> {
    const raw = await this.store.get(SecretName.JmapSession)
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) as StoredJmapSession
      return typeof parsed?.connectUrl === 'string' ? parsed : null
    } catch {
      // Corrupt is missing. An offline cold start then shows the sign-in form, which is what it
      // did before this existed.
      return null
    }
  }

  async restore(): Promise<AuthSession | null> {
    // Sweep an abandoned authorization on the way past (W-36). A user who walks away at the IdP —
    // or a browser that dies there — leaves `code_verifier`, `state` and the resolved OAuth config
    // in the DURABLE store, and nothing ever collected them: the age check only runs when a
    // callback arrives to consume the transaction, and in public-computer mode no callback comes.
    // The verifier is worthless without its code; what stays behind is the metadata — who tried to
    // sign in, and where — which is exactly what that mode promises not to leave. `restore()` is
    // the right place: it runs once per cold start, before anything else touches this store.
    await this.sweepStalePkce()
    const record = await this.readAuthRecord()
    if (record === null) return null
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
    // FIRST, before any await: an in-flight refresh checks this before it persists anything.
    this.generation += 1
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
    //
    // Its failure must not take the rest of the wipe with it, and it used to: a frozen or bfcached
    // second tab blocks `deleteDatabase('waxwing-auth')` (`SecretStoreBlockedError`), and the throw
    // then skipped `wipeLocalData` entirely — so Cache Storage, every other IndexedDB database and
    // the service-worker registrations survived a "remove my data" for a reason that has nothing
    // to do with any of them. The error is still raised, last, so the caller can still tell the
    // user their credentials are on disk.
    const wipeError = await this.store.wipe().then(
      () => null,
      (error: unknown) => error,
    )
    if (options.wipeData) {
      await wipeLocalData(this.resolveWipeEnv())
    }
    if (wipeError !== null) throw wipeError
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

  /**
   * Memoized RFC 8414 discovery, keyed by the issuer it was performed for.
   *
   * The issuer comparison is the load-bearing part: `as` feeds BOTH the RFC 9207 `iss` check in
   * `validateAuthResponse` and the token endpoint a code is exchanged at. Returning a cached
   * document for a DIFFERENT issuer would validate one server's callback against another server's
   * metadata. Today `SessionProvider.ensureController` builds a new controller whenever the issuer
   * changes, so the unkeyed version was unreachable rather than wrong — but that is an invariant
   * held one layer up, and the multi-account work (ADR-004) is exactly what would break it.
   */
  private async ensureDiscovery(config: ResolvedOAuthConfig): Promise<AuthorizationServer> {
    if (this.as && this.as.issuer === config.issuer) return this.as
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
      localStorage: typeof localStorage !== 'undefined' ? localStorage : undefined,
      sessionStorage: typeof sessionStorage !== 'undefined' ? sessionStorage : undefined,
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
