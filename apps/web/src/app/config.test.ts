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
