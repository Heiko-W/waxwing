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
import type { ProbeResult, ShellServices } from '../services'

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
    /**
     * The origin all four URL templates sit on. Default: a server that is NOT this document's
     * origin, which is the honest default for a webmail client talking to a mail host.
     *
     * A test that stores this document and reboots offline (FR-OFF-01) has to pass the app's own
     * origin, because `sessionFromStore` re-runs the origin check against the connect URL — see
     * `packages/jmap/src/session.ts`. That is not a harness wrinkle: it is the check working.
     */
    readonly origin?: string
  } = {},
) {
  const origin = options.origin ?? 'https://mail.waxwing.test'
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
    // All four URL templates, because a Session without them is not one a server may send (RFC
    // 8620 §2) — and `sessionFromStore` refuses a stored document that lacks any of them.
    apiUrl: `${origin}/jmap/`,
    downloadUrl: `${origin}/jmap/download/{accountId}/{blobId}/{name}?accept={type}`,
    uploadUrl: `${origin}/jmap/upload/{accountId}/`,
    eventSourceUrl: `${origin}/jmap/eventsource/?types={types}&closeafter={closeafter}&ping={ping}`,
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
  /**
   * The probe's THIRD answer: nobody replied (FR-OFF-01). Overrides {@link probePresent}.
   *
   * Its own option rather than a third value on the boolean, because "no answer" is not a
   * degree of "no server" — that conflation is the defect this exists to pin.
   */
  readonly probeResult?: ProbeResult
  /** Whether OAuth is offered (secure context). Default: true. */
  readonly oauthAvailable?: boolean
  /** When set, `connect()` rejects with it (login/connect error paths). */
  readonly connectError?: Error
  /** When set, `startLogin()` rejects with it — the OAuth-discovery failure path. */
  readonly startLoginError?: Error
  /** When set, `completeRedirect()` rejects with it — a stale or replayed PKCE transaction. */
  readonly completeRedirectError?: Error
  /**
   * A JMAP Session document already in the credential store (FR-OFF-01, the offline cold start).
   *
   * Seeds `recallJmapSession()`. `connectUrl` defaults to whatever the boot target resolves to,
   * so the common case is just `{ document: fakeJmapSession() }`.
   */
  readonly storedJmapSession?: { readonly connectUrl?: string; readonly document: unknown } | null
  /** The session `connect()` resolves to. Default: {@link fakeJmapSession} (single account). */
  readonly session?: JmapClient['session']
  /**
   * The whole client `connect()` resolves to, when a test needs one that can ANSWER (S-4).
   *
   * {@link fakeJmapClient} carries a session and no `call`, which is right for the auth flows and
   * makes the delegation probe fail harmlessly (a failed probe grants everything — see
   * `sharing/probe.ts`). A test about what the probe DOES has to supply a client that replies.
   */
  readonly client?: JmapClient
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
    /** What `connectSession` handed to the store after a successful connect (FR-OFF-01). */
    readonly rememberJmapSession: ReturnType<typeof vi.fn>
    /** Every client rebuilt from a stored document — one per offline cold start. */
    readonly clientFromSession: ReturnType<typeof vi.fn>
  }
  /** Make the connected provider's next `authorization()` throw AuthExpiredError. */
  expire(): void
  /**
   * Pull the plug: every further `connect()` fails the way a dead network does (FR-OFF-01).
   *
   * A `TypeError` and nothing else, because that is what a failed `fetch` throws and it is the
   * only error shape the offline path may act on. Does not touch `navigator.onLine` — the test
   * says what the DEVICE believes separately, since the two disagreeing is a case of its own.
   */
  goOffline(): void
  /** Plug it back in. */
  goOnline(): void
  /** The (reauth-wrapped) provider last handed to `connect()`. */
  capturedProvider(): AuthProvider | null
}

export function makeFakeServices(options: FakeServicesOptions = {}): FakeServices {
  let expired = false
  let captured: AuthProvider | null = null

  /**
   * The whole of the credential store this fake models: is there an `AuthRecord`, and what JMAP
   * Session document sits beside it (FR-OFF-01)?
   *
   * Modelled rather than stubbed, because the invariant under test IS the coupling: the real
   * {@link AuthController} writes a document only when it has a record to pair it with, and the
   * paths that establish a new identity drop the old document on the same lines that write the
   * new record. A fake that always stored would make the guard untestable from here.
   */
  let hasAuthRecord = (options.restore ?? null) !== null
  let stored: { connectUrl: string; document: unknown; storedAt: number } | null =
    options.storedJmapSession
      ? {
          connectUrl: options.storedJmapSession.connectUrl ?? window.location.origin,
          document: options.storedJmapSession.document,
          storedAt: 0,
        }
      : null

  const navigate = vi.fn()
  const logout = vi.fn(async () => {
    hasAuthRecord = false
    stored = null
  })
  const completeRedirect = vi.fn(async () => {
    if (options.completeRedirectError) throw options.completeRedirectError
    // A new identity: the previous one's document goes, whether or not this one persists.
    stored = null
    hasAuthRecord = true
    return fakeAuthSession('oauth')
  })
  const restore = vi.fn(async () => options.restore ?? null)
  const startLogin = vi.fn(
    async (request: { method: 'oauth' | 'basic'; staySignedIn?: boolean }) => {
      if (options.startLoginError) throw options.startLoginError
      if (request.method === 'oauth') {
        navigate('oauth')
        return { kind: 'redirect', url: 'about:blank' }
      }
      stored = null
      hasAuthRecord = request.staySignedIn === true
      return { kind: 'session' }
    },
  )
  let unreachable = false
  const connect = vi.fn(async (_input: string, provider: AuthProvider) => {
    captured = provider
    if (unreachable) throw new TypeError('Failed to fetch')
    if (options.connectError) throw options.connectError
    return options.client ?? fakeJmapClient(options.session ?? fakeJmapSession())
  })

  const provider: AuthProvider = {
    scheme: 'bearer',
    authorization() {
      if (expired) throw new AuthExpiredError('dead refresh')
      return 'Bearer test-token'
    },
  }

  const rememberJmapSession = vi.fn(async (connectUrl: string, document: unknown) => {
    if (!hasAuthRecord) return
    stored = { connectUrl, document, storedAt: 0 }
  })
  const recallJmapSession = vi.fn(async () => stored)

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
    rememberJmapSession,
    recallJmapSession,
  } as unknown as AuthController

  const clientFromSession = vi.fn((session: JmapClient['session'], authProvider: AuthProvider) => {
    captured = authProvider
    return options.client ?? fakeJmapClient(session)
  })

  const services: Partial<ShellServices> = {
    connect: connect as unknown as ShellServices['connect'],
    clientFromSession: clientFromSession as unknown as ShellServices['clientFromSession'],
    makeAuthController: () => controller,
    oauthIsAvailable: () => options.oauthAvailable ?? true,
    probe: async () =>
      options.probeResult ?? (options.probePresent === false ? 'absent' : 'present'),
  }

  return {
    services,
    spies: {
      connect,
      startLogin,
      logout,
      navigate,
      completeRedirect,
      restore,
      rememberJmapSession,
      clientFromSession,
    },
    expire() {
      expired = true
    },
    goOffline() {
      unreachable = true
    },
    goOnline() {
      unreachable = false
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
