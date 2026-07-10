/**
 * WCAG 2.x relative-luminance and contrast-ratio math (FR-A11Y-01).
 *
 * Pure functions, no DOM: used by the token contrast test (`tokens.contrast.test.ts`)
 * to prove every documented color pair meets WCAG 2.2 AA in both themes, and available
 * to any future tooling (e.g. a runtime accent-contrast guard). The formulae are the
 * normative ones from WCAG 2.x §1.4.3 / the "relative luminance" and "contrast ratio"
 * definitions — not an approximation.
 */

/** Parse `#rgb` or `#rrggbb` into 8-bit channels. Throws on anything else. */
export function parseHex(hex: string): { r: number; g: number; b: number } {
  const value = hex.trim().replace(/^#/, '')
  const full =
    value.length === 3
      ? value
          .split('')
          .map((c) => c + c)
          .join('')
      : value
  if (!/^[0-9a-fA-F]{6}$/.test(full)) {
    throw new Error(`Not a hex color: ${hex}`)
  }
  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  }
}

function channelLuminance(value8bit: number): number {
  const c = value8bit / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** WCAG relative luminance of a hex color, in [0, 1]. */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = parseHex(hex)
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b)
}

/** WCAG contrast ratio between two hex colors, in [1, 21]. Order-independent. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const lighter = Math.max(la, lb)
  const darker = Math.min(la, lb)
  return (lighter + 0.05) / (darker + 0.05)
}

/** Round a ratio to 2 dp for stable reporting/snapshotting. */
export function roundRatio(ratio: number): number {
  return Math.round(ratio * 100) / 100
}
