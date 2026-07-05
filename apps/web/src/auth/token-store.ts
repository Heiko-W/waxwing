/**
 * Token store (FR-AUTH-03, NFR-SEC-02).
 *
 * The access token lives **in memory only** — never in IndexedDB, never in
 * `local`/`sessionStorage`. The refresh token is the sole persisted credential, wrapped at
 * rest by {@link SecretStore}. This split means a page reload keeps the user signed in
 * (silent refresh from the persisted token) while the short-lived bearer token has no
 * durable footprint.
 */

import type { TokenResult } from './oauth'
import { SecretName, type SecretStore } from './secret-store'

/** Default clock skew (ms): refresh this long before the real expiry to avoid races. */
const DEFAULT_SKEW_MS = 60_000

interface AccessToken {
  token: string
  expiresAt: number
}

export interface TokenStoreOptions {
  now?: () => number
  /** Treat the access token as expired this many ms early. Default 60 000. */
  skewMs?: number
}

export class TokenStore {
  private readonly store: SecretStore
  private readonly now: () => number
  private readonly skewMs: number
  private access: AccessToken | null = null

  constructor(store: SecretStore, options: TokenStoreOptions = {}) {
    this.store = store
    this.now = options.now ?? (() => Date.now())
    this.skewMs = options.skewMs ?? DEFAULT_SKEW_MS
  }

  /**
   * Applies a token-endpoint result: caches the access token in memory and, when a refresh
   * token is present, persists it (wrapped). A rotated refresh token replaces the old one.
   */
  async apply(result: TokenResult): Promise<void> {
    this.access = { token: result.accessToken, expiresAt: result.expiresAt }
    if (result.refreshToken !== undefined) {
      await this.store.put(SecretName.RefreshToken, result.refreshToken)
    }
  }

  /** The current in-memory access token, or `null` if none is cached. */
  getAccessToken(): string | null {
    return this.access?.token ?? null
  }

  /** Access-token expiry (epoch ms), or `null` when no token is cached. */
  getExpiresAt(): number | null {
    return this.access?.expiresAt ?? null
  }

  /** True when a cached access token exists and is not within the skew window of expiry. */
  isFresh(): boolean {
    if (!this.access) return false
    return this.access.expiresAt - this.skewMs > this.now()
  }

  /** The persisted (wrapped) refresh token, or `null` — the basis for offline start. */
  getRefreshToken(): Promise<string | null> {
    return this.store.get(SecretName.RefreshToken)
  }

  /** Drops the in-memory access token (e.g. on refresh failure) without touching storage. */
  clearAccessToken(): void {
    this.access = null
  }

  /** Clears the access token and deletes the persisted refresh token. */
  async clear(): Promise<void> {
    this.access = null
    await this.store.delete(SecretName.RefreshToken)
  }
}
