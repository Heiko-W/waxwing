import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthController } from './controller'
import { OAuthCallbackError } from './errors'
import { DEFAULT_SCOPES } from './oauth'
import type { LockManagerLike } from './refresh-lock'
import { SecretName, SecretStore } from './secret-store'
import type { StartLoginResult } from './types'
import type { WipeEnvironment } from './wipe'

const created: string[] = []
/** A `Storage` over a plain object — this project runs the auth tests in Node, without jsdom. */
function fakeStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial))
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, value),
  }
}

function freshStore(): { store: SecretStore; dbName: string } {
  const dbName = `waxwing-auth-${crypto.randomUUID()}`
  created.push(dbName)
  return { store: new SecretStore({ dbName }), dbName }
}

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(
    created.splice(0).map(
      (name) =>
        new Promise<void>((resolve) => {
          const request = indexedDB.deleteDatabase(name)
          request.onsuccess = () => resolve()
          request.onerror = () => resolve()
          request.onblocked = () => resolve()
        }),
    ),
  )
})

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

const DISCOVERY = {
  issuer: 'http://localhost:18080',
  authorization_endpoint: 'http://localhost:18080/authorize',
  token_endpoint: 'http://localhost:18080/token',
  code_challenge_methods_supported: ['S256'],
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  token_endpoint_auth_methods_supported: ['none'],
  // Deliberately NO revocation_endpoint — mirrors Stalwart v0.16 (FR-AUTH-05 local-wipe path).
}

/** A fake Stalwart OIDC endpoint. Records requests so tests can assert on them. */
function fakeIdp() {
  const calls: { url: string; body: string }[] = []
  let refreshCount = 0
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url
    const body = init?.body ? String(init.body) : ''
    calls.push({ url, body })
    if (url.includes('/.well-known/')) return json(DISCOVERY)
    if (url.includes('/token')) {
      if (body.includes('grant_type=refresh_token')) {
        refreshCount += 1
        // Stalwart reuses the refresh token: no new refresh_token in the response. It also
        // returns an UNSOLICITED id_token on refresh — the controller must strip it.
        return json({
          access_token: `access-refreshed-${refreshCount}`,
          token_type: 'bearer',
          expires_in: 3600,
          id_token: 'unsolicited.refresh.idtoken',
        })
      }
      // Stalwart returns an unsolicited id_token on the code exchange too (ES256); the
      // OAuth2 flow does not consume it, so it must be stripped before oauth4webapi validates.
      return json({
        access_token: 'access-1',
        token_type: 'bearer',
        expires_in: 3600,
        refresh_token: 'refresh-1',
        id_token: 'unsolicited.code.idtoken',
      })
    }
    return new Response('not found', { status: 404 })
  }
  return { fetchImpl, calls }
}

