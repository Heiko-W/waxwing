/**
 * User-configurable swipe actions for the message list (M3.9 — FR-LST-06).
 *
 * Kept in `mail/`, beside the list that has to mean something by the value; the settings screen only
 * renders two pickers. That is also what stops a `settings → mail → settings` import cycle.
 *
 * Two independent scalar keys, never one compound object: a single `swipe` record would need the
 * read-modify-write transaction the repo documents for compound prefs, for no gain — the directions
 * are set one at a time and read one at a time.
 *
 * No `config.json` layer, unlike `useUndoSendSeconds` / `useRemoteContentDefault`: a hoster has no
 * stake in which way a finger goes, and every deployment starts from the same two defaults.
 */

import { useLocalPrefOptional } from '../sync'

export const SWIPE_PREF_KEYS = {
  left: 'swipe.left',
  right: 'swipe.right',
} as const

export type SwipeAction = 'archive' | 'trash' | 'read' | 'none'

/** The order the settings pickers offer. `none` disables the direction outright. */
export const SWIPE_ACTIONS: readonly SwipeAction[] = ['archive', 'trash', 'read', 'none']

export function coerceSwipeAction(value: unknown, fallback: SwipeAction): SwipeAction {
  return SWIPE_ACTIONS.includes(value as SwipeAction) ? (value as SwipeAction) : fallback
}

/** Default `archive` — and archive falls back to Trash on an account that has no Archive role. */
export function useSwipeLeft(): SwipeAction {
  return coerceSwipeAction(useLocalPrefOptional<unknown>(SWIPE_PREF_KEYS.left), 'archive')
}

/** Default `read`, which toggles `$seen` against the row it is used on. */
export function useSwipeRight(): SwipeAction {
  return coerceSwipeAction(useLocalPrefOptional<unknown>(SWIPE_PREF_KEYS.right), 'read')
}
