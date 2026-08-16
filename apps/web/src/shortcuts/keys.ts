/**
 * Chord grammar + matching (M3.8). A chord is `['Mod+']? <key>`, where `<key>` is either a PRODUCED
 * CHARACTER (`e`, `E`, `#`, `?`, `/`) or a named key (`Enter`, `ArrowDown`).
 *
 * The rules below exist because keyboard layouts are not a detail:
 *
 *  - **`event.key`, never `event.code`.** `code` is physical: on a German layout `KeyZ` produces `y`.
 *  - **A symbol chord never checks `shiftKey`.** `#` is Shift+3 on en-US but UNSHIFTED on de-DE; `?`
 *    is Shift+/ on en-US and Shift+ß on de-DE; `/` is Shift+7 on de-DE. Requiring `!shiftKey` would
 *    make `#`/`?` dead on US layouts and `/` dead on German ones. The browser already resolved the
 *    layout for us — trust `event.key`.
 *  - **A letter chord compares case-insensitively** (so CapsLock is harmless) and requires `!shiftKey`
 *    for a lowercase chord / `shiftKey` for an uppercase one.
 *  - **AltGr sets BOTH `ctrlKey` and `altKey`** (Windows; Linux/mac ⌥ variants report the same for the
 *    layouts that need it). For a `Mod+` or LETTER chord that is exactly what we want to reject —
 *    AltGr+K must not open the palette. For a SYMBOL chord it is the opposite: on fr-FR, es-ES and
 *    it-IT, `#` IS AltGr (AltGr+3 / AltGr+à) — rejecting `ctrlKey && altKey` there makes `#`
 *    untypeable for those users. So a symbol chord accepts the AltGr combination and, exactly as with
 *    Shift, trusts the `event.key` the browser already resolved from the layout.
 *  - **IME.** A keystroke that is part of a composition (`isComposing`, or the legacy `keyCode 229`)
 *    matches nothing at all.
 *  - **`Mod` = ⌘ OR Ctrl on every platform.** Only the DISPLAY differs (see {@link formatChord}).
 */

/** The subset of a `KeyboardEvent` a chord match depends on — so tests can pass plain objects. */
export interface ChordEvent {
  readonly key: string
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly altKey: boolean
  readonly shiftKey: boolean
  readonly isComposing?: boolean
  readonly keyCode?: number
}

export interface ParsedChord {
  /** ⌘ or Ctrl is required. */
  readonly mod: boolean
  readonly key: string
}

export function parseChord(chord: string): ParsedChord {
  return chord.startsWith('Mod+')
    ? { mod: true, key: chord.slice('Mod+'.length) }
    : { mod: false, key: chord }
}

/** A single-character chord that is a letter (as opposed to a symbol or a digit). */
function isLetterChord(key: string): boolean {
  return key.length === 1 && key.toLowerCase() !== key.toUpperCase()
}

export function matchesChord(event: ChordEvent, chord: string): boolean {
  // IME first: a composition keystroke belongs to the input method, never to us.
  if (event.isComposing === true || event.keyCode === 229) return false

  const { mod, key } = parseChord(chord)

  if (mod) {
    // Alt is not part of the grammar, and AltGr (ctrl+alt) must never reach a Mod chord.
    if (event.altKey) return false
    if (!event.metaKey && !event.ctrlKey) return false
    if (event.shiftKey) return false
    return event.key.toLowerCase() === key.toLowerCase()
  }

  if (key.length === 1 && isLetterChord(key)) {
    if (event.metaKey || event.ctrlKey || event.altKey) return false
    if (event.key.length !== 1) return false
    // CapsLock yields key:'E', shiftKey:false — still an `e`. Shift+e yields key:'E', shiftKey:true.
    const wantsShift = key !== key.toLowerCase()
    if (event.shiftKey !== wantsShift) return false
    return event.key.toLowerCase() === key.toLowerCase()
  }

  if (key.length === 1) {
    // Symbol/digit. The LAYOUT decides which modifiers produce the character, so neither `shiftKey`
    // (en-US `#` = Shift+3) nor AltGr (fr-FR/es-ES/it-IT `#` = AltGr+3) may be required OR forbidden:
    // the browser has already resolved `event.key`. A plain ⌘/Ctrl/Alt combination is still rejected.
    const altGr = event.ctrlKey && event.altKey
    if (!altGr && (event.metaKey || event.ctrlKey || event.altKey)) return false
    if (event.key.length !== 1) return false
    return event.key === key
  }

  // Named key (`Enter`, `ArrowDown`, …).
  if (event.metaKey || event.ctrlKey || event.altKey) return false
  return event.key === key
}

export function matchesAny(event: ChordEvent, chords: readonly string[]): boolean {
  return chords.some((chord) => matchesChord(event, chord))
}

/** True on macOS/iOS/iPadOS — the ONLY thing this changes is whether ⌘ or Ctrl is DISPLAYED. */
export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent)
}

/**
 * A chord as display tokens, one `<kbd>` chip each: `['⌘', 'K']` / `['Strg', 'K']` / `['#']`.
 *
 * `ctrlLabel` is passed in because the non-Apple modifier is the one key cap on this keyboard whose
 * NAME is localised: a German keyboard is labelled **Strg**, and a cheat sheet that says "Ctrl" sends
 * the reader looking for a key that is not there. ⌘ is a glyph and needs no translation.
 */
export function formatChord(chord: string, apple: boolean, ctrlLabel = 'Ctrl'): string[] {
  const { mod, key } = parseChord(chord)
  const parts: string[] = []
  if (mod) parts.push(apple ? '⌘' : ctrlLabel)
  parts.push(key.length === 1 ? key.toUpperCase() : key)
  return parts
}
