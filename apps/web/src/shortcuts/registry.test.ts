/**
 * The conflict guard (M3.8). The cheat-sheet and the palette are GENERATED from the registry, so the
 * registry is the only thing that can be wrong — these assertions are what make "always accurate" true:
 * unique ids, at least one parseable chord each, a title that resolves in BOTH languages, and — the
 * one that actually bites — no two actions claiming the same chord in an overlapping scope.
 */

import { describe, expect, it } from 'vitest'
import de from '../i18n/locales/de/common.json'
import en from '../i18n/locales/en/common.json'
import { type ChordEvent, matchesChord, parseChord } from './keys'
import { SHORTCUTS } from './registry'
import { GROUP_ORDER, type ShortcutScope } from './types'

/** Walk a dot-path through a locale bundle; `undefined` when any segment is missing. */
function resolve(bundle: unknown, key: string): unknown {
  let node: unknown = bundle
  for (const segment of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined
    node = (node as Record<string, unknown>)[segment]
  }
  return node
}

/** A synthetic event that a chord's own grammar says should match it. */
function eventFor(chord: string): ChordEvent {
  const { mod, key } = parseChord(chord)
  const isUpperLetter =
    key.length === 1 && key.toLowerCase() !== key.toUpperCase() && key !== key.toLowerCase()
  return {
    key,
    metaKey: mod,
    ctrlKey: false,
    altKey: false,
    shiftKey: !mod && isUpperLetter,
  }
}

const SCOPES: readonly ShortcutScope[] = ['global', 'list', 'reading']

/** The concrete scopes a chord can actually fire in (a `global` action fires in every scope). */
function effectiveScopes(scopes: readonly ShortcutScope[]): Set<ShortcutScope> {
  return scopes.includes('global') ? new Set(SCOPES) : new Set(scopes)
}

describe('SHORTCUTS registry', () => {
  it('has unique ids', () => {
    const ids = SHORTCUTS.map((action) => action.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('gives every action at least one chord, and every chord parses under matchesChord', () => {
    for (const action of SHORTCUTS) {
      expect(action.keys.length, action.id).toBeGreaterThan(0)
      for (const chord of action.keys) {
        expect(matchesChord(eventFor(chord), chord), `${action.id} / ${chord}`).toBe(true)
      }
    }
  })

  it('uses a known group', () => {
    for (const action of SHORTCUTS) {
      expect(GROUP_ORDER, action.id).toContain(action.group)
    }
  })

  it('resolves every titleKey in BOTH en and de (the cheat-sheet is generated from these)', () => {
    for (const action of SHORTCUTS) {
      expect(typeof resolve(en, action.titleKey), `en: ${action.titleKey}`).toBe('string')
      expect(typeof resolve(de, action.titleKey), `de: ${action.titleKey}`).toBe('string')
    }
  })

  it('resolves every group + scope label in BOTH en and de', () => {
    for (const group of GROUP_ORDER) {
      expect(typeof resolve(en, `shortcuts.groups.${group}`)).toBe('string')
      expect(typeof resolve(de, `shortcuts.groups.${group}`)).toBe('string')
    }
    for (const scope of SCOPES) {
      expect(typeof resolve(en, `shortcuts.scopes.${scope}`)).toBe('string')
      expect(typeof resolve(de, `shortcuts.scopes.${scope}`)).toBe('string')
    }
  })

  // THE conflict guard: `u` is allowed twice (list vs. reading — disjoint), `e` is not.
  it('never lets two actions claim the same chord within one scope', () => {
    const claims = new Map<string, string>() // "<scope>|<chord>" → action id
    for (const action of SHORTCUTS) {
      for (const chord of action.keys) {
        for (const scope of effectiveScopes(action.scopes)) {
          const slot = `${scope}|${chord}`
          const owner = claims.get(slot)
          expect(owner, `${slot} claimed by both ${owner} and ${action.id}`).toBeUndefined()
          claims.set(slot, action.id)
        }
      }
    }
  })

  it('only j/k may auto-repeat', () => {
    const repeatable = SHORTCUTS.filter((action) => action.allowRepeat === true).map((a) => a.id)
    expect(repeatable).toEqual(['nav.next', 'nav.prev'])
  })
})
