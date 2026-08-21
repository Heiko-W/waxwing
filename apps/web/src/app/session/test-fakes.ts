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

/**
 * A minimal but STRUCTURALLY CONFORMANT session. `capabilities` and `accountCapabilities` are present
 * and empty by default — a session object without them is not something a JMAP server may send
 * (RFC 8620 §2), and a fake that omits them tests the app against a server that cannot exist.
 * Pass `capabilities` to make a feature appear (M3.7: quota, vacation).
 */
/** A delegated/shared account to add alongside the primary in {@link fakeJmapSession} (M4.4). */
export interface FakeSharedAccount {
  readonly id: string
  readonly name?: string
  readonly isReadOnly?: boolean
  /**
   * Whether the share carries the mail capability at ACCOUNT level (default true).
   *
   * **`mail: false` is a server that does not exist, and it is kept on purpose.** Measured against
   * Stalwart v0.16.18 on 2026-08-21: sharing one CALENDAR made the account appear with ALL
   * SEVENTEEN capabilities, `urn:ietf:params:jmap:mail` among them — the session never narrows.
   * What this flag exercises is `secondaryMailAccounts()`'s account-level filter in isolation,
   * which is a real unit and still the right first gate. The behaviour against the real server is
   * pinned by `sharing/probe.ts` and `mail/AccountTrees.sharing.test.tsx`, which model the
   * capability as always-present and let a `forbidden` on `Mailbox/get` be the answer instead.
   */
  readonly mail?: boolean
}

export function fakeJmapSession(
  accountId = 'acc-1',
  username = 'alice@waxwing.test',
  options: {
    readonly capabilities?: Record<string, unknown>
    readonly accountCapabilities?: Record<string, unknown>
    /** Delegated accounts to expose beyond the user's own (M4.4). */
    readonly shared?: readonly FakeSharedAccount[]
  } = {},
) {
  const accounts: Record<string, unknown> = {
    [accountId]: {
      name: username,
      isPersonal: true,
      isReadOnly: false,
      accountCapabilities: options.accountCapabilities ?? {},
    },
  }
  for (const share of options.shared ?? []) {
    accounts[share.id] = {
      name: share.name ?? share.id,
      isPersonal: false,
      isReadOnly: share.isReadOnly ?? false,
      // A calendars/contacts-only share (`mail: false`) carries no mail capability, so the
      // account-level filter must exclude it (M4.4). See the note on `mail` above for why the real
      // server does not behave this way, and what covers that instead.
      accountCapabilities: (share.mail ?? true) ? { [JMAP_MAIL]: {} } : {},
    }
  }
  return {
    username,
    state: 'state-0',
    apiUrl: 'https://mail.waxwing.test/jmap/',
    capabilities: options.capabilities ?? {},
    primaryAccounts: { [JMAP_MAIL]: accountId },
    accounts,
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
  /** When set, `startLogin()` rejects with it — the OAuth-discovery failure path. */
  readonly startLoginError?: Error
  /** The session `connect()` resolves to. Default: {@link fakeJmapSession} (single account). */
  readonly session?: JmapClient['session']
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
    if (options.startLoginError) throw options.startLoginError
    if (request.method === 'oauth') {
      navigate('oauth')
      return { kind: 'redirect', url: 'about:blank' }
    }
    return { kind: 'session' }
  })
  const connect = vi.fn(async (_input: string, provider: AuthProvider) => {
    captured = provider
    if (options.connectError) throw options.connectError
    return fakeJmapClient(options.session ?? fakeJmapSession())
  })

  const provider: AuthProvider = {
    scheme: 'bearer',
    authorization() {
      if (expired) throw new AuthExpiredError('dead refresh')
      return 'Bearer test-token'
    },
  }

  const controller = {
    isRedirectCallback: async () => options.isRedirectCallback ?? false,
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
