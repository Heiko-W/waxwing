/**
 * FR-AUTH-06 funnel. Wraps an {@link AuthProvider} so that when the OAuth token closure can
 * no longer produce a token (silent refresh permanently failed → {@link AuthExpiredError}),
 * an `onExpired` callback fires before the error propagates. Because EVERY JMAP request
 * resolves `authorization()` through the provider, this catches auth expiry uniformly at one
 * seam — no need to wrap each client method. The error is always re-thrown so the caller's
 * own error handling still runs; `onExpired` is expected to be idempotent (the provider guards
 * the overlay against repeated flips).
 *
 * Basic auth never expires client-side, so its provider is passed through unchanged; a Basic
 * password change surfaces as an HTTP 401 at the call site, which the app routes to the same
 * `reportAuthExpired` funnel.
 */

import type { AuthProvider } from '@waxwing/jmap'
import { AuthExpiredError } from '../../auth'

export function reauthProvider(inner: AuthProvider, onExpired: () => void): AuthProvider {
  async function guarded<T>(run: () => T | Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (error) {
      if (error instanceof AuthExpiredError) onExpired()
      throw error
    }
  }

  const provider: AuthProvider = {
    scheme: inner.scheme,
    authorization: () => guarded(() => inner.authorization()),
  }
  if (inner.token) {
    const innerToken = inner.token.bind(inner)
    provider.token = () => guarded(() => innerToken())
  }
  return provider
}
