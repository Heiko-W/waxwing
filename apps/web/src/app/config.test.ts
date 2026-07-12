import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, loadConfig, normalizeConfig, type WaxwingConfig } from './config'

const withUndo = (undoSendSeconds: unknown): WaxwingConfig => ({
  ...DEFAULT_CONFIG,
  features: { ...DEFAULT_CONFIG.features, undoSendSeconds: undoSendSeconds as number },
})

describe('normalizeConfig — undoSendSeconds clamp (M2.8)', () => {
  it('defaults to the Apple-aligned 10 s', () => {
    expect(DEFAULT_CONFIG.features.undoSendSeconds).toBe(10)
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
    expect(normalizeConfig(withUndo('soon')).features.undoSendSeconds).toBe(10)
    expect(normalizeConfig(withUndo(Number.NaN)).features.undoSendSeconds).toBe(10)
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