describe('AuthController — OAuth Authorization Code + PKCE', () => {
  it('drives discovery -> redirect -> callback -> silent refresh, tokens stored correctly', async () => {
    const idp = fakeIdp()
    vi.stubGlobal('fetch', idp.fetchImpl)
    const { store, dbName } = freshStore()
    let clock = 1_000_000_000
    let currentHref = 'http://localhost:5173/mail/'
    let navigated: string | null = null

    const controller = new AuthController({
      oauth: { issuer: 'http://localhost:18080', clientId: 'waxwing', scopes: DEFAULT_SCOPES },
      store,
      now: () => clock,
      navigate: (url) => {
        navigated = url
      },
      getHref: () => currentHref,
      getBaseUri: () => 'http://localhost:5173/mail/',
      replaceUrl: (url) => {
        currentHref = url
      },
    })

    // 1. Start login: discovery + PKCE authorization URL, browser told to navigate.
    const start = await controller.startLogin({ method: 'oauth' })
    expect(start.kind).toBe('redirect')
    expect(navigated).not.toBeNull()
    const authUrl = new URL(navigated as unknown as string)
    expect(authUrl.origin + authUrl.pathname).toBe('http://localhost:18080/authorize')
    expect(authUrl.searchParams.get('redirect_uri')).toBe('http://localhost:5173/mail/')
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authUrl.searchParams.get('client_id')).toBe('waxwing')
    const state = authUrl.searchParams.get('state')
    expect(state).toBeTruthy()
    // The single-use PKCE transaction is persisted (wrapped) across the redirect.
    expect(await store.get(SecretName.PkceTransaction)).not.toBeNull()

    // 2. Simulate the IdP redirecting back to the app under its /mail/ prefix (FR-DEP-02).
    currentHref = `http://localhost:5173/mail/?code=auth-code-xyz&state=${state}`
    const session = await controller.completeRedirect()
    expect(session.method).toBe('oauth')
    expect(session.expiresAt).toBe(clock + 3_600_000)
    // Callback params scrubbed from the URL; transaction consumed.
    expect(currentHref).toBe('http://localhost:5173/mail/')
    expect(await store.get(SecretName.PkceTransaction)).toBeNull()

    // 3. The JMAP auth provider yields a bearer header from the in-memory access token.
    expect(await session.authProvider.authorization()).toBe('Bearer access-1')
    // Only the refresh token is persisted, encrypted at rest.
    expect(await store.get(SecretName.RefreshToken)).toBe('refresh-1')

    // 4. Advance past expiry -> next access triggers a silent refresh.
    clock += 3_600_001
    expect(await controller.getAccessToken()).toBe('access-refreshed-1')
    // Refresh token retained (server did not rotate it).
    expect(await store.get(SecretName.RefreshToken)).toBe('refresh-1')

    // Discovery happened exactly once (cached for the refresh).
    expect(idp.calls.filter((c) => c.url.includes('/.well-known/'))).toHaveLength(1)

    // 5. Logout: no revocation endpoint -> local wipe only; persisted token destroyed.
    await controller.logout()
    expect(controller.getSession()).toBeNull()
    expect(await store.get(SecretName.RefreshToken)).toBeNull()
    // No revocation request was attempted (endpoint absent).
    expect(idp.calls.some((c) => c.url.includes('revoke'))).toBe(false)
    expect(dbName).toBeTruthy()
  })

  it('offline start: a rebooted controller restores from the persisted refresh token', async () => {
    const idp = fakeIdp()
    vi.stubGlobal('fetch', idp.fetchImpl)
    const { dbName } = freshStore()
    let clock = 2_000_000_000
    let currentHref = 'http://localhost:5173/mail/'
    const oauth = { issuer: 'http://localhost:18080', clientId: 'waxwing', scopes: DEFAULT_SCOPES }
    const env = {
      oauth,
      now: () => clock,
      navigate: () => {},
      getHref: () => currentHref,
      getBaseUri: () => 'http://localhost:5173/mail/',
      replaceUrl: (url: string) => {
        currentHref = url
      },
    }

    // First session establishes and persists the refresh token.
    const first = new AuthController({ ...env, store: new SecretStore({ dbName }) })
    const start = await first.startLogin({ method: 'oauth' })
    const state = new URL(
      (start as Extract<StartLoginResult, { kind: 'redirect' }>).url,
    ).searchParams.get('state')
    currentHref = `http://localhost:5173/mail/?code=c&state=${state}`
    await first.completeRedirect()

    // Cold boot: a brand-new controller over the same (persisted) store, no fresh login.
    clock += 10_000_000
    const rebooted = new AuthController({ ...env, store: new SecretStore({ dbName }) })
    const restored = await rebooted.restore()
    expect(restored?.method).toBe('oauth')
    expect(restored?.expiresAt).toBeNull() // access token fetched lazily
    // First API use silently obtains an access token from the persisted refresh token.
    expect(await rebooted.getAccessToken()).toBe('access-refreshed-1')
  })

  it('surfaces AuthExpiredError when refresh fails and there is no valid access token', async () => {
    const { store, dbName } = freshStore()
    // Persist an auth record + refresh token, but make the token endpoint reject.
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = input instanceof URL ? input.href : String(input)
      if (url.includes('/.well-known/')) return json(DISCOVERY)
      return json({ error: 'invalid_grant' })
    })
    const oauth = { issuer: 'http://localhost:18080', clientId: 'waxwing', scopes: DEFAULT_SCOPES }
    await store.put(
      SecretName.AuthRecord,
      JSON.stringify({
        method: 'oauth',
        username: null,
        oauth: {
          issuer: 'http://localhost:18080',
          clientId: 'waxwing',
          scopes: DEFAULT_SCOPES,
          redirectUri: 'http://localhost:5173/mail/',
          discovery: 'oauth2',
          allowInsecureRequests: true,
        },
      }),
    )
    await store.put(SecretName.RefreshToken, 'stale-refresh')

    const controller = new AuthController({
      oauth,
      store,
      getBaseUri: () => 'http://localhost:5173/mail/',
    })
    await controller.restore()
    await expect(controller.getAccessToken()).rejects.toThrowError(/expired|refresh/i)
    expect(dbName).toBeTruthy()
  })

  it('single-flights concurrent refreshes into ONE token grant', async () => {
    const idp = fakeIdp()
    vi.stubGlobal('fetch', idp.fetchImpl)
    const { store } = freshStore()
    let clock = 1_500_000_000
    let currentHref = 'http://localhost:5173/mail/'
    const controller = new AuthController({
      oauth: { issuer: 'http://localhost:18080', clientId: 'waxwing', scopes: DEFAULT_SCOPES },
      store,
      now: () => clock,
      navigate: () => {},
      getHref: () => currentHref,
      getBaseUri: () => 'http://localhost:5173/mail/',
      replaceUrl: (url) => {
        currentHref = url
      },
    })
    const start = await controller.startLogin({ method: 'oauth' })
    const state = new URL(
      (start as Extract<StartLoginResult, { kind: 'redirect' }>).url,
    ).searchParams.get('state')
    currentHref = `http://localhost:5173/mail/?code=c&state=${state}`
    await controller.completeRedirect()

    // Expire the access token, then fire several concurrent token consumers at once.
    clock += 3_600_001
    const tokens = await Promise.all([
      controller.getAccessToken(),
      controller.getAccessToken(),
      controller.getAccessToken(),
    ])
    expect(tokens).toEqual(['access-refreshed-1', 'access-refreshed-1', 'access-refreshed-1'])
    // Exactly ONE refresh_token grant reached the token endpoint despite three callers.
    const refreshCalls = idp.calls.filter((c) => c.body.includes('grant_type=refresh_token'))
    expect(refreshCalls).toHaveLength(1)
  })

  it('purges the persisted refresh token on a terminal refresh rejection (no phantom restore)', async () => {
    const { store, dbName } = freshStore()
    // A conform OAuth error response (HTTP 400 + JSON error) -> oauth4webapi ResponseBodyError.
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = input instanceof URL ? input.href : String(input)
      if (url.includes('/.well-known/')) return json(DISCOVERY)
      return new Response(JSON.stringify({ error: 'invalid_grant' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })
    })
    const oauth = { issuer: 'http://localhost:18080', clientId: 'waxwing', scopes: DEFAULT_SCOPES }
    const record = {
      method: 'oauth',
      username: null,
      oauth: {
        issuer: 'http://localhost:18080',
        clientId: 'waxwing',
        scopes: DEFAULT_SCOPES,
        redirectUri: 'http://localhost:5173/mail/',
        discovery: 'oauth2',
        allowInsecureRequests: true,
      },
    }
    await store.put(SecretName.AuthRecord, JSON.stringify(record))
    await store.put(SecretName.RefreshToken, 'dead-refresh')

    const controller = new AuthController({
      oauth,
      store,
      getBaseUri: () => 'http://localhost:5173/mail/',
    })
    await controller.restore()
    await expect(controller.getAccessToken()).rejects.toThrowError(/expired|refresh/i)
    // The dead token is purged, so a cold boot cleanly returns null instead of a phantom session.
    expect(await store.get(SecretName.RefreshToken)).toBeNull()
    const rebooted = new AuthController({
      oauth,
      store: new SecretStore({ dbName }),
      getBaseUri: () => 'http://localhost:5173/mail/',
    })
    expect(await rebooted.restore()).toBeNull()
  })
})

describe('AuthController — Basic auth (FR-AUTH-04)', () => {
  it('establishes a Basic session and, with "stay signed in", persists it for restore', async () => {
    const { store, dbName } = freshStore()
    const controller = new AuthController({ store, getBaseUri: () => 'http://localhost:5173/' })

    const result = await controller.startLogin({
      method: 'basic',
      username: 'alice@waxwing.test',
      password: 'waxwing-e2e-Pw1!',
      staySignedIn: true,
    })
    expect(result.kind).toBe('session')
    const session = (result as Extract<StartLoginResult, { kind: 'session' }>).session
    expect(session.method).toBe('basic')
    expect(session.username).toBe('alice@waxwing.test')

    const header = await session.authProvider.authorization()
    expect(header.startsWith('Basic ')).toBe(true)
    expect(atob(header.slice('Basic '.length))).toBe('alice@waxwing.test:waxwing-e2e-Pw1!')
    // Credentials persisted only via the wrapped store (never plaintext).
    expect(await store.get(SecretName.BasicCredentials)).toContain('alice@waxwing.test')

    // Cold boot restores the Basic session.
    const rebooted = new AuthController({ store: new SecretStore({ dbName }) })
    const restored = await rebooted.restore()
    expect(restored?.method).toBe('basic')
    expect(restored?.username).toBe('alice@waxwing.test')
  })

  it('without "stay signed in", nothing is persisted and restore() yields null', async () => {
    const { store, dbName } = freshStore()
    const controller = new AuthController({ store })
    await controller.startLogin({ method: 'basic', username: 'bob@waxwing.test', password: 'pw' })

    expect(await store.get(SecretName.BasicCredentials)).toBeNull()
    const rebooted = new AuthController({ store: new SecretStore({ dbName }) })
    expect(await rebooted.restore()).toBeNull()
  })

  it('throws when OAuth login is requested but no OAuth config is present', async () => {
    const { store } = freshStore()
    const controller = new AuthController({ store })
    await expect(controller.startLogin({ method: 'oauth' })).rejects.toThrowError(/OAuth/)
  })
})

