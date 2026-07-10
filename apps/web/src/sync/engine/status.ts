/**
 * Engine-status store (M1.3) — the source the shell chrome subscribes to (fills the M1.4
 * `StatusRegion` seam). A tiny module-level external store (mirrors theme.ts / layout.ts): the
 * engine facade writes it (from the leader's sync activity, or from the cross-tab bus on a
 * follower), and {@link useEngineStatus} re-renders subscribers on change.
 */

import { useSyncExternalStore } from 'react'
import { type EngineStatus, INITIAL_ENGINE_STATUS } from './types'

let current: EngineStatus = INITIAL_ENGINE_STATUS
const listeners = new Set<() => void>()

export function getEngineStatus(): EngineStatus {
  return current
}

export function setEngineStatus(status: EngineStatus): void {
  current = status
  for (const listener of listeners) listener()
}

/** Merge a partial update into the current status (convenience for the facade). */
export function patchEngineStatus(patch: Partial<EngineStatus>): void {
  setEngineStatus({ ...current, ...patch })
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange)
  return () => {
    listeners.delete(onChange)
  }
}

/** The current engine status, re-rendering on change. */
export function useEngineStatus(): EngineStatus {
  return useSyncExternalStore(subscribe, getEngineStatus, () => INITIAL_ENGINE_STATUS)
}
