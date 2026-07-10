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

export function useRoute(): RouteMatch {
  return useRouter().match
}

export function useNavigate(): Router['navigate'] {
  return useRouter().navigate
}