/**
 * One store, one method's secret. Both directions are reachable without any XSS: an OAuth callback
 * that succeeds and a `connectSession` that then fails (403 on `/.well-known/jmap`, a session whose
 * origin does not match) puts the user back on the login form with tokens already written, and the
 * account switcher offers the other method at any time.
 */
describe('AuthController — switching sign-in method clears the other secret', () => {
  it('a Basic sign-in drops a refresh token left by OAuth', async () => {
    const { store } = freshStore()
    await store.put(SecretName.RefreshToken, 'rt-from-oauth')

    const controller = new AuthController({ store })
    await controller.startLogin({
      method: 'basic',
      username: 'a@waxwing.test',
      password: 'pw',
      staySignedIn: false,
    })

    // 30 days valid and, per ADR-006, not revocable server-side — on the disk of someone who
    // deliberately left "stay signed in" unticked.
    expect(await store.get(SecretName.RefreshToken)).toBeNull()
  })

  it('an OAuth callback drops a password left by Basic', async () => {
    const idp = fakeIdp()
    vi.stubGlobal('fetch', idp.fetchImpl)
    const { store } = freshStore()
    await store.put(
      SecretName.BasicCredentials,
      JSON.stringify({ username: 'a@waxwing.test', password: 'pw' }),
    )

    let currentHref = 'http://localhost:5173/'
    const controller = new AuthController({
      oauth: { issuer: 'http://localhost:18080', clientId: 'waxwing', scopes: DEFAULT_SCOPES },
      store,
      navigate: (url) => {
        currentHref = url
      },
      getHref: () => currentHref,
      getBaseUri: () => 'http://localhost:5173/',
      replaceUrl: (url) => {
        currentHref = url
      },
    })
    await controller.startLogin({ method: 'oauth' })
    const state = new URL(currentHref).searchParams.get('state')
    currentHref = `http://localhost:5173/?code=auth-code-xyz&state=${state}`
    await controller.completeRedirect()

    // Inert for `restore()` — which keys off the AuthRecord — but still decryptable here and still
    // valid at the server.
    expect(await store.get(SecretName.BasicCredentials)).toBeNull()
  })
})

/**
 * Every controller in this browser profile shares one `waxwing-auth` database — ADR-004 designed
 * per-account scopes, and no production path passes one (W-17). The refresh path therefore has to
 * check whose token it is holding, or the shared store turns into a credential disclosure with no
 * XSS involved: tab 1 signed in to server X, someone signs in to server Y in tab 2 and overwrites
 * the token, and an hour later tab 1's refresh POSTs Y's token to X's endpoint.
 */
/**
 * An authorization nobody finished (W-36). The age check only runs when a callback arrives to
 * consume the transaction — and in public-computer mode no callback ever comes, so `code_verifier`,
 * `state` and the resolved OAuth config stayed in the durable store together with the database and
 * wrapping key they created. The verifier is worthless without its code; what remains is the
 * metadata about who tried to sign in where, which is what that mode exists to avoid leaving.
 */
describe('AuthController — an abandoned PKCE transaction is swept', () => {
  const transaction = (createdAt: number | undefined) =>
    JSON.stringify({
      state: 's',
      codeVerifier: 'v',
      config: { issuer: 'http://localhost:18080', clientId: 'waxwing', scopes: DEFAULT_SCOPES },
      ...(createdAt === undefined ? {} : { createdAt }),
    })

  it('drops one older than the maximum age on the next cold start', async () => {
    const { store } = freshStore()
    await store.put(SecretName.PkceTransaction, transaction(1_000_000))
    const controller = new AuthController({ store, now: () => 1_000_000 + 31 * 60_000 })

    await controller.restore()

    expect(await store.get(SecretName.PkceTransaction)).toBeNull()
  })

  it('drops an unparseable one too — no callback will consume it either', async () => {
    const { store } = freshStore()
    await store.put(SecretName.PkceTransaction, '{not json')
    const controller = new AuthController({ store })

    await controller.restore()

    expect(await store.get(SecretName.PkceTransaction)).toBeNull()
  })

  it('keeps a FRESH one — a redirect may still be in flight', async () => {
    const { store } = freshStore()
    await store.put(SecretName.PkceTransaction, transaction(1_000_000))
    const controller = new AuthController({ store, now: () => 1_000_000 + 60_000 })

    await controller.restore()

    expect(await store.get(SecretName.PkceTransaction)).not.toBeNull()
  })
})

describe('AuthController — a refresh token belongs to one issuer', () => {
  it('refuses to send a token whose AuthRecord names a different issuer', async () => {
    const idp = fakeIdp()
    vi.stubGlobal('fetch', idp.fetchImpl)
    const { store } = freshStore()
    let currentHref = 'http://localhost:5173/'
    let clock = 1_000_000_000
    const controller = new AuthController({
      oauth: { issuer: 'http://localhost:18080', clientId: 'waxwing', scopes: DEFAULT_SCOPES },
      store,
      now: () => clock,
      navigate: (url) => {
        currentHref = url
      },
      getHref: () => currentHref,
      getBaseUri: () => 'http://localhost:5173/',
      replaceUrl: (url) => {
        currentHref = url
      },
    })
    await controller.startLogin({ method: 'oauth' })
    const state = new URL(currentHref).searchParams.get('state')
    currentHref = `http://localhost:5173/?code=auth-code-xyz&state=${state}`
    await controller.completeRedirect()

    // Another tab signs in elsewhere: same database, different server.
    await store.put(
      SecretName.AuthRecord,
      JSON.stringify({
        method: 'oauth',
        username: null,
        oauth: { issuer: 'http://other.example', clientId: 'waxwing', scopes: DEFAULT_SCOPES },
      }),
    )
    await store.put(SecretName.RefreshToken, 'refresh-token-belonging-to-the-other-server')

    clock += 4_000_000 // past the access token's hour, so a refresh is actually attempted
    const provider = controller.getAuthProvider()
    await expect(provider.authorization()).rejects.toThrowError(/different sign-in/)
  })

  it('refreshes normally while the record still names this issuer — the counter-test', async () => {
    const idp = fakeIdp()
    vi.stubGlobal('fetch', idp.fetchImpl)
    const { store } = freshStore()
    let currentHref = 'http://localhost:5173/'
    let clock = 1_000_000_000
    const controller = new AuthController({
      oauth: { issuer: 'http://localhost:18080', clientId: 'waxwing', scopes: DEFAULT_SCOPES },
      store,
      now: () => clock,
      navigate: (url) => {
        currentHref = url
      },
      getHref: () => currentHref,
      getBaseUri: () => 'http://localhost:5173/',
      replaceUrl: (url) => {
        currentHref = url
      },
    })
    await controller.startLogin({ method: 'oauth' })
    const state = new URL(currentHref).searchParams.get('state')
    currentHref = `http://localhost:5173/?code=auth-code-xyz&state=${state}`
    await controller.completeRedirect()

    clock += 4_000_000 // past the access token's hour
    expect(await controller.getAuthProvider().authorization()).toMatch(/^Bearer /)
  })
})

