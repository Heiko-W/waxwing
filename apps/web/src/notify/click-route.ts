/**
 * Where a clicked notification lands (M3.6) — pure and DOM-free, because it is imported by the
 * SERVICE WORKER (`src/sw/sw.ts`), which compiles in its own program (`tsconfig.sw.json`,
 * `lib: WebWorker`, `types: []`). Nothing here may touch `window`, `document` or React.
 *
 * **It imports `../app/route/route`, the module, and never `../app/route`, the barrel.** The barrel
 * re-exports `Link.tsx` and `RouterProvider.tsx`; that would drag React into the worker program (a
 * typecheck failure) and into `sw.js` (a bundle we would then ship to every visitor).
 *
 * Two coordinate spaces meet here and must not be confused:
 *  - the DEPLOYMENT root — `/` or, under Stalwart's Applications mount, `/mail/` — which is what
 *    `appRoot(self.location.href)` reads off the worker's own URL, and
 *  - the app's own ROUTE space, whose mail area also happens to be called `/mail`.
 * Under a `/mail/` mount the href for message 42 is therefore `/mail/mail/inbox/42`. That looks wrong
 * and is right; a leading-slash literal would 404.
 */

import { mailPath, matchRoute, toHref } from '../app/route/route'

/**
 * The click target carried on a notification. Ids only — never content: it lives on in the OS
 * notification shade, which we do not control and cannot clear.
 *
 * It is declared HERE, not in `notify-model.ts`, and that is load-bearing. `sw.ts` imports this
 * module, so everything this module can reach — even through a type-only import — is typechecked
 * under `lib: WebWorker`. `notify-model.ts` reaches `permission.ts` (which touches `window`) and
 * `sync/db.ts` (Dexie); pulling the type from there would break the worker program. The dependency
 * runs model → click-route, never back.
 */
export interface MailNotificationData {
  readonly kind: 'mail' | 'summary'
  readonly accountId: string
  readonly mailboxId: string | null
  readonly emailId: string | null
}

/** SW → page: "the user clicked a notification; go here." */
export const NOTIFY_CLICK = 'NOTIFY_CLICK'

export interface NotifyClickMessage {
  readonly type: typeof NOTIFY_CLICK
  /**
   * A base-relative ROUTE path, e.g. `/mail/inbox/42?account=s2` — never an href. It carries the
   * `?account=` query whenever the notification named an account (see
   * {@link notificationTargetPath}), so the page must treat it as a path *and* search, not just a
   * pathname.
   */
  readonly path: string
}

export function isMailNotificationData(value: unknown): value is MailNotificationData {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (v.kind !== 'mail' && v.kind !== 'summary') return false
  if (typeof v.accountId !== 'string') return false
  if (v.mailboxId !== null && typeof v.mailboxId !== 'string') return false
  return v.emailId === null || typeof v.emailId === 'string'
}

export function isNotifyClickMessage(value: unknown): value is NotifyClickMessage {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return v.type === NOTIFY_CLICK && typeof v.path === 'string'
}

/** The deployment root (`/` or `/mail/`) → the router's base (`''` or `/mail`). */
export function routeBase(root: string): string {
  return root === '/' ? '' : root.replace(/\/$/, '')
}

/**
 * The route a click opens: the message if we have one, else its folder, else the mail home. Never
 * throws — the `data` came back through structured clone from the OS notification shade, and a
 * notification that survived a browser restart with a shape we no longer recognise must still open
 * the app rather than kill the click handler.
 *
 * **The `accountId` is always passed through to `mailPath`, including when it names the user's own
 * account** (B37). It is not decoration and it is not only about delegation: without it the path
 * arrives at `navigate()` unqualified, and `carryAccount` (RouterProvider.tsx) then fills the gap
 * from whatever the CURRENT route says. So a user reading a shared account at `/mail/x?account=s2`
 * who taps a banner for their OWN inbox would inherit `?account=s2` — and the short, per-account
 * JMAP ids in the banner would very likely hit a real, different mailbox/message over there. Wrong
 * mail, in a URL that reads as correct. Qualifying unconditionally also means the app never has to
 * know here which of the accounts is primary; `resolveActiveAccount` vets the id against the granted
 * set anyway, so naming the primary explicitly is a no-op rather than a second code path.
 *
 * The unrecognised-shape fallback is the one path left unqualified, deliberately: there is no id to
 * qualify it with, and `/mail` names no mailbox and no message, so inheriting the current account
 * lands the user on a mail home rather than on the wrong message.
 */
export function notificationTargetPath(data: unknown): string {
  if (!isMailNotificationData(data)) return mailPath()
  if (data.mailboxId === null) return mailPath(undefined, undefined, data.accountId)
  if (data.emailId === null) return mailPath(data.mailboxId, undefined, data.accountId)
  return mailPath(data.mailboxId, data.emailId, data.accountId)
}

/** The same target as a real href under the deployment root — for `clients.openWindow()`. */
export function notificationTargetHref(root: string, data: unknown): string {
  return toHref(routeBase(root), notificationTargetPath(data))
}

/**
 * Is this window client one of OUR pages? A worker sees clients from anywhere on the origin — the
 * Stalwart admin portal at `/admin/`, its sign-in SPA at `/login`, another webmail on another prefix.
 * Focusing one of those and posting it a route would be, at best, baffling.
 *
 * Being under the deployment root is necessary but **not sufficient**, and at the recommended
 * root-mounted deployment it is not even a filter: `startsWith('/')` is true of every page on the
 * host. So the path must also resolve to a route this app actually serves — `matchRoute` calls
 * everything else `notFound`, which is exactly the question being asked. `/admin/users` and `/login`
 * are then rejected at `/` just as they are under `/mail/`.
 */
export function isAppClient(clientUrl: string, workerHref: string): boolean {
  let client: URL
  let worker: URL
  try {
    client = new URL(clientUrl)
    worker = new URL(workerHref)
  } catch {
    return false
  }
  if (client.origin !== worker.origin) return false
  const root = new URL('./', worker).pathname
  const underRoot = client.pathname === root.replace(/\/$/, '') || client.pathname.startsWith(root)
  if (!underRoot) return false
  const match = matchRoute(routeBase(root), { pathname: client.pathname, search: '' })
  return match.id !== 'notFound'
}
