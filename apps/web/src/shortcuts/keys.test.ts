import { describe, expect, it } from 'vitest'
import { type ChordEvent, formatChord, matchesAny, matchesChord, parseChord } from './keys'

/** A synthetic keydown. Defaults = no modifiers, no composition. */
function key(k: string, over: Partial<ChordEvent> = {}): ChordEvent {
  return { key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over }
}

describe('matchesChord — layouts', () => {
  // `#` is Shift+3 on en-US but UNSHIFTED on de-DE. A `!shiftKey` guard would kill it on US layouts.
  it('matches `#` whether or not Shift produced it (en-US vs de-DE)', () => {
    expect(matchesChord(key('#', { shiftKey: true }), '#')).toBe(true)
    expect(matchesChord(key('#', { shiftKey: false }), '#')).toBe(true)
  })

  it('matches `?` (Shift+/ on en-US, Shift+ß on de-DE)', () => {
    expect(matchesChord(key('?', { shiftKey: true }), '?')).toBe(true)
    expect(matchesChord(key('?'), '?')).toBe(true)
  })

  // `/` is unshifted on en-US but Shift+7 on de-DE — the shortcut must work on both.
  it('matches `/` with and without Shift', () => {
    expect(matchesChord(key('/'), '/')).toBe(true)
    expect(matchesChord(key('/', { shiftKey: true }), '/')).toBe(true)
  })

  it('matches `!` (Shift+1 everywhere)', () => {
    expect(matchesChord(key('!', { shiftKey: true }), '!')).toBe(true)
  })
})

describe('matchesChord — letters', () => {
  it('matches a lowercase chord under CapsLock (key "E", no Shift)', () => {
    expect(matchesChord(key('E'), 'e')).toBe(true)
    expect(matchesChord(key('e'), 'e')).toBe(true)
  })

  it('does NOT match a lowercase chord when Shift is held', () => {
    expect(matchesChord(key('E', { shiftKey: true }), 'e')).toBe(false)
  })

  it('an uppercase chord REQUIRES Shift', () => {
    expect(matchesChord(key('U', { shiftKey: true }), 'U')).toBe(true)
    expect(matchesChord(key('U'), 'U')).toBe(false)
    expect(matchesChord(key('u'), 'U')).toBe(false)
  })

  it('a bare letter never matches while a modifier is held', () => {
    expect(matchesChord(key('e', { metaKey: true }), 'e')).toBe(false)
    expect(matchesChord(key('e', { ctrlKey: true }), 'e')).toBe(false)
    expect(matchesChord(key('e', { altKey: true }), 'e')).toBe(false)
  })
})

describe('matchesChord — Mod, AltGr, IME', () => {
  it('Mod+k matches under BOTH ⌘ and Ctrl', () => {
    expect(matchesChord(key('k', { metaKey: true }), 'Mod+k')).toBe(true)
    expect(matchesChord(key('k', { ctrlKey: true }), 'Mod+k')).toBe(true)
    expect(matchesChord(key('K', { metaKey: true }), 'Mod+k')).toBe(true) // CapsLock
    expect(matchesChord(key('k'), 'Mod+k')).toBe(false)
    expect(matchesChord(key('k', { ctrlKey: true, shiftKey: true }), 'Mod+k')).toBe(false)
  })

  // AltGr arrives as ctrlKey && altKey. For a Mod/letter chord that must never fire…
  it('AltGr never fires a Mod or a letter chord', () => {
    expect(matchesChord(key('k', { ctrlKey: true, altKey: true }), 'Mod+k')).toBe(false)
    expect(matchesChord(key('e', { ctrlKey: true, altKey: true }), 'e')).toBe(false)
  })

  // …but on fr-FR / es-ES / it-IT, AltGr is HOW `#` is produced (AltGr+3, AltGr+à). Rejecting
  // ctrl+alt for a symbol chord makes `#` untypeable for those users — the same layout trap as Shift.
  it('AltGr DOES produce a symbol chord (fr-FR / es-ES / it-IT `#`)', () => {
    expect(matchesChord(key('#', { ctrlKey: true, altKey: true }), '#')).toBe(true)
    expect(matchesChord(key('#', { ctrlKey: true, altKey: true, shiftKey: true }), '#')).toBe(true)
  })

  it('a symbol chord still rejects a PLAIN ⌘/Ctrl/Alt combination', () => {
    expect(matchesChord(key('#', { ctrlKey: true }), '#')).toBe(false)
    expect(matchesChord(key('#', { metaKey: true }), '#')).toBe(false)
    expect(matchesChord(key('#', { altKey: true }), '#')).toBe(false)
  })

  it('an IME composition keystroke matches nothing', () => {
    expect(matchesChord(key('e', { isComposing: true }), 'e')).toBe(false)
    expect(matchesChord(key('e', { keyCode: 229 }), 'e')).toBe(false)
    expect(matchesChord(key('k', { metaKey: true, isComposing: true }), 'Mod+k')).toBe(false)
  })

  it('matches named keys exactly', () => {
    expect(matchesChord(key('Enter'), 'Enter')).toBe(true)
    expect(matchesChord(key('e'), 'Enter')).toBe(false)
  })

  it('matchesAny accepts a secondary chord', () => {
    expect(matchesAny(key('n', { metaKey: true }), ['c', 'Mod+n'])).toBe(true)
    expect(matchesAny(key('c'), ['c', 'Mod+n'])).toBe(true)
    expect(matchesAny(key('x'), ['c', 'Mod+n'])).toBe(false)
  })
})

describe('parseChord / formatChord', () => {
  it('parses the Mod prefix', () => {
    expect(parseChord('Mod+k')).toEqual({ mod: true, key: 'k' })
    expect(parseChord('#')).toEqual({ mod: false, key: '#' })
  })

  it('renders ⌘ on Apple and Ctrl elsewhere; symbols are untouched', () => {
    expect(formatChord('Mod+k', true)).toEqual(['⌘', 'K'])
    expect(formatChord('Mod+k', false)).toEqual(['Ctrl', 'K'])
    expect(formatChord('e', false)).toEqual(['E'])
    expect(formatChord('#', false)).toEqual(['#'])
    expect(formatChord('Enter', false)).toEqual(['Enter'])
  })
})