describe('AuthController — logout & remove data (FR-AUTH-05)', () => {
  it('wipeData clears credentials, caches, IndexedDB and service-worker registrations', async () => {
    const { store, dbName } = freshStore()

    const deletedCaches: string[] = []
    const deletedDbs: string[] = []
    let unregistered = 0
    const wipe: WipeEnvironment = {
      caches: {
        keys: async () => ['app-shell-v1', 'mail-bodies'],
        delete: async (key: string) => {
          deletedCaches.push(key)
          return true
        },
      } as unknown as CacheStorage,
      indexedDB: {
        databases: async () => [{ name: 'app-replica', version: 1 }],
        deleteDatabase: (name: string) => {
          deletedDbs.push(name)
          const request = {} as IDBOpenDBRequest
          queueMicrotask(() => request.onsuccess?.(new Event('success')))
          return request
        },
      } as unknown as IDBFactory,
      serviceWorker: {
        getRegistrations: async () => [
          {
            unregister: async () => {
              unregistered++
              return true
            },
          },
          {
            unregister: async () => {
              unregistered++
              return true
            },
          },
        ],
      } as unknown as ServiceWorkerContainer,
      // The account registry lives here, and so does everything the dialog calls "settings".
      localStorage: fakeStorage({
        'waxwing.accounts': '{"accounts":[{"scope":"s","username":"alice@example.com"}]}',
        'waxwing.theme': 'dark',
        'waxwing.ephemeralDbs': '["waxwing-replica-eph-1"]',
      }),
      sessionStorage: fakeStorage({ 'waxwing.onboard.target': '{}' }),
    }

    const controller = new AuthController({ store, wipe })
    await controller.startLogin({
      method: 'basic',
      username: 'a@waxwing.test',
      password: 'pw',
      staySignedIn: true,
    })
    expect(await store.get(SecretName.BasicCredentials)).not.toBeNull()

    await controller.logout({ wipeData: true })

    expect(controller.getSession()).toBeNull()
    expect(await store.get(SecretName.BasicCredentials)).toBeNull()
    expect(deletedCaches.sort()).toEqual(['app-shell-v1', 'mail-bodies'])
    expect(deletedDbs).toEqual(['app-replica'])
    expect(unregistered).toBe(2)
    expect(dbName).toBeTruthy()
    // The registry is an identity — mailbox address and server origin of whoever signed in here —
    // and no production path removed a row before this. "Remove data" that leaves it hands the
    // next person at the machine a "switch to alice@example.com" entry in the account menu.
    expect(wipe.localStorage?.getItem('waxwing.accounts')).toBeNull()
    expect(wipe.localStorage?.getItem('waxwing.theme')).toBeNull()
    expect(wipe.sessionStorage?.getItem('waxwing.onboard.target')).toBeNull()
    // The one exception, and it is not user data: without `databases()` (Firefox) this index is
    // the only way to find the throwaway replicas still awaiting a sweep.
    expect(wipe.localStorage?.getItem('waxwing.ephemeralDbs')).toBe('["waxwing-replica-eph-1"]')
  })

  /**
   * A blocked credential wipe must not take the rest of "remove my data" with it (W-23).
   *
   * `deleteDatabase('waxwing-auth')` is blocked by a frozen or bfcached second tab, and the throw
   * used to skip `wipeLocalData` entirely — so Cache Storage, every other IndexedDB database and
   * the service-worker registrations survived, for a reason that has nothing to do with any of
   * them. The error still has to reach the caller: it is what tells the user their credentials are
   * still on this machine.
   */
  it('still wipes app data when the credential store is blocked, and reports the failure', async () => {
    const { store } = freshStore()
    vi.spyOn(store, 'wipe').mockRejectedValue(new Error('blocked by another connection'))
    let cachesCleared = false
    const wipe: WipeEnvironment = {
      caches: {
        keys: async () => ['app-shell-v1'],
        delete: async () => {
          cachesCleared = true
          return true
        },
      } as unknown as CacheStorage,
      localStorage: fakeStorage({ 'waxwing.accounts': '{}' }),
    }

    const controller = new AuthController({ store, wipe })
    await expect(controller.logout({ wipeData: true })).rejects.toThrowError(/blocked/)

    expect(cachesCleared).toBe(true)
    expect(wipe.localStorage?.getItem('waxwing.accounts')).toBeNull()
  })

  it('plain sign-out drops credentials but does not touch app data', async () => {
    const { store } = freshStore()
    let cacheTouched = false
    const wipe: WipeEnvironment = {
      caches: {
        keys: async () => {
          cacheTouched = true
          return []
        },
        delete: async () => true,
      } as unknown as CacheStorage,
    }
    const controller = new AuthController({ store, wipe })
    await controller.startLogin({
      method: 'basic',
      username: 'a@waxwing.test',
      password: 'pw',
      staySignedIn: true,
    })

    await controller.logout()
    expect(await store.get(SecretName.BasicCredentials)).toBeNull()
    expect(cacheTouched).toBe(false)
  })
})

/**
 * Public-computer mode on the OAUTH path (FR-AUTH-09).
 *
 * Basic has always had "stay signed in" as an opt-IN, so declining it leaves nothing behind. OAuth
 * has no such switch: it persists a refresh token unconditionally, because that is what makes a
 * silent cold start work. On a machine that is not the user's, that durable credential is the whole
 * problem — worse than the cached mail, because it fetches the mail again.
 */
describe('AuthController — public-computer OAuth (FR-AUTH-09)', () => {
  function publicComputerController(store: SecretStore, hrefRef: { value: string }) {
    let navigated: string | null = null
    const controller = new AuthController({
      oauth: { issuer: 'http://localhost:18080', clientId: 'waxwing', scopes: DEFAULT_SCOPES },
      store,
      now: () => 1_000_000_000,
      navigate: (url) => {
        navigated = url
      },
      getHref: () => hrefRef.value,
      getBaseUri: () => 'http://localhost:5173/',
      replaceUrl: (url) => {
        hrefRef.value = url
      },
    })
    return { controller, navigatedUrl: () => navigated }
  }

  it('persists NEITHER the refresh token NOR an auth record, but still refreshes silently', async () => {
    const idp = fakeIdp()
    vi.stubGlobal('fetch', idp.fetchImpl)
    const { store } = freshStore()
    const href = { value: 'http://localhost:5173/' }
    const { controller, navigatedUrl } = publicComputerController(store, href)

    await controller.startLogin({ method: 'oauth', publicComputer: true })
    const state = new URL(navigatedUrl() as unknown as string).searchParams.get('state')
    href.value = `http://localhost:5173/?code=c&state=${state}`
    await controller.completeRedirect()

    // Nothing a later page on this origin could restore from.
    expect(await store.get(SecretName.RefreshToken)).toBeNull()
    expect(await store.get(SecretName.AuthRecord)).toBeNull()
    expect(await new AuthController({ store }).restore()).toBeNull()

    // …and yet the LIVE session is fully functional, refresh included: the token is in memory.
    // Without this the mode would be a session that dies at the first hour boundary.
    const refreshed = new AuthController({ store })
    expect(refreshed).toBeDefined()
    expect(await controller.getAccessToken()).toBe('access-1')
  })

  it('an ORDINARY OAuth sign-in still persists both — the counter-test', async () => {
    // Without this, a fix that simply stopped persisting for everyone would look identical above,
    // and would silently end offline cold start for every normal user.
    const idp = fakeIdp()
    vi.stubGlobal('fetch', idp.fetchImpl)
    const { store } = freshStore()
    const href = { value: 'http://localhost:5173/' }
    const { controller, navigatedUrl } = publicComputerController(store, href)

    await controller.startLogin({ method: 'oauth' })
    const state = new URL(navigatedUrl() as unknown as string).searchParams.get('state')
    href.value = `http://localhost:5173/?code=c&state=${state}`
    await controller.completeRedirect()

    expect(await store.get(SecretName.RefreshToken)).toBe('refresh-1')
    expect(await store.get(SecretName.AuthRecord)).not.toBeNull()
  })
})

