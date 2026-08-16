/**
 * Accent palettes (M4.5, FR-THEME-03).
 *
 * The point of shipping a fixed LIST rather than a colour picker is that every entry can be proved
 * accessible before anyone sees it. This is that proof — the same assertions `tokens.contrast.test.ts`
 * makes for the built-in tokens, over every palette in both themes. A palette added without meeting
 * them fails here, which is the only thing standing between "let users pick a colour" and an
 * unreadable UI.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { contrastRatio, roundRatio } from '../ui/contrast'
import {
  ACCENT_IDS,
  ACCENT_PALETTES,
  availablePalettes,
  DEFAULT_ACCENT,
  getAccent,
  initAccent,
  isAccentId,
  setAccent,
} from './accent'

/** WCAG 1.4.3 normal text — the label sits on the accent fill. */
const TEXT_AA = 4.5
/** WCAG 1.4.11 non-text UI — the accent as a fill against the page it sits on. */
const UI_AA = 3.0

/** The page and surface colours each theme puts an accent on, from tokens.css. */
const SURFACES = {
  light: { bg: '#f5f5f7', surface: '#ffffff' },
  dark: { bg: '#1c1c1e', surface: '#2c2c2e' },
} as const

beforeEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute('style')
  document.documentElement.removeAttribute('data-accent')
})

describe('accent palettes are accessible by construction', () => {
  it('ships one palette per declared id, with the default among them', () => {
    expect(ACCENT_PALETTES.map((p) => p.id).toSorted()).toEqual([...ACCENT_IDS].toSorted())
    expect(ACCENT_PALETTES.some((p) => p.id === DEFAULT_ACCENT)).toBe(true)
  })

  it('gives every palette a label that meets AA on its own fill, in both themes', () => {
    for (const palette of ACCENT_PALETTES) {
      for (const theme of ['light', 'dark'] as const) {
        const { accent, contrast } = palette[theme]
        const ratio = roundRatio(contrastRatio(contrast, accent))
        expect(ratio, `${palette.id} ${theme}: label on accent`).toBeGreaterThanOrEqual(TEXT_AA)
      }
    }
  })

  it('keeps every accent distinguishable as a FILL against page and surface', () => {
    // The accent is also drawn as a solid block (the brand mark, a primary button) on both the page
    // background and a card. WCAG 1.4.11 governs that, and it is the assertion a palette chosen only
    // for its label contrast would fail — a mid-tone that labels well can vanish into the surface.
    for (const palette of ACCENT_PALETTES) {
      for (const theme of ['light', 'dark'] as const) {
        for (const [name, background] of Object.entries(SURFACES[theme])) {
          const ratio = roundRatio(contrastRatio(palette[theme].accent, background))
          expect(ratio, `${palette.id} ${theme}: accent on ${name}`).toBeGreaterThanOrEqual(UI_AA)
        }
      }
    }
  })

  it('matches the built-in accent exactly for the default palette', () => {
    // "blue" must be a no-op: selecting it, or never selecting anything, has to render identically
    // to the shipped tokens, or the default install changes appearance for no reason.
    const blue = ACCENT_PALETTES.find((p) => p.id === DEFAULT_ACCENT)
    expect(blue?.light).toEqual({ accent: '#2f6fe0', contrast: '#ffffff' })
    expect(blue?.dark).toEqual({ accent: '#5e93f0', contrast: '#1d1d1f' })
  })
})

describe('selecting and persisting an accent', () => {
  it('writes both themes at once, so a system theme change needs no JS', () => {
    setAccent('rose')
    const root = document.documentElement.style
    expect(root.getPropertyValue('--waxwing-accent-light')).toBe('#b5145a')
    expect(root.getPropertyValue('--waxwing-accent-dark')).toBe('#f186ad')
    expect(root.getPropertyValue('--waxwing-accent-contrast-light')).toBe('#ffffff')
    expect(root.getPropertyValue('--waxwing-accent-contrast-dark')).toBe('#1d1d1f')
  })

  it('restores a persisted choice on the next start', () => {
    setAccent('teal')
    initAccent({ locked: false })
    expect(getAccent()).toBe('teal')
    expect(document.documentElement.style.getPropertyValue('--waxwing-accent-light')).toBe(
      '#0f6d70',
    )
  })

  it('ignores a persisted choice when the deployment pins its brand', () => {
    // Pinning has to beat a localStorage entry written before it was pinned, or a hoster who mandates
    // a brand colour finds existing users still overriding it.
    setAccent('purple')
    initAccent({ locked: true })
    expect(getAccent()).toBe(DEFAULT_ACCENT)
    expect(document.documentElement.style.getPropertyValue('--waxwing-accent-light')).toBe('')
  })

  it('falls back to the default for a stored value that is not a palette', () => {
    localStorage.setItem('waxwing.accent', 'chartreuse')
    initAccent({ locked: false })
    expect(getAccent()).toBe(DEFAULT_ACCENT)
  })

  it('validates ids', () => {
    expect(isAccentId('teal')).toBe(true)
    expect(isAccentId('chartreuse')).toBe(false)
    expect(isAccentId(null)).toBe(false)
  })
})

describe('a hoster can narrow the list, but not invent one', () => {
  it('offers everything when the hoster says nothing', () => {
    expect(availablePalettes(null)).toHaveLength(ACCENT_PALETTES.length)
  })

  it('offers only the named subset', () => {
    expect(availablePalettes(['teal', 'rose']).map((p) => p.id)).toEqual(['teal', 'rose'])
  })

  it('ignores a list that would leave no choice at all', () => {
    // An empty picker is worse than a disregarded config: the user would have no accent to select
    // and no way to tell that from a bug.
    expect(availablePalettes([])).toHaveLength(ACCENT_PALETTES.length)
    expect(availablePalettes(['chartreuse'])).toHaveLength(ACCENT_PALETTES.length)
  })
})
