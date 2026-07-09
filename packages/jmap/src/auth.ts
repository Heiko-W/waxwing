/**
 * Authentication-scheme abstraction (FR-AUTH-04 groundwork).
 *
 * An {@link AuthProvider} yields the value for the `Authorization` header and is injected
 * into every transport, so swapping Bearer ↔ Basic (or a future refreshing OAuth
 * provider) is a one-line change at construction time. `authorization()` may be async so
 * a token can be refreshed lazily.
 */
export interface AuthProvider {
  /** Scheme name for diagnostics (`'bearer'`, `'basic'`, …). */
  readonly scheme: string
  /** Returns the full `Authorization` header value, e.g. `"Bearer eyJ…"`. */
  authorization(): string | Promise<string>
  /**
   * The bare credential for transports that carry auth *outside* the `Authorization`
   * header — e.g. an SSE `?access_token=` query param on servers that support one (SP.3).
   * Optional and additive: {@link bearer} returns the raw token; {@link basic} has no query
   * form and returns `undefined`. Header-based transports never call this.
   */
  token?(): string | undefined | Promise<string | undefined>
}

/**
 * Bearer-token auth (RFC 6750). Pass a static token or a (possibly async) getter so the
 * same provider can front a refreshing OAuth token store later (SP.2).
 */
export function bearer(token: string | (() => string | Promise<string>)): AuthProvider {
  const resolve = () => (typeof token === 'function' ? token() : token)
  return {
    scheme: 'bearer',
    async authorization() {
      return `Bearer ${await resolve()}`
    },
    token() {
      return resolve()
    },
  }
}

/** HTTP Basic auth (RFC 7617). Credentials are UTF-8 encoded before base64, per the RFC. */
export function basic(username: string, password: string): AuthProvider {
  const header = `Basic ${base64(`${username}:${password}`)}`
  return {
    scheme: 'basic',
    authorization() {
      return header
    },
  }
}

/**
 * Applies the provider's `Authorization` header onto a headers object, mutating and
 * returning it. Kept separate so all transports share one code path.
 */
export async function applyAuth(
  headers: Record<string, string>,
  auth: AuthProvider,
): Promise<Record<string, string>> {
  headers.Authorization = await auth.authorization()
  return headers
}

/** UTF-8 → base64 without a Buffer dependency; works in browsers and Node. */
function base64(input: string): string {
  const bytes = new TextEncoder().encode(input)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}