describe('AuthController — sign-out is final', () => {
  it('a refresh in flight during logout does not resurrect the credential store', async () => {
    // The store self-heals: `put()` re-creates the database and a fresh wrapping key. So a token
    // grant that lands a few hundred ms AFTER the wipe used to write a perfectly valid refresh
    // token back to disk, behind a login screen that said the user was signed out.
    let releaseRefresh: (() => void) | undefined
    const idp = fakeIdp()
    const gatedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url
      if (url.includes('/token') && String(init?.body ?? '').includes('refresh_token')) {
        await new Promise<void>((resolve) => {
          releaseRefresh = resolve
        })
      }
      return idp.fetchImpl(input, init)
    }
    vi.stubGlobal('fetch', gatedFetch)
    const { store } = freshStore()
    let clock = 1_000_000_000
    const href = { value: 'http://localhost:5173/' }
    let navigated: string | null = null
    const controller = new AuthController({
      oauth: { issuer: 'http://localhost:18080', clientId: 'waxwing', scopes: DEFAULT_SCOPES },
      store,
      now: () => clock,
      navigate: (url) => {
        navigated = url
      },
      getHref: () => href.value,
      getBaseUri: () => 'http://localhost:5173/',
      replaceUrl: (url) => {
        href.value = url
      },
    })

    await controller.startLogin({ method: 'oauth' })
    const state = new URL(navigated as unknown as string).searchParams.get('state')
    href.value = `http://localhost:5173/?code=c&state=${state}`
    await controller.completeRedirect()
    expect(await store.get(SecretName.RefreshToken)).toBe('refresh-1')

    // Expire the access token and start a refresh that we hold open on the wire.
    clock += 3_600_001
    const pending = controller.getAccessToken()
    await vi.waitFor(() => expect(releaseRefresh).toBeDefined())

    // Sign out while it is still in flight, then let the grant land.
    await controller.logout()
    releaseRefresh?.()
    await expect(pending).rejects.toThrow()

    // THE assertion: nothing came back. A resurrected token here means the next person at this
    // machine gets a working session out of a sign-out the user watched complete.
    expect(await store.get(SecretName.RefreshToken)).toBeNull()
    expect(await store.get(SecretName.AuthRecord)).toBeNull()
  })
})

describe('AuthController — redirect-callback detection', () => {
  it('ignores a ?code= that belongs to no authorization of ours', async () => {
    // `https://mail.example.com/?code=x` is a link anyone can put in an email. Treating the URL
    // shape alone as a callback sent a signed-in reader down the OAuth branch, where it failed and
    // never reached restore() — a mail-triggered sign-out, and it consumed a genuinely pending
    // transaction if one existed.
    const { store } = freshStore()
    const controller = new AuthController({
      store,
      getHref: () => 'http://localhost:5173/?code=attacker-supplied&state=whatever',
    })
    expect(await controller.isRedirectCallback()).toBe(false)
  })

  it('recognises one that does — the counter-test', async () => {
    const idp = fakeIdp()
    vi.stubGlobal('fetch', idp.fetchImpl)
    const { store } = freshStore()
    const href = { value: 'http://localhost:5173/' }
    let navigated: string | null = null
    const controller = new AuthController({
      oauth: { issuer: 'http://localhost:18080', clientId: 'waxwing', scopes: DEFAULT_SCOPES },
      store,
      navigate: (url) => {
        navigated = url
      },
      getHref: () => href.value,
      getBaseUri: () => 'http://localhost:5173/',
      replaceUrl: (url) => {
        href.value = url
      },
    })
    await controller.startLogin({ method: 'oauth' })
    const state = new URL(navigated as unknown as string).searchParams.get('state')
    href.value = `http://localhost:5173/?code=c&state=${state}`
    expect(await controller.isRedirectCallback()).toBe(true)
  })

  it('refuses a transaction that has gone stale', async () => {
    const idp = fakeIdp()
    vi.stubGlobal('fetch', idp.fetchImpl)
    const { store } = freshStore()
    const href = { value: 'http://localhost:5173/' }
    let navigated: string | null = null
    let clock = 1_000_000_000
    const controller = new AuthController({
      oauth: { issuer: 'http://localhost:18080', clientId: 'waxwing', scopes: DEFAULT_SCOPES },
      store,
      now: () => clock,
      navigate: (url) => {
        navigated = url
      },
      getHref: () => href.value,
      getBaseUri: () => 'http://localhost:5173/',
      replaceUrl: (url) => {
        href.value = url
      },
    })
    await controller.startLogin({ method: 'oauth' })
    const state = new URL(navigated as unknown as string).searchParams.get('state')
    href.value = `http://localhost:5173/?code=c&state=${state}`
    clock += 31 * 60_000
    await expect(controller.completeRedirect()).rejects.toThrow(/expired/i)
  })
})

describe('AuthController — the callback carries the server’s verdict', () => {
  /** Start an authorization and hand back the `state` the IdP would echo. */
  async function startedAuthorization() {
    const idp = fakeIdp()
    vi.stubGlobal('fetch', idp.fetchImpl)
    const { store } = freshStore()
    const href = { value: 'http://localhost:5173/' }
    let navigated: string | null = null
    const controller = new AuthController({
      oauth: { issuer: 'http://localhost:18080', clientId: 'waxwing', scopes: DEFAULT_SCOPES },
      store,
      navigate: (url) => {
        navigated = url
      },
      getHref: () => href.value,
      getBaseUri: () => 'http://localhost:5173/',
      replaceUrl: (url) => {
        href.value = url
      },
    })
    await controller.startLogin({ method: 'oauth' })
    const state = new URL(navigated as unknown as string).searchParams.get('state')
    return { controller, href, state }
  }

  it('reports `access_denied` as a code the UI can act on', async () => {
    // "Deny" at the IdP is a decision, not a malfunction. Without the code the app could only say
    // "Something went wrong" — and offered to delete the local mailbox underneath it.
    const { controller, href, state } = await startedAuthorization()
    href.value = `http://localhost:5173/?error=access_denied&state=${state}`

    const error = await controller.completeRedirect().then(
      () => null,
      (caught: unknown) => caught,
    )

    expect(error).toBeInstanceOf(OAuthCallbackError)
    expect((error as OAuthCallbackError).code).toBe('access_denied')
  })

  it('leaves the code undefined when the failure was on our side — the counter-test', async () => {
    // A state mismatch is not the server refusing anything; nobody said no.
    const { controller, href } = await startedAuthorization()
    href.value = 'http://localhost:5173/?code=c&state=not-the-one-we-sent'

    const error = await controller.completeRedirect().then(
      () => null,
      (caught: unknown) => caught,
    )

    expect(error).toBeInstanceOf(OAuthCallbackError)
    expect((error as OAuthCallbackError).code).toBeUndefined()
  })
})

