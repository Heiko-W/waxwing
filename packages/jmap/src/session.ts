import type { AuthProvider } from './auth'
import { Capabilities } from './capabilities'
import { errorFromResponse } from './errors'
import type { FetchLike } from './transport'
import { getWithAuth, resolveFetch } from './transport'
import type {
  CoreCapability,
  Id,
  JmapResponse,
  Session,
  WebPushVapidCapability,
} from './types/core'
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
 * Reads the RFC 9749 VAPID capability — the server's Web-Push signing key.
 *
 * `null` means the server cannot sign a Web Push, and therefore **cannot deliver a notification
 * while the app is closed** on Chromium or Safari: both refuse `PushManager.subscribe()` without an
 * `applicationServerKey`, and the push service then rejects an unsigned POST (RFC 8292 §4.2).
 *
 * No JMAP server advertises this today (ADR-010). The probe exists so the app can say so honestly
 * (NFR-PRIV-02) instead of offering a switch that could never work — and so it lights up by itself
 * the day a server ships the capability.
 */
export function getWebPushVapidCapability(session: Session): WebPushVapidCapability | null {
  const value = session.capabilities[Capabilities.webPushVapid]
  return isWebPushVapidCapability(value) ? value : null
}

function isWebPushVapidCapability(value: unknown): value is WebPushVapidCapability {
  if (typeof value !== 'object' || value === null) return false
  const key = (value as Record<string, unknown>).applicationServerKey
  return typeof key === 'string' && key !== ''
}

/**
 * Is `urn` advertised — at session level, or for `accountId` (RFC 8620 §2)?
 *
 * **Both levels must be checked, and that is not pedantry.** A capability object in `capabilities`
 * announces what the SERVER implements; the copy in an account's `accountCapabilities` announces
 * what may be invoked on THAT account, and a server is free to fill in only one of them. Stalwart
 * advertises `urn:ietf:params:jmap:mail` at both levels but leaves the session-level object EMPTY
 * (`{}`), keeping every real limit in the account object — so a check (or a settings panel) built on
 * `session.capabilities` alone reads as "no mail limits" against the server we test against.
 *
 * This is a PRESENCE predicate only. To read a capability's contents use {@link getCoreCapability} /
 * {@link getMailCapability}, which each look in the right place.
 */
export function hasCapability(session: Session, urn: string, accountId?: Id): boolean {
  // Both maps are REQUIRED by RFC 8620 §2 — and are still not trusted to be there. A server that
  // omits them is non-conformant, but "this feature is unavailable" is the right answer to that; a
  // TypeError out of a capability probe would take down whatever mounted it.
  if (has(session.capabilities, urn)) return true
  if (accountId === undefined) return false
  return has(session.accounts?.[accountId]?.accountCapabilities, urn)
}

function has(map: Record<string, unknown> | undefined, urn: string): boolean {
  return typeof map === 'object' && map !== null && Object.hasOwn(map, urn)
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
