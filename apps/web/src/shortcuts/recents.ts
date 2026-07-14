/**
 * The palette's recent-first ranking (M3.8, FR-UI-04).
 *
 * Persisted per ACCOUNT in `localPrefs['palette.recents']` (a plain most-recent-first id list), so it
 * survives a reload and never leaks between accounts. Writes go through the `updatePaletteRecents`
 * read-modify-write transaction rather than a blind `setPref`: two tabs running an action at the same
 * time would otherwise clobber each other's list.
 *
 * LAZY: imported only by the palette chunk.
 */

import { useCallback, useMemo } from 'react'
import { PALETTE_RECENTS_KEY, updatePaletteRecents, useLocalPref, useReplica } from '../sync'

export const RECENTS_CAP = 12

/** Dedupe, promote to the front, cap. Pure — the whole model, so it tests without a DB. */
export function pushRecent(current: readonly string[], id: string, cap = RECENTS_CAP): string[] {
  return [id, ...current.filter((entry) => entry !== id)].slice(0, cap)
}

export interface PaletteRecents {
  /** Most recent first. */
  readonly recents: readonly string[]
  push(id: string): void
}

export function usePaletteRecents(): PaletteRecents {
  const { db, accountId } = useReplica()
  const stored = useLocalPref<unknown>(PALETTE_RECENTS_KEY)

  const recents = useMemo<readonly string[]>(
    () =>
      Array.isArray(stored)
        ? stored.filter((entry): entry is string => typeof entry === 'string')
        : [],
    [stored],
  )

  const push = useCallback(
    (id: string) => {
      void updatePaletteRecents(db, accountId, (current) => pushRecent(current, id))
    },
    [db, accountId],
  )

  return { recents, push }
}
