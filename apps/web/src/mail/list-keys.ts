/**
 * The message grid's OWN keys — the ones `MessageList`'s `onKeyDown` handles rather than the
 * shortcut registry (B21).
 *
 * ## Why they are not registry rows
 *
 * These are the APG `grid` pattern's keys: arrows, Home/End, Space, Enter, Escape and ⌘/Ctrl+A.
 * They act on the FOCUSED GRID and follow the platform, so they belong to the widget, not to an
 * app-wide chord table — and they must not fire while the reader is in the search box or the
 * composer, which is exactly what a registry row would risk (`Escape` there means "close this", not
 * "clear the selection").
 *
 * ## Why they are listed here anyway
 *
 * Because `?` is the app's only answer to "what can I press", and it was generated from the registry
 * ALONE. So the whole grid — including select-all, which has no other keyboard route and no button
 * that says ⌘A — was undocumented: a reader pressing `?` was told, in effect, that those keys do
 * not exist. This table is what the cheat sheet renders for them.
 *
 * It is a duplicate of the handler, and duplicates drift, so `list-keys.test.ts` reads BOTH and
 * fails when the switch grows a case this table does not name (or loses one it does).
 *
 * The `keys` are `KeyboardEvent.key` values, NOT `keys.ts` chords: this table is never matched
 * against an event — the grid's own switch does that — and its only consumer is the cheat sheet,
 * which renders each one through {@link KEY_CAP_KEYS}. A key cap is the one thing on a keyboard
 * whose NAME is localised (a German board says **Leertaste** and **Pos 1**), so the caps are i18n
 * keys rather than literals, exactly as `formatChord` already treats Ctrl/**Strg**.
 */

export interface ListKeyRow {
  /** `KeyboardEvent.key` values (plus the `Shift+`/`Mod+` prefixes), one chip group each. */
  readonly keys: readonly string[]
  /** i18n key under `shortcuts.actions.list`. */
  readonly titleKey: string
}

/**
 * How each named key is CALLED on the reader's keyboard. Anything not in here renders as itself —
 * a letter, or an arrow glyph, which needs no translation.
 */
export const KEY_CAP_KEYS: Readonly<Record<string, string>> = {
  ' ': 'shortcuts.keys.space',
  Enter: 'shortcuts.keys.enter',
  Escape: 'shortcuts.keys.esc',
  Home: 'shortcuts.keys.home',
  End: 'shortcuts.keys.end',
}

export const LIST_KEYS: readonly ListKeyRow[] = [
  { keys: ['↓', '↑'], titleKey: 'shortcuts.actions.list.move' },
  { keys: ['Shift+↓', 'Shift+↑'], titleKey: 'shortcuts.actions.list.extend' },
  { keys: ['Home', 'End'], titleKey: 'shortcuts.actions.list.ends' },
  { keys: [' '], titleKey: 'shortcuts.actions.list.select' },
  { keys: ['Enter'], titleKey: 'shortcuts.actions.list.open' },
  { keys: ['Mod+a'], titleKey: 'shortcuts.actions.list.selectAll' },
  { keys: ['Escape'], titleKey: 'shortcuts.actions.list.clear' },
]
