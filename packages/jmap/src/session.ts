import type { AuthProvider } from './auth'
import { Capabilities } from './capabilities'
import { errorFromResponse } from './errors'
import type { FetchLike } from './transport'
import { getWithAuth, resolveFetch } from './transport'
import type { CoreCapability, Id, JmapResponse, Session } from './types/core'
import type { MailCapability } from './types/mail'

/** The conventional well-known path a JMAP Session is discovered at (RFC 8620 §2). */
export const WELL_KNOWN_PATH = '/.well-known/jmap'

/** Options for {@link getSession}. */
export interface GetSessionOptions {
  /** Injectable fetch (tests / SSR). Defaults to the global `fetch`. */
  fetch?: FetchLike
  /** Aborts the request. */
  signal?: AbortSignal
}

/**
 * Fetches and parses the JMAP Session (RFC 8620 §2).
 *
 * `input` may be:
 *  - the full session/well-known URL (absolute or relative, e.g. `/.well-known/jmap`), or
 *  - an origin/base URL (e.g. `https://mail.example.com`), in which case
 *    {@link WELL_KNOWN_PATH} is appended.
 *
 * The four `*Url` fields MAY be relative and are resolved against the final response URL
 * (after any redirect), per the RFC. Relative bases that cannot be resolved (e.g. in
 * unit tests with a mock fetch) are left verbatim.
 */
export async function getSession(
  input: string,
  auth: AuthProvider,
  options: GetSessionOptions = {},
): Promise<Session> {
  const fetchImpl = resolveFetch(options.fetch)
  const url = toWellKnownUrl(input)
  const response = await getWithAuth(url, { auth, fetch: fetchImpl }, options.signal)
  if (!response.ok) throw await errorFromResponse(response)
  const raw = (await response.json()) as Session
  const base = response.url || url
  return normalizeSession(raw, base)
}

/** Builds the well-known URL from an origin/base, or returns `input` if it already is a session URL. */
export function toWellKnownUrl(input: string): string {
  if (input === '' || input === '/') return WELL_KNOWN_PATH
  if (input.includes(WELL_KNOWN_PATH)) return input
  // Treat anything else as an origin/base: join without duplicating the slash.
  return input.endsWith('/')
    ? `${input.slice(0, -1)}${WELL_KNOWN_PATH}`
    : `${input}${WELL_KNOWN_PATH}`
}

/**
 * Returns a copy of `session` with the four `*Url` fields resolved to absolute URLs
 * against `base`. Values that are already absolute are kept; unresolvable ones (relative
 * value + relative base) are preserved verbatim.
 */
export function normalizeSession(session: Session, base: string): Session {
  return {
    ...session,
    apiUrl: resolveUrl(session.apiUrl, base),
    downloadUrl: resolveUrl(session.downloadUrl, base),
    uploadUrl: resolveUrl(session.uploadUrl, base),
    eventSourceUrl: resolveUrl(session.eventSourceUrl, base),
  }
}

/**
 * The RFC 8620 session URI-template variable names: `{accountId}` (upload/download),
 * `{blobId}`/`{type}`/`{name}` (download, §6.2), `{types}`/`{closeafter}`/`{ping}`
 * (eventSource, §7.3). Only these are un-escaped by {@link resolveUrl}.
 */
const SESSION_TEMPLATE_VARS = new Set([
  'accountId',
  'blobId',
  'type',
  'name',
  'types',
  'closeafter',
  'ping',
])

/**
 * Resolves `value` against `base`, tolerating a non-absolute base (returns `value`
 * unchanged). RFC 6570 URI-template placeholders (`{accountId}` etc. in the download /
 * upload / eventSource URLs) are preserved: `new URL()` percent-encodes `{`/`}`, so a
 * `%7B<var>%7D` sequence is restored to `{<var>}` — but ONLY for the known session template
 * variables ({@link SESSION_TEMPLATE_VARS}), so a legitimately percent-encoded brace elsewhere
 * in the URL is left untouched.
 */
export function resolveUrl(value: string, base: string): string {
  try {
    return new URL(value, base).href.replace(/%7B([A-Za-z]+)%7D/gi, (match, name: string) =>
      SESSION_TEMPLATE_VARS.has(name) ? `{${name}}` : match,
    )
  } catch {
    return value
  }
}

/**
 * Reads the core-capability limits from a Session. Returns `null` if the server did not
 * advertise `urn:ietf:params:jmap:core` (a non-conformant server).
 */
export function getCoreCapability(session: Session): CoreCapability | null {
  const value = session.capabilities[Capabilities.core]
  return isCoreCapability(value) ? value : null
}

function isCoreCapability(value: unknown): value is CoreCapability {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.maxSizeRequest === 'number' &&
    typeof v.maxCallsInRequest === 'number' &&
    typeof v.maxObjectsInGet === 'number' &&
    typeof v.maxObjectsInSet === 'number'
  )
}

/**
 * Reads the per-account mail-capability limits from a Session (RFC 8621 §1.4) — notably
 * `maxSizeAttachmentsPerEmail`. Returns `null` if the account is unknown or did not advertise
 * `urn:ietf:params:jmap:mail`.
 */
export function getMailCapability(session: Session, accountId: Id): MailCapability | null {
  const account = session.accounts[accountId]
  if (account === undefined) return null
  const value = account.accountCapabilities[Capabilities.mail]
  return isMailCapability(value) ? value : null
}

function isMailCapability(value: unknown): value is MailCapability {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.maxSizeAttachmentsPerEmail === 'number' && Array.isArray(v.emailQuerySortOptions)
}

/**
 * `true` if a response's `sessionState` differs from the cached {@link Session.state},
 * signalling that the Session should be re-fetched (RFC 8620 §2).
 */
export function sessionStateChanged(
  session: Session,
  response: Pick<JmapResponse, 'sessionState'>,
): boolean {
  return session.state !== response.sessionState
}
