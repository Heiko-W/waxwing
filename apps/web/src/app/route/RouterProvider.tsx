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
import { deriveBase, matchRoute, type RouteMatch, toHref } from './route'

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
      const url = toHref(base, to)
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
