/**
 * Hermetic fakes for the session/shell tests (M1.4). They stand in for the two impure
 * boundaries the {@link ShellServices} seam exposes — `connect` and the `AuthController` — so
 * every RTL/axe test runs with no network and no real WebCrypto. `makeFakeServices` returns the
 * services to inject plus spies and an `expire()` hook to drive the FR-AUTH-06 re-auth funnel.
 */

import type { AuthProvider, JmapClient } from '@waxwing/jmap'
import { vi } from 'vitest'
import type { AuthController, AuthSession } from '../../auth'
import { AuthExpiredError } from '../../auth'
import type { ShellServices } from '../services'

const JMAP_MAIL = 'urn:ietf:params:jmap:mail'

export function fakeJmapSession(accountId = 'acc-1', username = 'alice@waxwing.test') {
  return {
    username,
    state: 'state-0',
    primaryAccounts: { [JMAP_MAIL]: accountId },
    accounts: { [accountId]: { name: username } },
  } as unknown as JmapClient['session']
}

export function fakeJmapClient(session = fakeJmapSession()): JmapClient {
  return { session } as unknown as JmapClient
}

export interface FakeServicesOptions {
  /** Boot as if returning from an OAuth redirect (?code&state present). */
  readonly isRedirectCallback?: boolean
  /** A restorable persisted session (offline/cold start). */
  readonly restore?: AuthSession | null
  /** Same-origin probe result (FR-AUTH-01). Default: present. */
  readonly probePresent?: boolean
  /** Whether OAuth is offered (secure context). Default: true. */
  readonly oauthAvailable?: boolean
  /** When set, `connect()` rejects with it (login/connect error paths). */
  readonly connectError?: Error
}

export interface FakeServices {
  readonly services: Partial<ShellServices>
  readonly spies: {
    readonly connect: ReturnType<typeof vi.fn>
    readonly startLogin: ReturnType<typeof vi.fn>
    readonly logout: ReturnType<typeof vi.fn>
    readonly navigate: ReturnType<typeof vi.fn>
    readonly completeRedirect: ReturnType<typeof vi.fn>
    readonly restore: ReturnType<typeof vi.fn>
  }
  /** Make the connected provider's next `authorization()` throw AuthExpiredError. */
  expire(): void
  /** The (reauth-wrapped) provider last handed to `connect()`. */
  capturedProvider(): AuthProvider | null
}

export function makeFakeServices(options: FakeServicesOptions = {}): FakeServices {
  let expired = false
  let captured: AuthProvider | null = null

  const navigate = vi.fn()
  const logout = vi.fn(async () => {})
  const completeRedirect = vi.fn(async () => fakeAuthSession('oauth'))
  const restore = vi.fn(async () => options.restore ?? null)
  const startLogin = vi.fn(async (request: { method: 'oauth' | 'basic' }) => {
    if (request.method === 'oauth') {
      navigate('oauth')
      return { kind: 'redirect', url: 'about:blank' }
    }
    return { kind: 'session' }
  })
  const connect = vi.fn(async (_input: string, provider: AuthProvider) => {
    captured = provider
    if (options.connectError) throw options.connectError
    return fakeJmapClient()
  })

  const provider: AuthProvider = {
    scheme: 'bearer',
    authorization() {
      if (expired) throw new AuthExpiredError('dead refresh')
      return 'Bearer test-token'
    },
  }

  const controller = {
    isRedirectCallback: () => options.isRedirectCallback ?? false,
    completeRedirect,
    restore,
    getAuthProvider: () => provider,
    startLogin,
    logout,
    getAccessToken: vi.fn(async () => 'test-token'),
    refresh: vi.fn(async () => {}),
    getSession: vi.fn(() => null),
  } as unknown as AuthController

  const services: Partial<ShellServices> = {
    connect: connect as unknown as ShellServices['connect'],
    makeAuthController: () => controller,
    oauthIsAvailable: () => options.oauthAvailable ?? true,
    probe: async () => options.probePresent ?? true,
  }

  return {
    services,
    spies: { connect, startLogin, logout, navigate, completeRedirect, restore },
    expire() {
      expired = true
    },
    capturedProvider: () => captured,
  }
}

export function fakeAuthSession(method: AuthSession['method']): AuthSession {
  return {
    method,
    username: method === 'basic' ? 'alice@waxwing.test' : null,
    expiresAt: null,
    authProvider: {
      scheme: method === 'basic' ? 'basic' : 'bearer',
      authorization: () => 'Bearer test-token',
    },
  }
}