/**
 * Two tabs, one shared `waxwing-auth` database (ADR-037), and an authorization server that
 * invalidates a refresh token the moment it rotates it — the OAuth 2.1 rule for public clients.
 * (Stalwart is not such a server; the external IdPs ADR-006 recommends for revocation are.)
 */
describe('AuthController — two tabs refreshing at once (R-30)', () => {
  /** A `LockManager` that actually serializes: each name has a queue of one. */
  function fakeLocks(): LockManagerLike & { held: string[] } {
    const queues = new Map<string, Promise<unknown>>()
    const held: string[] = []
    return {
      held,
      request(name, _options, callback) {
        held.push(name)
        const previous = queues.get(name) ?? Promise.resolve()
        const run = previous.then(
          () => callback(null),
          () => callback(null),
        )
        queues.set(
          name,
          run.then(
            () => undefined,
            () => undefined,
          ),
        )
        return run
      },
    }
  }

  function badGrant(): Response {
    return new Response(JSON.stringify({ error: 'invalid_grant' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })
  }

  /** An IdP whose refresh tokens are ONE-TIME-USE: presenting a superseded one is `invalid_grant`. */
  function rotatingIdp() {
    let current = 'refresh-1'
    let issued = 1
    const grants: string[] = []
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url
      const params = new URLSearchParams(init?.body ? String(init.body) : '')
      if (url.includes('/.well-known/')) return json(DISCOVERY)
      if (!url.includes('/token')) return new Response('not found', { status: 404 })
      if (params.get('grant_type') !== 'refresh_token') {
        return json({
          access_token: 'access-1',
          token_type: 'bearer',
          expires_in: 3600,
          refresh_token: current,
        })
      }
      const presented = params.get('refresh_token') ?? ''
      grants.push(presented)
      if (presented !== current) return badGrant()
      issued += 1
      current = `refresh-${issued}`
      return json({
        access_token: `access-${issued}`,
        token_type: 'bearer',
        expires_in: 3600,
        refresh_token: current,
      })
    }
    return { fetchImpl, grants }
  }

  const OAUTH = {
    issuer: 'http://localhost:18080',
    clientId: 'waxwing',
    scopes: DEFAULT_SCOPES,
  }

  it('serializes the grant, so the second tab sends what the first one wrote', async () => {
    const idp = rotatingIdp()
    vi.stubGlobal('fetch', idp.fetchImpl)
    const { store, dbName } = freshStore()
    const locks = fakeLocks()

    // Tab A signs in and writes refresh-1 into the shared store.
    let href = 'http://localhost:5173/'
    const tabA = new AuthController({
      oauth: OAUTH,
      store,
      locks,
      navigate: () => {},
      getHref: () => href,
      getBaseUri: () => 'http://localhost:5173/',
      replaceUrl: (url) => {
        href = url
      },
    })
    const start = await tabA.startLogin({ method: 'oauth' })
    const state = new URL(
      (start as Extract<StartLoginResult, { kind: 'redirect' }>).url,
    ).searchParams.get('state')
    href = `http://localhost:5173/?code=c&state=${state}`
    await tabA.completeRedirect()

    // Tab B is the same profile: same database, its own controller, restored from the record.
    const tabB = new AuthController({
      oauth: OAUTH,
      store: new SecretStore({ dbName }),
      locks,
      getBaseUri: () => 'http://localhost:5173/',
    })
    expect(await tabB.restore()).not.toBeNull()

    const outcomes = await Promise.allSettled([tabA.refresh(), tabB.refresh()])

    expect(outcomes.map((o) => o.status)).toEqual(['fulfilled', 'fulfilled'])
    // The whole point: the second grant presented the token the first one had just written, so
    // neither was ever refused and neither deleted the other's.
    expect(idp.grants).toEqual(['refresh-1', 'refresh-2'])
    expect(await store.get(SecretName.RefreshToken)).toBe('refresh-3')
    expect(locks.held).toEqual(['waxwing-auth-refresh', 'waxwing-auth-refresh'])

    // And the cold start after all this still finds a session, which is what used to be lost.
    const rebooted = new AuthController({
      oauth: OAUTH,
      store: new SecretStore({ dbName }),
      getBaseUri: () => 'http://localhost:5173/',
    })
    expect(await rebooted.restore()).not.toBeNull()
  })

  it('does not delete a token that is no longer the one it sent, and retries with the new one', async () => {
    // The half that has to hold where Web Locks are unavailable (older Safari, and this project's
    // Node-based auth tests). The store is rotated underneath the grant, exactly as another tab
    // would: an unconditional `tokens.clear()` here is what erased a live credential.
    const { store, dbName } = freshStore()
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof URL ? input.href : String(input)
      if (url.includes('/.well-known/')) return json(DISCOVERY)
      const params = new URLSearchParams(init?.body ? String(init.body) : '')
      const presented = params.get('refresh_token')
      if (presented === 'refresh-1') {
        // The other tab won the race and has already written its rotated token.
        await store.put(SecretName.RefreshToken, 'refresh-2')
        return badGrant()
      }
      return json({
        access_token: 'access-2',
        token_type: 'bearer',
        expires_in: 3600,
        refresh_token: 'refresh-3',
      })
    })
    await store.put(
      SecretName.AuthRecord,
      JSON.stringify({
        method: 'oauth',
        username: null,
        oauth: {
          ...OAUTH,
          redirectUri: 'http://localhost:5173/',
          discovery: 'oauth2',
          allowInsecureRequests: true,
        },
      }),
    )
    await store.put(SecretName.RefreshToken, 'refresh-1')
    const controller = new AuthController({
      oauth: OAUTH,
      store,
      getBaseUri: () => 'http://localhost:5173/',
    })
    await controller.restore()

    expect(await controller.getAccessToken()).toBe('access-2')
    expect(await store.get(SecretName.RefreshToken)).toBe('refresh-3')
    const rebooted = new AuthController({
      oauth: OAUTH,
      store: new SecretStore({ dbName }),
      getBaseUri: () => 'http://localhost:5173/',
    })
    expect(await rebooted.restore()).not.toBeNull()
  })
})

