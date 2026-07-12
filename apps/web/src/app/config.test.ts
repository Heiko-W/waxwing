import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, normalizeConfig, type WaxwingConfig } from './config'

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
