/**
 * The SHIPPED `public/config.json` against `DEFAULT_CONFIG` (M4.9).
 *
 * These are two copies of the same shape, kept in different languages, and nothing joined them:
 * `DEFAULT_CONFIG` is what the app falls back to when the file is missing or unreadable, and
 * `public/config.json` is what every install actually loads. A value that differs between them is a
 * setting nobody chose — the defaults say one thing, the shipped file quietly does another, and the
 * spec's stated default is what a reader will believe.
 *
 * Found exactly that: `undoSendSeconds` was **10** in the shipped file against **15** in the
 * defaults and 15 in the spec (FR-CMP-08, §9). It arrived in an unrelated remediation commit with
 * no note, so it was drift rather than a decision.
 *
 * Runs in the Node "unit" project: it reads the shipped file from disk, which the jsdom project
 * cannot do.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, normalizeConfig, type WaxwingConfig } from './config'

const APP_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const CONFIGURATION_DOC = readFileSync(join(APP_ROOT, '../../docs/configuration.md'), 'utf8')
const shipped = JSON.parse(
  readFileSync(join(APP_ROOT, 'public/config.json'), 'utf8'),
) as WaxwingConfig

/** Dotted key → value, so two nested objects compare as flat sets. */
function flatten(value: unknown, prefix = ''): Map<string, unknown> {
  const out = new Map<string, unknown>()
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    out.set(prefix, value)
    return out
  }
  for (const [key, nested] of Object.entries(value)) {
    const path = prefix === '' ? key : `${prefix}.${key}`
    for (const [k, v] of flatten(nested, path)) out.set(k, v)
  }
  return out
}

const shippedKeys = flatten(shipped)
const defaultKeys = flatten(DEFAULT_CONFIG)

describe('the shipped config.json', () => {
  it('parses and is a plausible size (the check can go vacuous)', () => {
    // B22: a rename or a moved file would otherwise make every assertion below trivially true.
    expect(shippedKeys.size).toBeGreaterThan(15)
  })

  it('sets no value that differs from DEFAULT_CONFIG', () => {
    const drift: string[] = []
    for (const [key, value] of shippedKeys) {
      if (!defaultKeys.has(key)) continue
      const fallback = defaultKeys.get(key)
      if (JSON.stringify(value) !== JSON.stringify(fallback)) {
        drift.push(
          `${key}: shipped ${JSON.stringify(value)} vs default ${JSON.stringify(fallback)}`,
        )
      }
    }
    // A DELIBERATE difference is fine — this file is the hoster's to edit — but it belongs in the
    // deployment guide and in the spec, not only here. Changing this expectation without doing that
    // is the drift the test exists to stop.
    expect(drift, 'the shipped config disagrees with the documented defaults').toEqual([])
  })

  it('names every key the defaults do, and invents none', () => {
    // A key that exists only in the shipped file is ignored by the typed loader and does nothing —
    // it looks like a setting and is not one. A key missing from the shipped file is harmless (the
    // merge fills it in) but leaves the hoster with no hint the setting exists.
    expect([...shippedKeys.keys()].toSorted()).toEqual([...defaultKeys.keys()].toSorted())
  })
})

/**
 * `docs/configuration.md` against `normalizeConfig` (R-110).
 *
 * The reference spells out the clamping rules for `cacheDays` and `maxStorageMB` and said nothing
 * at all about `undoSendSeconds` beyond "`0` sends immediately" — so an operator reading it had no
 * reason not to write `60`, and no way to find out that they had silently got 30. The values below
 * are the ones the prose now promises; the assertions are what makes the prose a claim.
 */
describe('the documented ranges', () => {
  const undoSend = (seconds: unknown): number =>
    normalizeConfig({
      ...DEFAULT_CONFIG,
      features: { ...DEFAULT_CONFIG.features, undoSendSeconds: seconds as number },
    }).features.undoSendSeconds

  it('clamps undoSendSeconds to the documented 0–30 s', () => {
    expect(undoSend(31)).toBe(30)
    expect(undoSend(600)).toBe(30)
    expect(undoSend(-1)).toBe(0)
    expect(undoSend(0)).toBe(0)
    expect(undoSend(30)).toBe(30)
  })

  it('falls back to the default for a non-number, rather than clamping', () => {
    expect(undoSend('x')).toBe(DEFAULT_CONFIG.features.undoSendSeconds)
    expect(undoSend(Number.NaN)).toBe(DEFAULT_CONFIG.features.undoSendSeconds)
  })

  /** The prose has to carry the bound, or the two assertions above pin a secret. */
  it('is stated in `docs/configuration.md`', () => {
    const section = CONFIGURATION_DOC.slice(
      CONFIGURATION_DOC.indexOf('### `undoSendSeconds`'),
      CONFIGURATION_DOC.indexOf('## `offline`'),
    )
    expect(section).not.toBe('')
    expect(section).toContain('0–30 s')
    expect(section).toMatch(/falls back to the default/)
  })
})