describe('AuthController — the auth store is not always reachable, and not always ours', () => {
  const OAUTH_CONFIG = {
    issuer: 'http://localhost:18080',
    clientId: 'waxwing',
    scopes: DEFAULT_SCOPES,
  }

  /** An `IDBFactory` whose `open` always fails: an enterprise policy, a locked-down WebView. */
  function blockedIndexedDb(): IDBFactory {
    return {
      open() {
        const request = {
          error: new DOMException('blocked', 'InvalidStateError'),
          onerror: null as null | (() => void),
          onsuccess: null as null | (() => void),
          onupgradeneeded: null as null | (() => void),
        }
        queueMicrotask(() => request.onerror?.())
        return request as unknown as IDBOpenDBRequest
      },
      deleteDatabase: (name: string) => indexedDB.deleteDatabase(name),
    } as unknown as IDBFactory
  }

  it('signs in with Basic and no "stay signed in" even when IndexedDB cannot be opened (R-80)', async () => {
    // Nothing is to be persisted, so nothing about the store may fail this sign-in. The three
    // store calls here remove what an EARLIER session left — hygiene, not part of the login — and
    // they used to reject it outright with "Something went wrong" plus an offer to reset the app.
    const controller = new AuthController({
      store: new SecretStore({ dbName: 'waxwing-auth-blocked', indexedDB: blockedIndexedDb() }),
      getBaseUri: () => 'http://localhost:5173/',
    })

    const result = await controller.startLogin({
      method: 'basic',
      username: 'alice',
      password: 'pw',
      staySignedIn: false,
    })

    expect(result.kind).toBe('session')
    expect(controller.getSession()?.username).toBe('alice')
  })

  it('still fails when the reader asked to STAY signed in — the counter-test (R-80)', async () => {
    // There the store is the only way to deliver what was asked for, so its failure is the
    // sign-in's failure. And the session must not be left behind as if it had worked.
    const controller = new AuthController({
      store: new SecretStore({ dbName: 'waxwing-auth-blocked-2', indexedDB: blockedIndexedDb() }),
      getBaseUri: () => 'http://localhost:5173/',
    })

    await expect(
      controller.startLogin({
        method: 'basic',
        username: 'alice',
        password: 'pw',
        staySignedIn: true,
      }),
    ).rejects.toThrow()
    expect(controller.getSession()).toBeNull()
  })

  it('does not apply the issuer check to an ephemeral session (R-83)', async () => {
    // The check protects the SHARED copy of the refresh token. A public-computer session's token
    // never enters the store, so a record left by a failed restore — or by a second tab signed in
    // durably elsewhere — describes a different credential entirely. Matching against it expired a
    // working session after an hour without so much as attempting a grant.
    const idp = fakeIdp()
    vi.stubGlobal('fetch', idp.fetchImpl)
    const { store } = freshStore()
    await store.put(
      SecretName.AuthRecord,
      JSON.stringify({
        method: 'oauth',
        username: null,
        oauth: {
          issuer: 'http://someone-else.invalid',
          clientId: 'waxwing',
          scopes: DEFAULT_SCOPES,
          redirectUri: 'http://localhost:5173/',
          discovery: 'oauth2',
          allowInsecureRequests: true,
        },
      }),
    )

    let clock = 1_700_000_000
    let href = 'http://localhost:5173/'
    let navigated: string | null = null
    const controller = new AuthController({
      oauth: OAUTH_CONFIG,
      store,
      now: () => clock,
      navigate: (url) => {
        navigated = url
      },
      getHref: () => href,
      getBaseUri: () => 'http://localhost:5173/',
      replaceUrl: (url) => {
        href = url
      },
    })
    await controller.startLogin({ method: 'oauth', publicComputer: true })
    const state = new URL(navigated as unknown as string).searchParams.get('state')
    href = `http://localhost:5173/?code=c&state=${state}`
    await controller.completeRedirect()

    clock += 3_600_001
    expect(await controller.getAccessToken()).toBe('access-refreshed-1')
    // The foreign record is untouched, and the ephemeral token never reached the store.
    expect(await store.get(SecretName.RefreshToken)).toBeNull()
  })

  it('keeps refusing a foreign record for a DURABLE session — the counter-test (W-17)', async () => {
    const idp = fakeIdp()
    vi.stubGlobal('fetch', idp.fetchImpl)
    const { store } = freshStore()
    await store.put(
      SecretName.AuthRecord,
      JSON.stringify({
        method: 'oauth',
        username: null,
        oauth: {
          issuer: 'http://someone-else.invalid',
          clientId: 'waxwing',
          scopes: DEFAULT_SCOPES,
          redirectUri: 'http://localhost:5173/',
          discovery: 'oauth2',
          allowInsecureRequests: true,
        },
      }),
    )
    await store.put(SecretName.RefreshToken, 'refresh-of-another-issuer')
    const controller = new AuthController({
      oauth: OAUTH_CONFIG,
      store,
      getBaseUri: () => 'http://localhost:5173/',
    })

    await expect(controller.getAccessToken()).rejects.toThrow(/different sign-in/)
    // Nothing was sent to the wrong token endpoint.
    expect(idp.calls.filter((c) => c.body.includes('grant_type=refresh_token'))).toHaveLength(0)
  })

  it('does not re-create the wiped database from a refresh that lost the race (R-79)', async () => {
    // `TokenStore.clear` reaches `SecretStore.delete`, which calls `openDb()` — which re-creates
    // the database and its object stores. A grant still on the wire when "Sign out & remove data"
    // finished therefore rebuilt `waxwing-auth` moments after the wipe deleted it: empty, but
    // present, and "this origin holds a Waxwing auth database" is exactly the statement the wipe
    // removes (W-23). The success path has had this guard since W-05; the failure path had not.
    const { store, dbName } = freshStore()
    let releaseGrant: (() => void) | undefined
    const grantReached = new Promise<void>((resolve) => {
      vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
        const url = input instanceof URL ? input.href : String(input)
        if (url.includes('/.well-known/')) return json(DISCOVERY)
        const held = new Promise<void>((release) => {
          releaseGrant = release
        })
        resolve()
        await held
        return new Response(JSON.stringify({ error: 'invalid_grant' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        })
      })
    })
    await store.put(
      SecretName.AuthRecord,
      JSON.stringify({
        method: 'oauth',
        username: null,
        oauth: {
          ...OAUTH_CONFIG,
          redirectUri: 'http://localhost:5173/',
          discovery: 'oauth2',
          allowInsecureRequests: true,
        },
      }),
    )
    await store.put(SecretName.RefreshToken, 'refresh-in-flight')
    const controller = new AuthController({
      oauth: OAUTH_CONFIG,
      store,
      getBaseUri: () => 'http://localhost:5173/',
    })
    await controller.restore()

    const refreshing = controller.getAccessToken().catch(() => 'failed')
    await grantReached
    await controller.logout()
    expect((await indexedDB.databases()).map((d) => d.name)).not.toContain(dbName)

    releaseGrant?.()
    expect(await refreshing).toBe('failed')

    // THE assertion: the failed grant must not have brought the database back.
    expect((await indexedDB.databases()).map((d) => d.name)).not.toContain(dbName)
  })
})

/**
 * The JMAP Session document that makes an offline cold start possible (FR-OFF-01, R-78, ADR-041).
 *
 * It lives in this store rather than in the replica for one reason, and every test here is about
 * that reason: its validity IS the validity of the credentials beside it. It may only be written
 * when a cold start could read it back, it must name the identity whose credentials are here and
 * no other, and it must go when they go.
 */
