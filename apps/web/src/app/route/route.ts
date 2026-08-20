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

export type RouteId = 'mail' | 'contacts' | 'calendar' | 'files' | 'settings' | 'notFound'

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
  if (head === 'calendar') {
    // `/calendar` and `/calendar/:isoDate` — the date the view is centred on (M5.6). A date is a
    // param rather than a query so a link to a specific day is an ordinary URL.
    const params: Record<string, string | undefined> = { date: parts[1] }
    return { id: 'calendar', path, params, rest: '', search }
  }
  if (head === 'files') {
    // `/files` and `/files/:nodeId` — the folder being browsed (M5.7).
    const params: Record<string, string | undefined> = { nodeId: parts[1] }
    return { id: 'files', path, params, rest: '', search }
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
/**
 * The query flag that says "show this message on its own".
 *
 * A flag on the existing mail route rather than a route of its own, for two reasons that are both
 * about not losing things: `carryAccount` only forwards `?account=` to paths beginning `/mail`, so a
 * top-level `/message/...` would silently drop a delegated account (B37's failure, re-created); and
 * the reading pane is already able to render alone — `computePaneLayout` produces exactly this
 * layout for a phone and for `reading pane: off`. Full screen is therefore a VIEW of the message
 * the reader is already on, which is also why Escape and Back get out of it for free.
 */
export const FULL_PARAM = 'full'

/** The current message, alone: no list, no folder rail. */
export function mailFullPath(mailboxId: string, emailId: string, accountId?: string): string {
  const base = mailPath(mailboxId, emailId, accountId)
  return `${base}${base.includes('?') ? '&' : '?'}${FULL_PARAM}=1`
}

export function mailPath(mailboxId?: string, emailId?: string, accountId?: string): string {
  const suffix = accountId === undefined ? '' : `?${ACCOUNT_PARAM}=${encodeURIComponent(accountId)}`
  if (mailboxId === undefined) return `/mail${suffix}`
  if (emailId === undefined) return `/mail/${mailboxId}${suffix}`
  return `/mail/${mailboxId}/${emailId}${suffix}`
}

/**
 * A mail URL that KEEPS the current query string — `?q=` (search), `?label=` and `?account=` are
 * what the list is currently showing.
 *
 * This lived as a private helper in the shortcut registry, which is how the two ways of going "back
 * to the list" came to disagree: `u` kept the query, while the on-screen Back button called
 * `mailPath()` bare and dropped it. Dropping it snaps the list back to the plain folder, which
 * changes the window key and therefore resets focus and selection out from under the user
 * mid-triage — the registry's own comment said so, next to the implementation that got it right.
 * On a phone the button is the ONLY way back, so the wrong half was the one that mattered most.
 */
export function mailHrefKeepingQuery(
  search: URLSearchParams,
  mailboxId?: string,
  emailId?: string,
  options: { readonly full?: boolean } = {},
): string {
  // …except `full`, which describes the MESSAGE view and means nothing on the list. Carried back it
  // would put the reader in a full-screen list — a state with no way out and no name. It is set
  // here, deliberately, rather than appended by the caller: one place decides whether this URL is a
  // full-screen one, so "open" and "open full" cannot drift apart in what else they keep.
  const kept = new URLSearchParams(search)
  kept.delete(FULL_PARAM)
  if (options.full === true) kept.set(FULL_PARAM, '1')
  const qs = kept.toString()
  return mailPath(mailboxId, emailId) + (qs ? `?${qs}` : '')
}

/**
 * The `history.state` stamp on the entry that opening a message pushes.
 *
 * It exists so the Back button can distinguish two situations the URL alone cannot: the user
 * arrived here by opening a row (our push is on top of the stack — pop it, which restores the
 * previous URL, its query string and its scroll position for free), or the user deep-linked /
 * followed a notification straight into the message (nothing of ours to pop — replace, so the
 * history does not grow a phantom entry pointing back at the message they just left).
 */
export const READING_HISTORY_MARK = 'waxwing:reading'

/** True when `history.state` is the entry {@link READING_HISTORY_MARK} describes. */
export function isReadingHistoryEntry(state: unknown): boolean {
  return typeof state === 'object' && state !== null && 'waxwing' in state
    ? (state as { waxwing?: unknown }).waxwing === READING_HISTORY_MARK
    : false
}

/** Build the base-relative settings route path for an optional sub-section. */
export function settingsPath(sub?: string): string {
  return sub === undefined || sub === '' ? '/settings' : `/settings/${sub}`
}

export const CONTACTS_PATH = '/contacts'

export const FILES_PATH = '/files'

export const CALENDAR_PATH = '/calendar'

/** `/calendar`, or `/calendar/2026-08-20` for a specific day (M5.6). */
export function calendarPath(isoDate?: string): string {
  return isoDate === undefined ? CALENDAR_PATH : `${CALENDAR_PATH}/${isoDate}`
}

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
