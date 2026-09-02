/**
 * The conflict guard (M3.8). The cheat-sheet and the palette are GENERATED from the registry, so the
 * registry is the only thing that can be wrong — these assertions are what make "always accurate" true:
 * unique ids, at least one parseable chord each, a title that resolves in BOTH languages, and — the
 * one that actually bites — no two actions claiming the same chord in an overlapping scope.
 */

import { describe, expect, it } from 'vitest'
import de from '../i18n/locales/de/common.json'
import en from '../i18n/locales/en/common.json'
import { ALL_GRANTED } from '../mail/rights'
import { type ChordEvent, matchesChord, parseChord } from './keys'
import { SHORTCUTS } from './registry'
import { GROUP_ORDER, type ShortcutContext, type ShortcutScope } from './types'

/** Walk a dot-path through a locale bundle; `undefined` when any segment is missing. */
function resolve(bundle: unknown, key: string): unknown {
  let node: unknown = bundle
  for (const segment of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined
    node = (node as Record<string, unknown>)[segment]
  }
  return node
}

/**
 * The named `KeyboardEvent.key` values a chord may use — every non-character key the app binds, plus
 * the ones the grid owns, so a new named chord has to be added here deliberately.
 *
 * It exists because {@link eventFor} cannot tell a real key from an invented one: it feeds the chord's
 * own key STRING back into `matchesChord`, so any string at all "matches" through the named-key
 * branch. `Shift+o` did exactly that for a year — the registry's own test called the chord parseable
 * while no keyboard could produce it (R-38). The grammar check below is the guard; this is its
 * vocabulary.
 */
const NAMED_KEYS: ReadonlySet<string> = new Set([
  ' ',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'Backspace',
  'Delete',
  'End',
  'Enter',
  'Escape',
  'Home',
  'PageDown',
  'PageUp',
  'Tab',
])

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

  /**
   * The grammar check the "every chord parses" test below cannot be (R-38).
   *
   * `keys.ts` knows exactly ONE prefix, `Mod+`; Shift is spelled by CASE (`O`, not `Shift+o`) and a
   * key part is therefore either a single produced character or one of the named keys above. A chord
   * that satisfies neither still "parses" — it falls into the named-key branch and is compared to
   * `event.key` — but no keyboard produces that string, so the chord is dead on every layout while
   * the cheat sheet keeps printing a chip for it.
   */
  it('spells every chord in the grammar `keys.ts` can actually match', () => {
    for (const action of SHORTCUTS) {
      for (const chord of action.keys) {
        const { key } = parseChord(chord)
        expect(key.includes('+'), `${action.id} / ${chord}: only Mod+ is a prefix`).toBe(false)
        expect(
          key.length === 1 || NAMED_KEYS.has(key),
          `${action.id} / ${chord}: not a character and not a named key`,
        ).toBe(true)
      }
    }
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

  it('resolves every `unavailable` reason — and the hint it points at — in BOTH en and de', () => {
    // The reasons are only reachable by CALLING the predicate, so build the account shape that
    // produces them: no role mailboxes at all, with the mailbox liveQuery resolved.
    const noRoles = {
      roles: {},
      rolesReady: true,
      inTrash: false,
      targetIds: ['m1'],
      sourceMailboxId: 'inbox',
      // Granted, so the keys this collects are the ACCOUNT-SHAPE reasons this test is about; the
      // rights reasons have their own coverage. Omitted it would be `undefined` and throw.
      rights: ALL_GRANTED,
    } as unknown as ShortcutContext
    const keys = SHORTCUTS.map((action) => action.unavailable?.(noRoles)).filter(
      (key): key is string => typeof key === 'string',
    )
    // Three today (archive, junk, trash). Without this the loop below is vacuously green the moment
    // someone drops the field — which is exactly the half of the Definition of Done that gets skipped.
    expect(keys).toHaveLength(3)
    for (const key of keys) {
      expect(typeof resolve(en, key), `en: ${key}`).toBe('string')
      expect(typeof resolve(de, key), `de: ${key}`).toBe('string')
    }
    // The dispatcher appends this to every one of them, so it is part of the same contract.
    expect(typeof resolve(en, 'shortcuts.unavailable.hint')).toBe('string')
    expect(typeof resolve(de, 'shortcuts.unavailable.hint')).toBe('string')
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
