/**
 * The History-API router provider (M1.4, ADR-007). Holds the current {@link RouteMatch} in
 * state and keeps it in sync with `window.location`: it owns state transitions for its own
 * `navigate` (pushState/replaceState do NOT emit `popstate`) and listens for `popstate` to
 * catch the browser back/forward buttons.
 *
 * The base prefix comes from the `<base href>` element (which Stalwart rewrites to the mount
 * prefix, FR-DEP-02), defaulting to root when absent. It deliberately does NOT read
 * `document.baseURI`: without a `<base>` element that resolves to the CURRENT document URL, so a
 * deep link would be mistaken for the mount prefix. Tests inject `baseUri` directly.
 */

import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { type NavigateOptions, type Router, RouterContext } from './context'
import { ACCOUNT_PARAM, deriveBase, matchRoute, type RouteMatch, toHref } from './route'

/**
 * Carry `?account=` across a navigation inside the mail area (B37).
 *
 * The parameter names which account a mailbox/email id belongs to, and those ids are per-account and
 * short — so losing it on the first click would put the app back where it started: a URL that reads
 * as the user's OWN mailbox `a` while the pane shows a delegated one. Done here, once, rather than
 * at each `mailPath` call site, because most of them build their own query string and would have to
 * remember; forgetting would be silent.
 *
 * Only for `/mail` targets, only when the destination does not name an account itself (an explicit
 * choice wins), and never for a link that leaves the mail area — settings and contacts are the user's
 * own by definition.
 *
 * "An explicit choice wins" is load-bearing for anything that navigates from OUTSIDE the current
 * route's frame of reference: a notification click carries its own account and arrives through this
 * same `navigate`, so an unqualified target would silently adopt the account the user is currently
 * reading (`notify/click-route.ts` qualifies for exactly that reason). This function cannot tell the
 * two apart, which is why the qualifying happens at the source rather than being special-cased here.
 */
export function carryAccount(to: string, currentSearch: string): string {
  if (!to.startsWith('/mail')) return to
  const [path, query = ''] = to.split('?', 2)
  const target = new URLSearchParams(query)
  if (target.has(ACCOUNT_PARAM)) return to
  const account = new URLSearchParams(currentSearch).get(ACCOUNT_PARAM)
  if (account === null) return to
  target.set(ACCOUNT_PARAM, account)
  return `${path}?${target.toString()}`
}

export interface RouterProviderProps {
  /** Overrides the `<base href>` lookup (tests / non-default mounts). */
  readonly baseUri?: string
  readonly children: ReactNode
}

/** The `<base href>` value (Stalwart's mount prefix), or `/` when no `<base>` is present. */
function readBaseHref(): string {
  return document.querySelector('base')?.getAttribute('href') ?? '/'
}

export function RouterProvider({ baseUri, children }: RouterProviderProps) {
  const base = useMemo(() => deriveBase(baseUri ?? readBaseHref()), [baseUri])
  const [match, setMatch] = useState<RouteMatch>(() => matchRoute(base, window.location))

  const navigate = useCallback(
    (to: string, options?: NavigateOptions) => {
      const url = toHref(base, carryAccount(to, window.location.search))
      if (options?.replace) {
        window.history.replaceState(null, '', url)
      } else {
        window.history.pushState(null, '', url)
      }
      setMatch(matchRoute(base, window.location))
    },
    [base],
  )

  const back = useCallback(() => {
    window.history.back()
  }, [])

  const href = useCallback((to: string) => toHref(base, to), [base])

  useEffect(() => {
    // Resync on base change (injected baseUri) and on every browser history navigation.
    setMatch(matchRoute(base, window.location))
    const onPopState = (): void => setMatch(matchRoute(base, window.location))
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [base])

  const value = useMemo<Router>(
    () => ({ match, navigate, back, href }),
    [match, navigate, back, href],
  )

  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>
}
