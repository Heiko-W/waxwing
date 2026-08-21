/**
 * `sync/engine` (M1.3) — the single-writer sync engine: leader election, push-driven delta sync,
 * windowed backfill, and the optimistic action-queue (outbox). {@link SyncEngineHost} wires it into
 * the connected shell; {@link useEngineStatus} feeds the chrome status region.
 */

// The conflict/undo row types live with the schema (`../db`) but are part of the engine's contract.
export type { ConflictCode, OutboxConflict, OutboxUndo } from '../db'
export { type WindowSpec, windowQueryKey } from './backfill'
export {
  backoffDelayMs,
  DEFAULT_OUTBOX_BACKOFF,
  MAX_REFRESHES,
  type OutboxBackoff,
  RETRY_AFTER_CAP_MS,
  STUCK_AFTER_ATTEMPTS,
} from './backoff'
export { ENGINE_CHANNEL, EngineBus, type EngineBusMessage } from './bus'
export {
  classifySetError,
  classifyThrown,
  isAuthExpiry,
  type ReplayVerdict,
  SetErrorTypes,
} from './conflict'
export {
  type ContactMutationDispatcher,
  enqueueCreateAddressBook,
  enqueueCreateContactCard,
  enqueueDeleteAddressBook,
  enqueueDeleteContactCard,
  enqueueUpdateAddressBook,
  enqueueUpdateContactCard,
  type IdSource,
} from './contact-mutations'
export type { CalendarQuerySpecInput } from './delta'
export {
  clearEngines,
  createSyncEngine,
  getActiveEngine,
  getEngineFor,
  getRunningEngines,
  MAINTENANCE_INTERVAL_MS,
  SyncEngine,
  type SyncEngineDeps,
  setActiveEngine,
  setEngineFor,
  stopAllEngines,
  subscribeEngines,
} from './engine'
export {
  chooseBudget,
  type EvictionInputs,
  type EvictionPlan,
  LOW_WATERMARK,
  MIN_BUDGET_BYTES,
  PRESSURE_RATIO,
  PRUNE_GRACE_MS,
  planEnvelopePrune,
  planEviction,
  planWindowReap,
  QUERY_WINDOW_TTL_MS,
  QUOTA_SAFETY,
} from './eviction'
export {
  createPushMux,
  type EngineSpec,
  type FleetAccount,
  type FleetDeps,
  type PushMux,
  startEngineFleet,
} from './fleet'
export { SYNC_LOCK, startLeaderElection } from './leader'
export {
  EVICT_CHUNK,
  type MaintenanceDeps,
  type MaintenanceResult,
  PIN_PREFETCH_PER_PASS,
  runMaintenance,
  withQuotaRecovery,
} from './maintenance'
export { type GuardedType, type OutboxIntent, stateGuardType } from './outbox'
export { createJmapPort } from './port'
export { SyncEngineHost, useAccountEngine } from './react'
export { getEngineStatus, useEngineStatus } from './status'
export {
  type EnginePhase,
  type EngineStatus,
  INITIAL_ENGINE_STATUS,
  type JmapPort,
} from './types'
