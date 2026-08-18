/**
 * Router context + value type (M1.4, ADR-007). Split from {@link RouterProvider} so hooks and
 * `Link` can consume the context without importing the provider (avoids a cycle) and so the
 * pure {@link RouteMatch} type stays in `route.ts`.
 */

import { createContext } from 'react'
import type { RouteMatch } from './route'

export interface NavigateOptions {
  readonly replace?: boolean
  /**
   * Written into `history.state`. One caller needs it: opening a message pushes an entry so the
   * OS/browser back gesture returns to the list, and the on-screen Back button has to be able to
   * tell "I pushed that entry, so pop it" from "the user deep-linked straight here, so there is
   * nothing of mine to pop". Without the marker the button pushed a THIRD entry and the back
   * gesture then re-opened the message the user had just left.
   */
  readonly state?: unknown
}

/** The imperative router surface exposed to components. `to` values are base-relative. */
export interface Router {
  readonly match: RouteMatch
  navigate(to: string, options?: NavigateOptions): void
  back(): void
  href(to: string): string
}

export const RouterContext = createContext<Router | null>(null)
