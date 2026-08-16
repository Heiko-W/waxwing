/**
 * Selectable accent palettes (M4.5, FR-THEME-03).
 *
 * The accent is the one saturated colour on screen at rest, so it is the setting people most want to
 * make theirs — and the one most easily made inaccessible. Three things follow, and they are why
 * this is a fixed list rather than a colour picker:
 *
 *  1. **Every palette is theme-aware.** A single hex cannot serve both themes: a blue that reads well
 *     on white is muddy on near-black. Each entry carries a light and a dark value, exactly as the
 *     built-in accent in `tokens.css` does.
 *  2. **Every palette is contrast-proved**, in both themes, by `tokens.contrast.test.ts` — the same
 *     machine check the built-in tokens get. A free colour picker cannot be proved, which is why
 *     FR-THEME-03 says *palettes* and why `config.json`'s `accentColor` (which can be any value) is
 *     documented as not contrast-guaranteed and derives its label at runtime instead.
 *  3. **The label rides along.** Each palette names its own `contrast` value rather than trusting the
 *     theme's, because a palette that inverts lightness between themes needs the label to invert too.
 *
 * A hoster can narrow the list (`branding.accentPalettes`) or remove the choice entirely
 * (`branding.accentLocked`) — a deployment with a mandated brand colour should not offer users a way
 * to overrule it. Neither can invent a palette: an unproved colour is exactly what this avoids.
 *
 * Persisted in `localStorage` next to the theme, and for the same reason: it is applied on the
 * ONBOARDING screen, where there is no account and no replica to scope a preference to.
 */

export interface AccentPalette {
  readonly id: AccentId
  /** The accent in light mode, and the label that is legible on it. */
  readonly light: { readonly accent: string; readonly contrast: string }
  /** The accent in dark mode, and its label. */
  readonly dark: { readonly accent: string; readonly contrast: string }
}

export const ACCENT_IDS = ['blue', 'teal', 'green', 'amber', 'rose', 'purple'] as const
export type AccentId = (typeof ACCENT_IDS)[number]

/** The default — identical to the built-in accent in `tokens.css`, so "blue" changes nothing. */
export const DEFAULT_ACCENT: AccentId = 'blue'

export const ACCENT_PALETTES: readonly AccentPalette[] = [
  {
    id: 'blue',
    light: { accent: '#2f6fe0', contrast: '#ffffff' },
    dark: { accent: '#5e93f0', contrast: '#1d1d1f' },
  },
  {
    id: 'teal',
    light: { accent: '#0f6d70', contrast: '#ffffff' },
    dark: { accent: '#4fc4c7', contrast: '#1d1d1f' },
  },
  {
    id: 'green',
    light: { accent: '#1e7b34', contrast: '#ffffff' },
    dark: { accent: '#4fc06a', contrast: '#1d1d1f' },
  },
  {
    id: 'amber',
    // Light amber is bright by nature, so its label is dark in BOTH themes — the case the
    // per-palette `contrast` exists for.
    light: { accent: '#8a5d00', contrast: '#ffffff' },
    dark: { accent: '#ffd60a', contrast: '#1d1d1f' },
  },
  {
    id: 'rose',
    light: { accent: '#b5145a', contrast: '#ffffff' },
    dark: { accent: '#f186ad', contrast: '#1d1d1f' },
  },
  {
    id: 'purple',
    light: { accent: '#7d3ac0', contrast: '#ffffff' },
    dark: { accent: '#c89bf0', contrast: '#1d1d1f' },
  },
]

const STORAGE_KEY = 'waxwing.accent'

/** The four properties a palette writes; `tokens.css` reads them as per-theme slots. */
const SLOTS = [
  '--waxwing-accent-light',
  '--waxwing-accent-contrast-light',
  '--waxwing-accent-dark',
  '--waxwing-accent-contrast-dark',
] as const

let current: AccentId = DEFAULT_ACCENT

export function isAccentId(value: unknown): value is AccentId {
  return typeof value === 'string' && (ACCENT_IDS as readonly string[]).includes(value)
}

function readStored(): AccentId | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    return isAccentId(value) ? value : null
  } catch {
    return null
  }
}

/** The palettes this deployment offers: the hoster's subset, or all of them. */
export function availablePalettes(allowed: readonly string[] | null): readonly AccentPalette[] {
  if (allowed === null) return ACCENT_PALETTES
  const narrowed = ACCENT_PALETTES.filter((palette) => allowed.includes(palette.id))
  // An empty or nonsense list would leave the user with no accent at all, which is worse than
  // ignoring the config — so fall back rather than render an empty picker.
  return narrowed.length > 0 ? narrowed : ACCENT_PALETTES
}

/**
 * Write the chosen palette onto the document.
 *
 * Both themes are set at once, as `data-accent`-scoped rules would have to be — but as inline custom
 * properties there is no stylesheet to add, and the theme's own `[data-theme]` blocks still decide
 * WHICH pair applies, because the values below are written to two different pairs of properties that
 * `tokens.css` consumes. Keeping the light/dark split in CSS rather than resolving it here means the
 * choice survives a system theme change with no JS involved.
 */
function apply(id: AccentId): void {
  const palette = ACCENT_PALETTES.find((entry) => entry.id === id)
  if (palette === undefined) return
  const root = document.documentElement
  root.style.setProperty('--waxwing-accent-light', palette.light.accent)
  root.style.setProperty('--waxwing-accent-contrast-light', palette.light.contrast)
  root.style.setProperty('--waxwing-accent-dark', palette.dark.accent)
  root.style.setProperty('--waxwing-accent-contrast-dark', palette.dark.contrast)
  root.dataset.accent = id
}

/**
 * Apply the initial accent. A persisted user choice wins; a locked deployment ignores it, so pinning
 * a brand colour cannot be overridden by a stale localStorage entry from before it was pinned.
 */
export function initAccent(options: { readonly locked: boolean }): void {
  current = options.locked ? DEFAULT_ACCENT : (readStored() ?? DEFAULT_ACCENT)
  if (options.locked) {
    clear()
    return
  }
  apply(current)
}

/** Remove any applied palette, so the theme's built-in accent shows through again. */
function clear(): void {
  const root = document.documentElement
  for (const name of SLOTS) root.style.removeProperty(name)
  delete root.dataset.accent
}

export function setAccent(id: AccentId): void {
  current = id
  apply(id)
  try {
    localStorage.setItem(STORAGE_KEY, id)
  } catch {
    // Ignore persistence failures (private mode / storage disabled) — the choice still applies
    // for this session.
  }
}

export function getAccent(): AccentId {
  return current
}