describe('AuthController — the stored JMAP session document (FR-OFF-01)', () => {
  const DOC = { apiUrl: 'https://mail.waxwing.test/jmap/api', state: 'sess-1' }
  const CONNECT_URL = 'https://mail.waxwing.test'

  async function basicController(staySignedIn: boolean) {
    const { store, dbName } = freshStore()
    const controller = new AuthController({ store })
    await controller.startLogin({
      method: 'basic',
      username: 'alice@waxwing.test',
      password: 'pw',
      staySignedIn,
    })
    return { store, dbName, controller }
  }

  it('keeps the document for a session a cold start can restore, and hands it back', async () => {
    const { controller, dbName } = await basicController(true)
    await controller.rememberJmapSession(CONNECT_URL, DOC)

    const rebooted = new AuthController({ store: new SecretStore({ dbName }) })
    expect(await rebooted.restore()).not.toBeNull()
    const recalled = await rebooted.recallJmapSession()
    expect(recalled?.connectUrl).toBe(CONNECT_URL)
    expect(recalled?.document).toEqual(DOC)
    expect(typeof recalled?.storedAt).toBe('number')
  })

  it('THE GUARD: writes nothing when nothing about the session is persisted', async () => {
    // Basic without "stay signed in" (FR-AUTH-04). There is no AuthRecord, so `restore()` will
    // return null on the next cold start and the document could never be read back — storing it
    // would leave a username and a server on a machine where the user asked for the opposite and
    // got it for everything else.
    const { store, controller } = await basicController(false)
    await controller.rememberJmapSession(CONNECT_URL, DOC)
    expect(await store.get(SecretName.JmapSession)).toBeNull()
    expect(await controller.recallJmapSession()).toBeNull()
  })

  it('a public-computer OAuth callback leaves no document either (FR-AUTH-09)', async () => {
    const idp = fakeIdp()
    vi.stubGlobal('fetch', idp.fetchImpl)
    const { store } = freshStore()
    let currentHref = 'http://localhost:5173/'
    const controller = new AuthController({
      oauth: { issuer: 'http://localhost:18080', clientId: 'waxwing', scopes: DEFAULT_SCOPES },
      store,
      navigate: (url) => {
        currentHref = url
      },
      getHref: () => currentHref,
      getBaseUri: () => 'http://localhost:5173/',
      replaceUrl: (url) => {
        currentHref = url
      },
    })
    await controller.startLogin({ method: 'oauth', publicComputer: true })
    const state = new URL(currentHref).searchParams.get('state')
    currentHref = `http://localhost:5173/?code=c&state=${state}`
    await controller.completeRedirect()

    // No AuthRecord is written in this mode, so the guard refuses — the same rule, reached the
    // other way. Nothing about this session may outlive the tab.
    await controller.rememberJmapSession(CONNECT_URL, DOC)
    expect(await store.get(SecretName.JmapSession)).toBeNull()
  })

  it('THE ONE: a new Basic sign-in drops the previous identity’s document', async () => {
    // The window is reachable without any XSS: `startLogin` writes the new AuthRecord, and a
    // `connectSession` that then fails (a 403, a server that blinks) drops the user back on the
    // login form with the record on disk. Leave Alice's document beside Bob's credentials and the
    // next offline cold start rebuilds a client for ALICE's accountId — her replica rows on
    // screen, her account in every request — out of Bob's password.
    const { store, controller } = await basicController(true)
    await controller.rememberJmapSession(CONNECT_URL, DOC)
    expect(await store.get(SecretName.JmapSession)).not.toBeNull()

    await controller.startLogin({
      method: 'basic',
      username: 'bob@waxwing.test',
      password: 'pw2',
      staySignedIn: true,
    })
    expect(await store.get(SecretName.JmapSession)).toBeNull()
    expect(await store.get(SecretName.AuthRecord)).toContain('bob@waxwing.test')
  })

  it('a Basic sign-in WITHOUT "stay signed in" drops it too', async () => {
    const { store, controller } = await basicController(true)
    await controller.rememberJmapSession(CONNECT_URL, DOC)
    await controller.startLogin({ method: 'basic', username: 'bob@waxwing.test', password: 'pw2' })
    expect(await store.get(SecretName.JmapSession)).toBeNull()
  })

  it('an OAuth callback drops it as well — the identity changed there too', async () => {
    const idp = fakeIdp()
    vi.stubGlobal('fetch', idp.fetchImpl)
    const { store } = freshStore()
    await store.put(
      SecretName.AuthRecord,
      JSON.stringify({ method: 'basic', username: 'alice@waxwing.test' }),
    )
    await store.put(
      SecretName.JmapSession,
      JSON.stringify({ connectUrl: CONNECT_URL, document: DOC, storedAt: 0 }),
    )
    let currentHref = 'http://localhost:5173/'
    const controller = new AuthController({
      oauth: { issuer: 'http://localhost:18080', clientId: 'waxwing', scopes: DEFAULT_SCOPES },
      store,
      navigate: (url) => {
        currentHref = url
      },
      getHref: () => currentHref,
      getBaseUri: () => 'http://localhost:5173/',
      replaceUrl: (url) => {
        currentHref = url
      },
    })
    await controller.startLogin({ method: 'oauth' })
    const state = new URL(currentHref).searchParams.get('state')
    currentHref = `http://localhost:5173/?code=c&state=${state}`
    await controller.completeRedirect()

    expect(await store.get(SecretName.JmapSession)).toBeNull()
  })

  it('a plain sign-out takes it with the credentials — no wipeData needed', async () => {
    // The replica survives a plain sign-out and the document must not: it names the account, and
    // "Sign out" has to mean the same thing whichever of the two menu items was chosen.
    const { store, controller } = await basicController(true)
    await controller.rememberJmapSession(CONNECT_URL, DOC)
    await controller.logout()
    expect(await store.get(SecretName.JmapSession)).toBeNull()
  })

  it('"Sign out & remove data" takes it too (FR-AUTH-05)', async () => {
    const { store, dbName } = freshStore()
    // An empty wipe environment: this test is about the credential store, and the surrounding
    // `wipeLocalData` would otherwise reach for the real IndexedDB of the whole test run.
    const wipe: WipeEnvironment = {}
    const controller = new AuthController({ store, wipe })
    await controller.startLogin({
      method: 'basic',
      username: 'alice@waxwing.test',
      password: 'pw',
      staySignedIn: true,
    })
    await controller.rememberJmapSession(CONNECT_URL, DOC)
    await controller.logout({ wipeData: true })

    expect(await store.get(SecretName.JmapSession)).toBeNull()
    const rebooted = new AuthController({ store: new SecretStore({ dbName }) })
    expect(await rebooted.recallJmapSession()).toBeNull()
  })

  it('a corrupt document reads as no document rather than throwing', async () => {
    const { store, controller } = await basicController(true)
    await store.put(SecretName.JmapSession, '{not json')
    expect(await controller.recallJmapSession()).toBeNull()
    await store.put(SecretName.JmapSession, JSON.stringify({ document: DOC }))
    expect(await controller.recallJmapSession()).toBeNull()
  })
})
