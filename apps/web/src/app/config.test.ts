import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, loadConfig, normalizeConfig, type WaxwingConfig } from './config'

const withUndo = (undoSendSeconds: unknown): WaxwingConfig => ({
  ...DEFAULT_CONFIG,
  features: { ...DEFAULT_CONFIG.features, undoSendSeconds: undoSendSeconds as number },
})

describe('normalizeConfig — undoSendSeconds clamp (M2.8)', () => {
  it('defaults to the 15 s the spec asks for (FR-CMP-08)', () => {
    // Was 10 until M3.7. The spec and M2.8's own note both said 15; the code said 10, and nobody
    // had decided that. The deployment value is still a DEFAULT — M3.7 gives the user a picker
    // (off / 5 / 15 / 30) that overrides it per account.
    expect(DEFAULT_CONFIG.features.undoSendSeconds).toBe(15)
  })

  it('clamps a negative grace to 0 (never a sticky, never-dismissing Undo toast)', () => {
    expect(normalizeConfig(withUndo(-5)).features.undoSendSeconds).toBe(0)
  })

  it('clamps an absurd grace to the 30 s ceiling', () => {
    expect(normalizeConfig(withUndo(9000)).features.undoSendSeconds).toBe(30)
  })

  it('rounds and keeps an in-range value', () => {
    expect(normalizeConfig(withUndo(12.6)).features.undoSendSeconds).toBe(13)
    expect(normalizeConfig(withUndo(5)).features.undoSendSeconds).toBe(5)
  })

  it('falls back to the default for a non-numeric / NaN override', () => {
    const fallback = DEFAULT_CONFIG.features.undoSendSeconds
    expect(normalizeConfig(withUndo('soon')).features.undoSendSeconds).toBe(fallback)
    expect(normalizeConfig(withUndo(Number.NaN)).features.undoSendSeconds).toBe(fallback)
  })
})

const withOffline = (offline: Partial<WaxwingConfig['offline']>): WaxwingConfig => ({
  ...DEFAULT_CONFIG,
  offline: { ...DEFAULT_CONFIG.offline, ...(offline as WaxwingConfig['offline']) },
})

describe('normalizeConfig — offline clamps (M3.4)', () => {
  it('keeps the defaults', () => {
    expect(DEFAULT_CONFIG.offline).toEqual({ cacheDays: 30, maxStorageMB: 512 })
  })

  it('rejects a cacheDays of 0 or less — it would push the window filter into the FUTURE', () => {
    // `windowFilter` builds `receivedAt >= now − cacheDays`: at 0 that boundary is today (and at −5 it
    // is in five days), so every mailbox would render permanently empty.
    expect(normalizeConfig(withOffline({ cacheDays: 0 })).offline.cacheDays).toBe(30)
    expect(normalizeConfig(withOffline({ cacheDays: -5 })).offline.cacheDays).toBe(30)
  })

  it('falls back to the default for a non-numeric cacheDays, and caps an absurd one', () => {
    expect(
      normalizeConfig(withOffline({ cacheDays: 'x' as unknown as number })).offline.cacheDays,
    ).toBe(30)
    expect(normalizeConfig(withOffline({ cacheDays: 99_999 })).offline.cacheDays).toBe(3650)
    expect(normalizeConfig(withOffline({ cacheDays: 14.6 })).offline.cacheDays).toBe(15)
  })

  it('clamps maxStorageMB to the 50–4096 MB range the eviction planner can honour', () => {
    expect(normalizeConfig(withOffline({ maxStorageMB: 1 })).offline.maxStorageMB).toBe(50)
    expect(normalizeConfig(withOffline({ maxStorageMB: 99_999 })).offline.maxStorageMB).toBe(4096)
    expect(
      normalizeConfig(withOffline({ maxStorageMB: 'lots' as unknown as number })).offline
        .maxStorageMB,
    ).toBe(512)
  })
})

describe('loadConfig — the boot deadline (M3.5)', () => {
  it('gives the request an abort signal: main.tsx AWAITS this before it renders anything', async () => {
    const fetchMock = vi.fn(
      async (_url: string, init?: RequestInit) =>
        new Response(JSON.stringify({ branding: { productName: 'Acme Mail' } }), {
          headers: { 'content-type': 'application/json' },
          // Only here to make the signal's presence load-bearing for the assertion below.
          status: init?.signal instanceof AbortSignal ? 200 : 500,
        }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const config = await loadConfig()
    expect(config.branding.productName).toBe('Acme Mail')
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
  })

  it('boots on the defaults when the request NEVER answers (a captive portal)', async () => {
    // A captive portal completes the TCP handshake and then says nothing — the fetch neither resolves
    // nor rejects. Nothing here rescues `loadConfig` except the deadline actually firing, and
    // `main.tsx` awaits it before it renders a single pixel: without the deadline this test hangs
    // forever, which is precisely what the app used to do.
    const hangs = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        }),
    )
    vi.stubGlobal('fetch', hangs)

    await expect(loadConfig({ timeoutMs: 10 })).resolves.toEqual(DEFAULT_CONFIG)
  })
})

