/**
 * Injectable service seam (M1.4). The shell, onboarding and session provider reach the two
 * impure boundaries — the JMAP `connect()` transport and the `AuthController` — only through
 * this context, so RTL/axe tests supply fakes and run fully hermetically (no network, no real
 * WebCrypto). `connect` already takes an injectable `fetch` and `AuthController` is fully DI,
 * so the fakes are thin. Production wiring uses {@link defaultServices}.
 */

import { connect } from '@waxwing/jmap'
import { createContext, type ReactNode, useContext, useMemo } from 'react'
import { AuthController, DEFAULT_CLIENT_ID, DEFAULT_SCOPES, wipeLocalData } from '../auth'

export interface ShellServices {
  /** `@waxwing/jmap` connect: `(input, AuthProvider, { fetch? }) => Promise<JmapClient>`. */
  readonly connect: typeof connect
  /** Builds an OAuth-capable {@link AuthController} for a given issuer origin. */
  readonly makeAuthController: (issuer: string) => AuthController
  /** OAuth PKCE needs a secure context: `isSecureContext && crypto.subtle`. */
  readonly oauthIsAvailable: () => boolean
  /**
   * FR-AUTH-01 same-origin probe: does a JMAP server answer at `origin`? An unauthenticated
   * GET to `/.well-known/jmap`; Stalwart replies 200 anonymous, 401/403 also mean "present".
   * Only 404/410/network failure count as absent, so `connect()` stays the real arbiter.
   */
  readonly probe: (origin: string) => Promise<boolean>
  /**
   * Drops everything this origin has stored and reloads the page (U2).
   *
   * Here rather than inline in the provider for the reason everything else is here: it is a browser
   * boundary. `location.reload()` is not implemented in jsdom, and a test that verified the wipe by
   * actually performing it would be testing `fake-indexeddb`.
   */
  readonly resetLocalData: () => Promise<void>
}

export const defaultServices: ShellServices = {
  connect,
  makeAuthController: (issuer) =>
    new AuthController({ oauth: { issuer, clientId: DEFAULT_CLIENT_ID, scopes: DEFAULT_SCOPES } }),
  oauthIsAvailable: () =>
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    typeof crypto !== 'undefined' &&
    typeof crypto.subtle !== 'undefined',
  probe: async (origin) => {
    try {
      const response = await fetch(new URL('/.well-known/jmap', origin).href, { cache: 'no-store' })
      return response.status !== 404 && response.status !== 410
    } catch {
      return false
    }
  },
  resetLocalData: async () => {
    await wipeLocalData({
      caches: typeof caches !== 'undefined' ? caches : undefined,
      indexedDB: typeof indexedDB !== 'undefined' ? indexedDB : undefined,
      serviceWorker: navigator.serviceWorker,
    })
    // The web storages too, and by name-blind `clear()`: the durable connect target, the
    // public-computer stash and every preference live there, and "reset this app" that leaves the
    // key which is wedging the boot would be the same dead end one round later.
    try {
      localStorage.clear()
      sessionStorage.clear()
    } catch {
      // Private mode / storage disabled: nothing was stored, nothing to clear.
    }
    // A full navigation, not a router hop: the point is to start the app from nothing, and a
    // reload is the only thing that reliably drops the module-scoped state as well.
    window.location.reload()
  },
}

const ServicesContext = createContext<ShellServices>(defaultServices)

export interface ServicesProviderProps {
  /** Partial override merged over {@link defaultServices}; omit in production. */
  readonly value?: Partial<ShellServices>
  readonly children: ReactNode
}

export function ServicesProvider({ value, children }: ServicesProviderProps) {
  const merged = useMemo<ShellServices>(() => ({ ...defaultServices, ...value }), [value])
  return <ServicesContext.Provider value={merged}>{children}</ServicesContext.Provider>
}

export function useServices(): ShellServices {
  return useContext(ServicesContext)
}
