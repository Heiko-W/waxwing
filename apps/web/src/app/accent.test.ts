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
import { contrastRatio, relativeLuminance, roundRatio } from '../ui/contrast'
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

/**
 * The page and surface colours each theme puts an accent on, from tokens.css.
 *
 * `raised` and `selected` were missing here until the browser axe sweep found the accent failing on
 * them (3.95:1 for the selected folder in the tree). They are the ones that fail FIRST — both are
 * darker than the page in light mode and lighter than it in dark mode — so a list without them
 * checks the two easiest backgrounds and calls the palette accessible.
 */
const SURFACES = {
  light: { bg: '#f5f5f7', surface: '#ffffff', sunken: '#eeeef2', raised: '#ebebef' },
  dark: { bg: '#1c1c1e', surface: '#2c2c2e', sunken: '#161618', raised: '#3a3a3c' },
} as const

/** The plane a selection tint is drawn ON, and the two text colours it has to carry. */
const CONTENT = {
  light: { surface: '#ffffff', text: '#1d1d1f', muted: '#636366' },
  dark: { surface: '#2c2c2e', text: '#f5f5f7', muted: '#b4b4bc' },
} as const

/** The corridor tokens.contrast.test.ts holds every state fill to, against the plane under it. */
const FILL_MIN = 1.12
const FILL_MAX = 1.75

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

  it('keeps every accent readable as TEXT on every surface it can land on', () => {
    // A palette is not only a fill: the selected folder, the active nav item and several links
    // render `color: var(--waxwing-accent)` directly on a surface, which is WCAG 1.4.3 normal text
    // at 4.5:1 — a full 1.5× stricter than the 3:1 the fill assertion below applies. Checking only
    // the fill is exactly how the default blue shipped at 3.95:1 against the selected row.
    for (const palette of ACCENT_PALETTES) {
      for (const theme of ['light', 'dark'] as const) {
        for (const [name, background] of Object.entries(SURFACES[theme])) {
          const ratio = roundRatio(contrastRatio(palette[theme].accent, background))
          expect(ratio, `${palette.id} ${theme}: accent TEXT on ${name}`).toBeGreaterThanOrEqual(
            TEXT_AA,
          )
        }
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

  it('keeps every selection tint readable — body text, secondary text and the accent on it', () => {
    // The tint is a FILL that carries text, so it answers to 1.4.3 three times over: the subject
    // line, the preview beneath it, and the accent itself, which the folder tree and the nav rail
    // both render as text on the selected row.
    for (const palette of ACCENT_PALETTES) {
      for (const theme of ['light', 'dark'] as const) {
        const { selected, accent } = palette[theme]
        const plane = CONTENT[theme]
        for (const [name, fg] of [
          ['text', plane.text],
          ['muted', plane.muted],
          ['accent', accent],
        ] as const) {
          const ratio = roundRatio(contrastRatio(fg, selected))
          expect(
            ratio,
            `${palette.id} ${theme}: ${name} on its selection tint`,
          ).toBeGreaterThanOrEqual(TEXT_AA)
        }
      }
    }
  })

  it('tints every selection by the same amount, and in the same direction', () => {
    // Without this, one palette gets a tint you can barely see and the next one shouts. The
    // direction half matters just as much: a selection that is lighter than the surface under one
    // accent and darker under another makes the same gesture look like two different things.
    for (const palette of ACCENT_PALETTES) {
      for (const theme of ['light', 'dark'] as const) {
        const { selected } = palette[theme]
        const surface = CONTENT[theme].surface
        const ratio = roundRatio(contrastRatio(selected, surface))
        expect(ratio, `${palette.id} ${theme}: tint against the surface`).toBeGreaterThanOrEqual(
          FILL_MIN,
        )
        expect(ratio, `${palette.id} ${theme}: tint against the surface`).toBeLessThanOrEqual(
          FILL_MAX,
        )
        expect(
          relativeLuminance(selected) > relativeLuminance(surface),
          `${palette.id} ${theme}: tint should be ${theme === 'dark' ? 'lighter' : 'darker'} than the surface`,
        ).toBe(theme === 'dark')
      }
    }
  })

  it('matches the built-in accent exactly for the default palette', () => {
    // "blue" must be a no-op: selecting it, or never selecting anything, has to render identically
    // to the shipped tokens, or the default install changes appearance for no reason.
    const blue = ACCENT_PALETTES.find((p) => p.id === DEFAULT_ACCENT)
    expect(blue?.light).toEqual({ accent: '#2761c4', contrast: '#ffffff', selected: '#dbe7fa' })
    expect(blue?.dark).toEqual({ accent: '#82acf5', contrast: '#1d1d1f', selected: '#28394f' })
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