/** Serve `body` as config.json, and capture what the loader complained about. */
function serveConfig(body: unknown): { readonly warnings: string[] } {
  const warnings: string[] = []
  vi.spyOn(console, 'warn').mockImplementation((message: unknown) => {
    warnings.push(String(message))
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }),
    ),
  )
  return { warnings }
}

describe('loadConfig — validating the operator-supplied config.json', () => {
  it('rejects a schemeless sessionUrl instead of letting it kill the boot', async () => {
    // The exact failure this exists for: `new URL('mail.example.com/.well-known/jmap')` throws a
    // TypeError, which used to escape `void boot()` as an unhandled rejection — no ErrorBoundary
    // catches an async rejection, so the app stayed on the booting spinner with no error and no
    // recovery. Falling back to the same-origin default at least boots something the reader can see.
    const { warnings } = serveConfig({
      server: { sessionUrl: 'mail.example.com/.well-known/jmap' },
    })

    const config = await loadConfig()

    expect(config.server.sessionUrl).toBeNull()
    expect(warnings.join('\n')).toContain('server.sessionUrl')
  })

  it('rejects a non-http(s) sessionUrl — this field decides who receives the password', async () => {
    serveConfig({ server: { sessionUrl: 'javascript:alert(1)' } })
    await expect(loadConfig()).resolves.toHaveProperty('server.sessionUrl', null)

    serveConfig({ server: { sessionUrl: 42 } })
    await expect(loadConfig()).resolves.toHaveProperty('server.sessionUrl', null)
  })

  it('keeps a valid sessionUrl, and still merges everything around it', async () => {
    serveConfig({
      server: { sessionUrl: 'https://mail.example.com/.well-known/jmap', allowCustomServer: false },
      branding: { productName: 'Acme Mail', defaultTheme: 'dark' },
      features: { remoteContentDefault: 'allow', imageProxyUrl: 'https://proxy.example.com/i' },
    })

    const config = await loadConfig()

    expect(config.server.sessionUrl).toBe('https://mail.example.com/.well-known/jmap')
    expect(config.server.allowCustomServer).toBe(false)
    expect(config.branding.productName).toBe('Acme Mail')
    expect(config.branding.defaultTheme).toBe('dark')
    expect(config.features.remoteContentDefault).toBe('allow')
    expect(config.features.imageProxyUrl).toBe('https://proxy.example.com/i')
    // Untouched nested keys keep their defaults — validation must not flatten the merge.
    expect(config.server.auth).toEqual(DEFAULT_CONFIG.server.auth)
    expect(config.branding.links).toEqual(DEFAULT_CONFIG.branding.links)
    expect(config.offline).toEqual(DEFAULT_CONFIG.offline)
  })

  it('never lets a junk auth list become an EMPTY one (a login form with no way in)', async () => {
    const { warnings } = serveConfig({ server: { auth: ['oidc', 'password'] } })

    const config = await loadConfig()

    expect(config.server.auth).toEqual(DEFAULT_CONFIG.server.auth)
    expect(warnings.join('\n')).toContain('server.auth')
  })

  it('filters a partly-valid auth list, keeping the operator preference order', async () => {
    serveConfig({ server: { auth: ['basic', 'saml', 'basic'] } })
    await expect(loadConfig()).resolves.toHaveProperty('server.auth', ['basic'])

    serveConfig({ server: { auth: 'basic' } })
    await expect(loadConfig()).resolves.toHaveProperty('server.auth', DEFAULT_CONFIG.server.auth)
  })

  it('rejects an enum typo and NAMES it — the only feedback a static deployment has', async () => {
    const { warnings } = serveConfig({
      branding: { defaultTheme: 'Dark' },
      features: { remoteContentDefault: 'always', imageProxyUrl: 'proxy.example.com' },
    })

    const config = await loadConfig()

    expect(config.branding.defaultTheme).toBe('auto')
    expect(config.features.remoteContentDefault).toBe('block')
    expect(config.features.imageProxyUrl).toBeNull()
    const text = warnings.join('\n')
    expect(text).toContain('branding.defaultTheme')
    expect(text).toContain('features.remoteContentDefault')
    expect(text).toContain('features.imageProxyUrl')
  })
})
