import type { AuthProvider } from './auth'
import { Capabilities } from './capabilities'
import { errorFromResponse, JmapSessionOriginError } from './errors'
import type { FetchLike } from './transport'
import { getWithAuth, resolveFetch } from './transport'
import type { ContactsCapability } from './types/contacts'
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
 *
 * Each resolved URL must sit on the origin `input` addressed, or the whole session is rejected
 * with a {@link JmapSessionOriginError} — see {@link normalizeSession}.
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
  return normalizeSession(raw, base, connectionOrigin(url))
}

/**
 * The origin the caller configured — `url` resolved against the document, where there is one.
 *
 * Deliberately derived from the REQUEST URL, never from `response.url`: the *Url fields are
 * resolved against the final (post-redirect) response URL, so validating against that same value
 * would let an open redirect on `/.well-known/jmap` nominate its own origin and pass.
 *
 * `null` — check disabled — only where the connection URL is relative AND there is no document to
 * resolve it against: an SSR/worker caller, or a unit test with a mock fetch. A browser always has
 * `location`, so the deployed client always gets an origin to enforce.
 */
function connectionOrigin(url: string): string | null {
  const here = typeof globalThis.location?.href === 'string' ? globalThis.location.href : undefined
  try {
    return new URL(url, here).origin
  } catch {
    return null
  }
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
 * Returns a copy of `session` with the four `*Url` fields resolved to absolute URLs against
 * `base`, and REJECTS the session (throwing {@link JmapSessionOriginError}) if any of them lands
 * on an origin other than `expectedOrigin`.
 *
 * The origin check is what makes "credentials go to the configured JMAP origin and nowhere else"
 * true rather than merely intended: `transport`, `blob` and every push transport attach the
 * `Authorization` header to these URLs unconditionally, so an altered `/.well-known/jmap` response
 * — a MITM, a compromised reverse proxy, an open redirect on the way to it — could otherwise name
 * a foreign host and be handed the credential on the next API call, upload or SSE connect. A
 * differing port or scheme is a differing origin and is treated the same way; Stalwart serves all
 * four endpoints from the origin the session itself was fetched from.
 *
 * What it does NOT do: protect against a hostile JMAP server. That server has already received the
 * credential in the request that produced this session. This closes only the narrower path where
 * an actor can alter the session RESPONSE without reading the credential-bearing request.
 *
 * `expectedOrigin: null` skips the check entirely — see {@link getSession}'s `connectionOrigin`,
 * which produces it only outside a browser. A field that cannot be parsed as an absolute URL
 * (relative value + relative base) fails the check: nothing proves it same-origin.
 */
export function normalizeSession(
  session: Session,
  base: string,
  expectedOrigin: string | null,
): Session {
  const resolved = {
    apiUrl: resolveUrl(session.apiUrl, base),
    downloadUrl: resolveUrl(session.downloadUrl, base),
    uploadUrl: resolveUrl(session.uploadUrl, base),
    eventSourceUrl: resolveUrl(session.eventSourceUrl, base),
  }
  if (expectedOrigin !== null) {
    for (const [field, value] of Object.entries(resolved)) {
      if (originOf(value) !== expectedOrigin) {
        throw new JmapSessionOriginError(field, value, expectedOrigin)
      }
    }
  }
  return { ...session, ...resolved }
}

/** The origin of an absolute URL, or `null` if it is not one. */
function originOf(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
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
 * A mail account lifted out of a {@link Session}, carrying only the fields a client needs to
 * list and route to it (M4.4). Both the user's own account and any delegated/shared mailbox are
 * this shape; `isPersonal` tells them apart, `isReadOnly` gates write actions (RFC 8620 §2).
 */
export interface MailAccount {
  readonly id: Id
  readonly name: string
  readonly isPersonal: boolean
  readonly isReadOnly: boolean
}

/**
 * The delegated/shared mail accounts a Session exposes: every entry of `session.accounts` that
 * (a) is NOT the primary mail account `primaryId` and (b) advertises `urn:ietf:params:jmap:mail`
 * in its OWN `accountCapabilities`. Insertion order of `session.accounts` is preserved.
 *
 * The mail URN is read from the ACCOUNT object, deliberately NOT via {@link hasCapability}: that
 * predicate short-circuits on the session-level `capabilities`, which only announce what the
 * SERVER implements and are present for every account of a mail-capable server. It therefore
 * cannot tell a mail-capable account from one shared for calendars/contacts alone — only the
 * per-account object says mail may be invoked on THAT account (see {@link hasCapability}'s note on
 * why both levels exist). Filtering on it would wrongly include a non-mail share.
 *
 * The limit of that reasoning, measured against Stalwart v0.16.14 and recorded in ADR-020: a
 * per-account capability announces what the SERVER implements for the account, not what THIS user
 * may do with it. A delegated account advertises `urn:ietf:params:jmap:submission` and then answers
 * both `Identity/get` and `EmailSubmission/set` with `forbidden — "You are not an owner"`. So this
 * predicate is sound for deciding "is there mail here to show", and no capability is sound for
 * deciding "may I write/send here" — only `myRights` per mailbox, and ultimately the attempt.
 */
export function secondaryMailAccounts(session: Session, primaryId: Id): MailAccount[] {
  const result: MailAccount[] = []
  for (const [id, account] of Object.entries(session.accounts ?? {})) {
    if (id === primaryId) continue
    if (!has(account.accountCapabilities, Capabilities.mail)) continue
    result.push({
      id,
      name: account.name,
      isPersonal: account.isPersonal,
      isReadOnly: account.isReadOnly,
    })
  }
  return result
}

/**
 * Reads the per-account contacts-capability limits from a Session (RFC 9610 §1.5) — notably
 * `maxAddressBooksPerCard` and `mayCreateAddressBook`. Returns `null` if the account is unknown or
 * did not advertise `urn:ietf:params:jmap:contacts`. Mirrors {@link getMailCapability}, and like it
 * reads the ACCOUNT-level capability object (Stalwart leaves the session-level twin empty).
 */
export function getContactsCapability(session: Session, accountId: Id): ContactsCapability | null {
  const account = session.accounts[accountId]
  if (account === undefined) return null
  const value = account.accountCapabilities[Capabilities.contacts]
  return isContactsCapability(value) ? value : null
}

function isContactsCapability(value: unknown): value is ContactsCapability {
  if (typeof value !== 'object' || value === null) return false
  return typeof (value as Record<string, unknown>).mayCreateAddressBook === 'boolean'
}

/**
 * Reads the RFC 9749 VAPID capability — the server's Web-Push signing key.
 *
 * `null` means the server cannot sign a Web Push, and therefore **cannot deliver a notification
 * while the app is closed** on Chromium or Safari: both refuse `PushManager.subscribe()` without an
 * `applicationServerKey`, and the push service then rejects an unsigned POST (RFC 8292 §4.2).
 *
 * Server support is still the exception rather than the rule, so a client must handle `null` as an
 * ordinary outcome and say what it means rather than offering a switch that cannot work. Stalwart
 * implements RFC 9749 as of v0.16.14 (2026-07-20) and auto-generates the keypair on a fresh install,
 * so a stock server does advertise it; most other JMAP servers do not.
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
