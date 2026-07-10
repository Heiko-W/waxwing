/**
 * Router context + value type (M1.4, ADR-007). Split from {@link RouterProvider} so hooks and
 * `Link` can consume the context without importing the provider (avoids a cycle) and so the
 * pure {@link RouteMatch} type stays in `route.ts`.
 */

import { createContext } from 'react'
import type { RouteMatch } from './route'

export interface NavigateOptions {
  readonly replace?: boolean
}

/** The imperative router surface exposed to components. `to` values are base-relative. */
export interface Router {
  readonly match: RouteMatch
  navigate(to: string, options?: NavigateOptions): void
  back(): void
  href(to: string): string
}

export const RouterContext = createContext<Router | null>(null)
