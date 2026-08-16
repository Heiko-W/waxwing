/**
 * Branding application (M4.5, FR-THEME-02) — chiefly the accent, because that is the one place a
 * hoster's `config.json` can produce an inaccessible UI and no test in this repo can see it: the
 * file is fetched at runtime, so `tokens.contrast.test.ts` (which reads tokens.css from disk) is
 * structurally blind to it. Deriving the label is where the guarantee has to live, so this is where
 * it is proved.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { contrastRatio } from '../ui/contrast'
import { DEFAULT_CONFIG, type WaxwingConfig } from './config'
import { applyBranding } from './theme'

function withAccent(accentColor: string | null): WaxwingConfig {
  return {
    ...DEFAULT_CONFIG,
    branding: { ...DEFAULT_CONFIG.branding, accentColor },
  }
}

const read = (name: string) => document.documentElement.style.getPropertyValue(name)

beforeEach(() => {
  document.documentElement.removeAttribute('style')
})

describe('applyBranding — the accent carries a legible label', () => {
  it('leaves both accent tokens alone when the hoster sets none', () => {
    // The default: tokens.css keeps its theme-aware accent (darker in light, lighter in dark), which
    // an inline style would flatten to one value for both themes.
    applyBranding(withAccent(null))
    expect(read('--waxwing-accent')).toBe('')
    expect(read('--waxwing-accent-contrast')).toBe('')
  })

  it('pairs a DARK accent with a light label, at AA or better', () => {
    applyBranding(withAccent('#7a1f3d'))
    expect(read('--waxwing-accent')).toBe('#7a1f3d')
    expect(contrastRatio(read('--waxwing-accent-contrast'), '#7a1f3d')).toBeGreaterThanOrEqual(4.5)
  })

  it('pairs a PALE accent with a dark label, at AA or better', () => {
    // The failure this exists for: setting only the fill leaves the built-in white label, so a pale
    // brand colour renders white-on-yellow. Guards deleting the derivation.
    applyBranding(withAccent('#ffd60a'))
    expect(read('--waxwing-accent')).toBe('#ffd60a')
    expect(read('--waxwing-accent-contrast')).toBe('#1d1d1f')
    expect(contrastRatio(read('--waxwing-accent-contrast'), '#ffd60a')).toBeGreaterThanOrEqual(4.5)
  })

  it('gives every plausible brand colour a label that meets AA', () => {
    // A sweep rather than three examples: the derivation is a floor, and a floor is only worth
    // anything if it holds across the range people actually pick.
    const brands = [
      '#000000',
      '#ffffff',
      '#2f6fe0',
      '#c10016',
      '#1e7b34',
      '#8a5d00',
      '#e08aa6',
      '#7d3ac0',
      '#00a3a3',
      '#f5f5f7',
      '#767676',
    ]
    for (const brand of brands) {
      document.documentElement.removeAttribute('style')
      applyBranding(withAccent(brand))
      const ratio = contrastRatio(read('--waxwing-accent-contrast'), brand)
      expect(ratio, `label on ${brand}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('leaves the built-in label alone for a value it cannot parse', () => {
    // A CSS keyword or a typo: apply what was asked for, but do not guess a label for it. Better a
    // theme-provided label than a wrong one.
    applyBranding(withAccent('rebeccapurple'))
    expect(read('--waxwing-accent')).toBe('rebeccapurple')
    expect(read('--waxwing-accent-contrast')).toBe('')
  })

  it('sets the document title from the product name', () => {
    applyBranding({
      ...DEFAULT_CONFIG,
      branding: { ...DEFAULT_CONFIG.branding, productName: 'Acme Mail' },
    })
    expect(document.title).toBe('Acme Mail')
  })
})
