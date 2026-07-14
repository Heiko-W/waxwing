/**
 * `shortcuts/` — the keyboard layer (M3.8, FR-UI-04): one registry, one listener, three surfaces
 * (keys, the `?` cheat-sheet, the ⌘K palette).
 *
 * The barrel deliberately exports ONLY the eager surface. `CommandPalette`, `ShortcutHelp`, the fuzzy
 * matcher, the recents model and the palette's item builder are reachable exclusively through the
 * `lazy(() => import(...))` calls in {@link ShortcutProvider} — re-exporting any of them here would
 * drag them straight back into the entry chunk and blow the size budget's intent.
 */

export { formatChord, isApplePlatform, matchesChord } from './keys'
export { SHORTCUTS } from './registry'
export { ShortcutProvider } from './ShortcutProvider'
export type {
  ShortcutAction,
  ShortcutContext,
  ShortcutGroup,
  ShortcutScope,
} from './types'
export { usePaletteUi } from './ui-store'
