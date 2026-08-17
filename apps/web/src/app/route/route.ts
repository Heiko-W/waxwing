/**
 * Pure, DOM-free routing primitives (M1.4, ADR-007).
 *
 * Waxwing ships its own tiny hash-free router instead of a dependency: the route set is
 * closed and small, and the load-bearing requirement — resolving links under an arbitrary
 * mount prefix (Stalwart's `<base href>`, FR-DEP-02) — is a one-liner over `document.baseURI`
 * here but an awkward fight against a library's basename plumbing. These helpers know nothing
 * about React or the DOM, so they unit-test directly.
 *
 * Two coordinate spaces:
 *  - the REAL `location.pathname`, e.g. `/mail/inbox/42` (or `/deploy/mail/inbox/42` when the
 *    app is mounted under `/deploy/`);
 *  - the BASE-RELATIVE route path the app reasons about, e.g. `/mail/inbox/42`.
 * `deriveBase` extracts the prefix from `document.baseURI`; `toPath`/`toHref` convert between
 * the two spaces; `matchRoute` classifies a base-relative path into a {@link RouteMatch}.
 */

export type RouteId = 'mail' | 'contacts' | 'settings' | 'notFound'

export interface RouteMatch {
  readonly id: RouteId
  /** Base-relative, leading slash, no search/hash — e.g. `/mail/inbox/42`. */
  readonly path: string
  /** Route params; an absent optional segment is `undefined` (noUncheckedIndexedAccess). */
  readonly params: Readonly<Record<string, string | undefined>>
  /** Splat remainder for `/settings/*` (e.g. `identities`); `''` otherwise. */
  readonly rest: string
  /** Live `location.search` params. Carries the OAuth `?code&state` but never affects matching. */
  readonly search: URLSearchParams
}

/** The canonical home route the app redirects `/` to. */
export const HOME_PATH = '/mail'

/**
 * The base-relative path prefix from `document.baseURI`, with any trailing slash removed.
 *
 * `https://host/`            → `''`
 * `https://host/deploy/mail/`→ `/deploy/mail`
 * `https://host/mail`        → `/mail` (Stalwart may emit `<base href>` without a slash)
 */
export function deriveBase(baseUri: string): string {
  let pathname: string
  try {
    pathname = new URL(baseUri).pathname
  } catch {
    pathname = baseUri
  }
  return pathname === '/' ? '' : pathname.replace(/\/$/, '')
}

/** Base-relative route path → real href, e.g. (`/mail`, `/contacts`) → `/mail/contacts`. */
export function toHref(base: string, path: string): string {
  const rel = path.startsWith('/') ? path : `/${path}`
  return `${base}${rel}` || '/'
}

/** Real pathname → base-relative route path, e.g. (`/mail`, `/mail/contacts`) → `/contacts`. */
export function toPath(base: string, pathname: string): string {
  if (base !== '' && (pathname === base || pathname.startsWith(`${base}/`))) {
    const rest = pathname.slice(base.length)
    return rest === '' ? '/' : rest
  }
  return pathname === '' ? '/' : pathname
}

/** Non-empty, slash-trimmed segments of a base-relative path. */
function segments(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '')
}

/**
 * Classify a base-relative path into a {@link RouteMatch}. Order matters: `/` and `/mail…`
 * are the primary mail area; `/contacts` and `/settings/*` are secondary; anything else is
 * `notFound`. `search` is passed through untouched (never part of matching).
 */
export function matchRoute(
  base: string,
  location: { pathname: string; search: string },
): RouteMatch {
  const path = toPath(base, location.pathname)
  const search = new URLSearchParams(location.search)
  const parts = segments(path)
  const head = parts[0]

  if (head === undefined || head === 'mail') {
    const params: Record<string, string | undefined> = {
      mailboxId: parts[1],
      emailId: parts[2],
    }
    return { id: 'mail', path, params, rest: '', search }
  }
  if (head === 'contacts') {
    const params: Record<string, string | undefined> = {
      bookId: parts[1],
      cardId: parts[2],
    }
    return { id: 'contacts', path, params, rest: '', search }
  }
  if (head === 'settings') {
    return { id: 'settings', path, params: {}, rest: parts.slice(1).join('/'), search }
  }
  return { id: 'notFound', path, params: {}, rest: '', search }
}

/** The search key naming the account a mail route acts in (B37). Absent ⇒ the user's own account. */
export const ACCOUNT_PARAM = 'account'

/**
 * Build the base-relative mail route path for a mailbox/email selection.
 *
 * `accountId` qualifies the route with `?account=` when it names a DELEGATED account (B37). JMAP
 * mailbox and email ids are per-account and short, so `/mail/a/e1` alone is ambiguous: reloaded, or
 * followed from a notification, it would resolve against the user's OWN account — where `a` is very
 * likely a real, different mailbox. The route would then show the wrong mail while looking entirely
 * correct, which is the same collision class M4.4 stage 4 closed for writes.
 *
 * A query parameter rather than a path segment, and additively: every existing link stays valid and
 * keeps meaning "my own account", so the single-account path is byte-for-byte unchanged. (Bulwark
 * reaches the same conclusion for the same reason — its `?account=` carries exactly this.)
 *
 * Passing the PRIMARY account's id is allowed and is not a mistake: `resolveActiveAccount` vets the
 * id against the granted set and the primary is in it, so the result is identical to omitting it.
 * That matters for callers that cannot tell the two apart — the notification click path
 * (`notify/click-route.ts`) qualifies unconditionally, because an omitted account is not "mine", it
 * is "whatever `carryAccount` finds on the route the user happens to be looking at".
 */
export function mailPath(mailboxId?: string, emailId?: string, accountId?: string): string {
  const suffix = accountId === undefined ? '' : `?${ACCOUNT_PARAM}=${encodeURIComponent(accountId)}`
  if (mailboxId === undefined) return `/mail${suffix}`
  if (emailId === undefined) return `/mail/${mailboxId}${suffix}`
  return `/mail/${mailboxId}/${emailId}${suffix}`
}

/** Build the base-relative settings route path for an optional sub-section. */
export function settingsPath(sub?: string): string {
  return sub === undefined || sub === '' ? '/settings' : `/settings/${sub}`
}

export const CONTACTS_PATH = '/contacts'

/**
 * Build the base-relative contacts route path for an address-book / card selection (M4.2). Mirrors
 * {@link mailPath}: `/contacts`, `/contacts/:bookId`, `/contacts/:bookId/:cardId`. A `cardId` is
 * ignored without a `bookId`, since the card is addressed relative to the book that owns the list.
 */
export function contactsPath(bookId?: string, cardId?: string): string {
  if (bookId === undefined) return CONTACTS_PATH
  if (cardId === undefined) return `${CONTACTS_PATH}/${bookId}`
  return `${CONTACTS_PATH}/${bookId}/${cardId}`
}
