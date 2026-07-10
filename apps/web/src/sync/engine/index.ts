/**
 * `sync/engine` (M1.3) — the single-writer sync engine: leader election, push-driven delta sync,
 * windowed backfill, and the optimistic action-queue (outbox). {@link SyncEngineHost} wires it into
 * the connected shell; {@link useEngineStatus} feeds the chrome status region.
 */

export { type WindowSpec, windowQueryKey } from './backfill'
export { ENGINE_CHANNEL, EngineBus } from './bus'
export {
  createSyncEngine,
  getActiveEngine,
  SyncEngine,
  type SyncEngineDeps,
  setActiveEngine,
  subscribeActiveEngine,
} from './engine'
export { SYNC_LOCK, startLeaderElection } from './leader'
export type { OutboxIntent } from './outbox'
export { createJmapPort } from './port'
export { SyncEngineHost, useActiveEngine } from './react'
export { getEngineStatus, useEngineStatus } from './status'
export {
  type EnginePhase,
  type EngineStatus,
  INITIAL_ENGINE_STATUS,
  type JmapPort,
} from './types'
