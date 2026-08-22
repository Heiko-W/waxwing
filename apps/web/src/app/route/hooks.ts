/** Router hooks (M1.4). Thin readers over {@link RouterContext}. */

import { useContext } from 'react'
import { type Router, RouterContext } from './context'
import type { RouteMatch } from './route'

export function useRouter(): Router {
  const router = useContext(RouterContext)
  if (router === null) {
    throw new Error('useRouter must be used within a RouterProvider')
  }
  return router
}

/**
 * The router if there is one, `null` otherwise.
 *
 * For a component that is USEFUL without navigation and merely offers a shortcut with it — the
 * quota bar's "find the large messages" link is the first. `useRouter` throwing is right for
 * anything whose job IS to navigate; a sidebar meter that dies because a test rendered it on its
 * own is not.
 */
export function useRouterOptional(): Router | null {
  return useContext(RouterContext)
}

export function useRoute(): RouteMatch {
  return useRouter().match
}

export function useNavigate(): Router['navigate'] {
  return useRouter().navigate
}
