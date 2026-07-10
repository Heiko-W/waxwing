/**
 * Pure {@link ConnectTarget} resolution (M1.4, FR-AUTH-01/02). Reconciles the two URLs the
 * onboarding flow juggles: the input to `@waxwing/jmap` `connect()` and the OAuth issuer.
 *
 * For Stalwart (and any single-origin OIDC-alongside-JMAP server) the OAuth issuer is the
 * server origin, so `issuer = origin(connectUrl)` holds. A server that advertises a different
 * issuer would need a discovery step and an ADR — documented, not handled here.
 */

import type { ConnectTarget } from './types'

/** Thrown when a manual connect input is not a usable email or server URL (FR-AUTH-02). */
export class InvalidTargetError extends Error {
  constructor(message = 'Invalid server or email') {
    super(message)
    this.name = 'InvalidTargetError'
  }
}

function hostOf(url: string): string {
  return new URL(url).host
}

/** Same-origin autoconnect target (FR-AUTH-01): the browser origin, never re-editable. */
export function sameOriginTarget(origin: string): ConnectTarget {
  return { connectUrl: origin, issuer: origin, displayHost: hostOf(origin), fromProbe: true }
}

/** Pinned target from `config.server.sessionUrl` (FR-AUTH-02): short-circuits discovery. */
export function pinnedTarget(sessionUrl: string): ConnectTarget {
  const issuer = new URL(sessionUrl).origin
  return { connectUrl: sessionUrl, issuer, displayHost: hostOf(sessionUrl), fromProbe: false }
}

/**
 * Resolve a manual connect input (FR-AUTH-02). An email `user@domain` becomes
 * `https://{domain}`; a bare host or URL is normalized to `https://…` when schemeless. The
 * server field stays editable (`fromProbe: false`). Throws {@link InvalidTargetError} on
 * unusable input; real reachability is decided later by `connect()`.
 */
export function resolveManualTarget(input: string): ConnectTarget {
  const trimmed = input.trim()
  if (trimmed === '') throw new InvalidTargetError('Empty input')

  if (trimmed.includes('@')) {
    const domain = trimmed.slice(trimmed.lastIndexOf('@') + 1).trim()
    if (domain === '' || domain.includes(' ') || domain.includes('/')) {
      throw new InvalidTargetError('Invalid email domain')
    }
    const connectUrl = `https://${domain}`
    return { connectUrl, issuer: connectUrl, displayHost: domain, fromProbe: false }
  }

  const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  let url: URL
  try {
    url = new URL(normalized)
  } catch {
    throw new InvalidTargetError('Invalid server URL')
  }
  if (url.host === '') throw new InvalidTargetError('Invalid server URL')
  return {
    connectUrl: normalized,
    issuer: url.origin,
    displayHost: url.host,
    fromProbe: false,
  }
}
