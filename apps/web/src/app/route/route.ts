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
    return { id: 'contacts', path, params: {}, rest: '', search }
  }
  if (head === 'settings') {
    return { id: 'settings', path, params: {}, rest: parts.slice(1).join('/'), search }
  }
  return { id: 'notFound', path, params: {}, rest: '', search }
}

/** Build the base-relative mail route path for a mailbox/email selection. */
export function mailPath(mailboxId?: string, emailId?: string): string {
  if (mailboxId === undefined) return '/mail'
  if (emailId === undefined) return `/mail/${mailboxId}`
  return `/mail/${mailboxId}/${emailId}`
}

/** Build the base-relative settings route path for an optional sub-section. */
export function settingsPath(sub?: string): string {
  return sub === undefined || sub === '' ? '/settings' : `/settings/${sub}`
}

export const CONTACTS_PATH = '/contacts'
