/**
 * The sync-engine facade (M1.3). One instance runs per tab; only the {@link startLeaderElection}
 * leader actually syncs — followers reflect the leader's status off the {@link EngineBus} while
 * reading the same replica via Dexie's cross-tab liveQuery. The leader:
 *  - opens a push channel (SSE-first per D2) and, on every `StateChange`, runs a delta {@link sync};
 *  - runs an initial sync (mailbox pull → inbox backfill → email/thread delta) on becoming leader;
 *  - runs a periodic safety sweep — the polling fallback AND the SP.4 "absence ≠ freshness"
 *    re-probe (every Nth sweep forces a full query re-reconcile);
 *  - replays the outbox after every sync.
 *
 * Everything external (locks, push, broadcast, clock, online-ness) is injected so the whole loop is
 * hermetically testable with fakes; {@link createSyncEngine} fills the browser defaults.
 */

import {
  type AuthProvider,
  createPushChannel,
  type Id,
  JmapHttpError,
  type PushChannel,
  type SchedulerLike,
  type Session,
} from '@waxwing/jmap'
import type { ReplicaDb } from '../db'
import { getQueryCache, mailboxByRole, pendingOutbox, putEmailBody, putEmails } from '../repo'
import { backfillMailbox, loadMore, type WindowSpec, windowQueryKey } from './backfill'
import { type BroadcastChannelLike, defaultBroadcast, EngineBus } from './bus'
import { reconcileQuery, syncEmails, syncMailboxes, syncThreads } from './delta'
import { type LockManagerLike, startLeaderElection } from './leader'
import {
  type EnqueueOptions,
  enqueueAction,
  type OutboxIntent,
  type Rollback,
  replayOutbox,
} from './outbox'
import { setEngineStatus } from './status'
import { type EngineClock, type EngineStatus, INITIAL_ENGINE_STATUS, type JmapPort } from './types'

/** Data types we ask push to notify on and delta-sync. */
const WATCHED_TYPES = ['Mailbox', 'Thread', 'Email']

/** Force a full query re-reconcile every Nth safety sweep (SP.4 freshness re-probe). */
const FULL_SWEEP_EVERY = 5

export interface SyncEngineDeps {
  readonly db: ReplicaDb
  readonly port: JmapPort
  /** The JMAP session, for the push channel. */
  readonly session: Session
  readonly auth: AuthProvider
  readonly config: { readonly cacheDays: number }
  readonly clock: EngineClock
  readonly locks: LockManagerLike
  readonly createBus: () => BroadcastChannelLike
  readonly createPush: (
    session: Session,
    options: { auth: AuthProvider; dataTypes?: string[]; scheduler?: SchedulerLike },
  ) => PushChannel
  /** Current online-ness + a subscription to changes (defaults wrap `navigator`/`window`). */
  readonly isOnline: () => boolean
  readonly onOnlineChange: (listener: (online: boolean) => void) => () => void
  /** Routed a background-sync 401/403 to the re-auth funnel (FR-AUTH-06) instead of a stuck error. */
  readonly onAuthExpired?: () => void
  /** Safety-sweep / polling-fallback interval (ms). */
  readonly safetyIntervalMs?: number
}

const DEFAULT_SAFETY_INTERVAL_MS = 60_000

export class SyncEngine {
  private readonly db: ReplicaDb
  private readonly port: JmapPort
  private readonly accountId: Id
  private readonly clock: EngineClock

  private readonly stopController = new AbortController()
  private bus: EngineBus | undefined
  private push: PushChannel | undefined
  private leaderPromise: Promise<void> | undefined
  private offlineUnsub: (() => void) | undefined
  private busUnsub: (() => void) | undefined
  private safetyTimer: number | undefined

  private isLeader = false
  private started = false
  private status: EngineStatus = INITIAL_ENGINE_STATUS

  /** Canonical keys of the queries kept fresh; their specs live in the persisted QueryCacheRow. */
  private readonly watched = new Set<string>()
  /** In-memory rollbacks for optimistic outbox intents (lost on reload — persisted error rows = M3.3). */
  private readonly rollbacks = new Map<Id, Rollback>()

  private syncing = false
  private syncQueued = false
  private sweepCount = 0
  /** The in-flight sync pass, so {@link stop} can await it before the caller wipes the replica. */
  private activeSync: Promise<void> | undefined

  constructor(private readonly deps: SyncEngineDeps) {
    this.db = deps.db
    this.port = deps.port
    this.accountId = deps.port.accountId
    this.clock = deps.clock
    this.status = { ...INITIAL_ENGINE_STATUS, online: deps.isOnline() }
  }

  /** Start participating: elect leadership, reflect status, track online-ness. Idempotent. */
  start(): void {
    if (this.started) return
    this.started = true
    this.bus = new EngineBus(this.deps.createBus())
    this.busUnsub = this.bus.onMessage((message) => {
      // Followers mirror the leader's status (but keep their own leadership + online flags).
      if (!this.isLeader) {
        this.setStatus({ ...message.status, isLeader: false, online: this.deps.isOnline() }, false)
      }
    })
    this.offlineUnsub = this.deps.onOnlineChange((online) => {
      this.patch({ online })
      if (online && this.isLeader) void this.sync()
    })
    this.leaderPromise = startLeaderElection({
      locks: this.deps.locks,
      signal: this.stopController.signal,
      onLeadership: (isLeader) => this.onLeadership(isLeader),
    })
  }

  /** Stop syncing, release the lock, close push/bus. Awaitable so sign-out can wipe afterwards. */
  async stop(): Promise<void> {
    if (!this.started) return
    this.stopController.abort()
    if (this.safetyTimer !== undefined) this.clock.clearTimeout(this.safetyTimer)
    this.push?.close()
    this.busUnsub?.()
    this.offlineUnsub?.()
    this.bus?.close()
    this.push = undefined
    this.bus = undefined
    this.isLeader = false
    // Await the in-flight sync so a following wipe cannot delete the DB out from under it (which
    // would throw DatabaseClosedError and strand a bogus 'error' status into the next session).
    await this.activeSync?.catch(() => {})
    await this.leaderPromise?.catch(() => {})
    // Reset the shared status store so a fresh login never inherits this session's phase.
    this.status = { ...INITIAL_ENGINE_STATUS, online: this.deps.isOnline() }
    setEngineStatus(this.status)
  }

  /**
   * Enqueue a user action (optimistic apply now, replay on the next sync). NOTE (M3.3): the
   * in-memory rollback is held by the tab that dispatched; if a FOLLOWER dispatches and the LEADER
   * replays a rejected write, the leader marks the row `error` but cannot roll the replica back
   * until a full re-sync corrects it. Single-tab (the common case) rolls back correctly.
   */
  async dispatch(intent: OutboxIntent, options: Omit<EnqueueOptions, 'now'>): Promise<void> {
    const { id, rollback } = await enqueueAction(this.db, this.accountId, intent, {
      ...options,
      now: this.clock.now(),
    })
    this.rollbacks.set(id, rollback)
    await this.refreshPendingCount()
    if (this.isLeader) void this.sync()
  }

  /** Page older messages into a watched query window. */
  async loadMoreFor(key: string, limit: number): Promise<void> {
    await loadMore(this.port, this.db, this.accountId, key, { limit, now: this.clock.now() })
  }

  /**
   * Register a (mailbox + sort/threading) window to keep fresh (M1.6 list) and return its canonical
   * key SYNCHRONOUSLY so the caller can subscribe to `queryCache[key]` immediately; the initial
   * backfill (when the window is not already cached) runs in the background. Idempotent per key.
   * NOTE (M1.9): a window opened on a FOLLOWER tab is backfilled but stays fresh only on the leader's
   * own watched set — cross-tab watch propagation via the bus is a follow-up.
   */
  watchWindow(mailboxId: Id, opts: WindowSpec = {}): string {
    const { key } = windowQueryKey(mailboxId, this.deps.config.cacheDays, this.clock.now(), opts)
    if (this.watched.has(key)) return key
    this.watched.add(key)
    void this.backfillWindowIfAbsent(mailboxId, key, opts)
    return key
  }

  private async backfillWindowIfAbsent(
    mailboxId: Id,
    key: string,
    opts: WindowSpec,
  ): Promise<void> {
    if ((await getQueryCache(this.db, this.accountId, key)) !== undefined) {
      // Already cached (adopted from a prior session/tab) — reconcile it on the next sweep.
      if (this.isLeader) void this.sync()
      return
    }
    await backfillMailbox(this.port, this.db, this.accountId, mailboxId, {
      cacheDays: this.deps.config.cacheDays,
      now: this.clock.now(),
      ...(opts.sort ? { sort: opts.sort } : {}),
      ...(opts.collapseThreads !== undefined ? { collapseThreads: opts.collapseThreads } : {}),
    })
  }

  /**
   * Fetch a message's full body (values/structure/attachments) into the replica when the reading
   * pane opens it (M1.8, FR-OFF-02: cached until LRU eviction). Already-cached bodies just get their
   * `lastAccessedAt` bumped (LRU touch) rather than re-fetched, so re-opens are offline-instant.
   */
  async fetchBody(emailId: Id): Promise<void> {
    const now = this.clock.now()
    const existing = await this.db.emailBodies.get([this.accountId, emailId])
    if (existing !== undefined) {
      await this.db.emailBodies.update([this.accountId, emailId], { lastAccessedAt: now })
      return
    }
    const { list } = await this.port.getEmailBodies([emailId])
    for (const body of list) {
      await putEmailBody(this.db, {
        accountId: this.accountId,
        ...body,
        fetchedAt: now,
        lastAccessedAt: now,
      })
    }
  }

  /**
   * Ensure the given email envelope rows exist in the replica (M1.8): the conversation view needs
   * every thread member's envelope, but the inbox is backfilled with `collapseThreads` so only each
   * thread's anchor id is stored — older/other-folder members (e.g. the user's own Sent replies)
   * have no envelope row and would otherwise render as a permanent skeleton. Fetches only the ids
   * not already present, so it is a cheap no-op once a thread is fully hydrated.
   */
  async fetchEnvelopes(ids: Id[]): Promise<void> {
    const missing: Id[] = []
    for (const id of ids) {
      if ((await this.db.emails.get([this.accountId, id])) === undefined) missing.push(id)
    }
    if (missing.length === 0) return
    const { list } = await this.port.getEmailEnvelopes(missing)
    await putEmails(this.db, this.accountId, list)
  }

  getStatus(): EngineStatus {
    return this.status
  }

  // ------------------------------------------------------------------------------------------

  private async onLeadership(isLeader: boolean): Promise<void> {
    this.isLeader = isLeader
    this.patch({ isLeader })
    if (!isLeader || this.stopController.signal.aborted) return
    this.openPush()
    this.scheduleSafetySweep()
    await this.sync()
  }

  private openPush(): void {
    const push = this.deps.createPush(this.deps.session, {
      auth: this.deps.auth,
      dataTypes: [...WATCHED_TYPES],
    })
    this.push = push
    push.onStatus((pushStatus) => this.patch({ pushStatus, pushTransport: push.transport }))
    push.subscribe(() => {
      void this.sync()
    })
    push.onError(() => {
      // The safety sweep covers a downed transport; no need to surface transient push errors.
    })
    push.open()
  }

  private scheduleSafetySweep(): void {
    if (this.stopController.signal.aborted) return
    const interval = this.deps.safetyIntervalMs ?? DEFAULT_SAFETY_INTERVAL_MS
    this.safetyTimer = this.clock.setTimeout(() => {
      if (this.isLeader) void this.sync()
      this.scheduleSafetySweep()
    }, interval)
  }

  /** One coalesced sync pass (leader only): delta sync → reconcile watched queries → replay outbox. */
  private async sync(): Promise<void> {
    if (!this.isLeader || this.stopController.signal.aborted) return
    if (this.syncing) {
      this.syncQueued = true
      return
    }
    this.syncing = true
    this.sweepCount += 1
    const forceFull = this.sweepCount % FULL_SWEEP_EVERY === 0
    this.patch({ phase: 'syncing', error: null })
    const pass = this.runSyncPass(forceFull)
    this.activeSync = pass
    await pass
    this.activeSync = undefined
    this.syncing = false
    if (this.syncQueued && this.isLeader && !this.stopController.signal.aborted) {
      this.syncQueued = false
      void this.sync()
    }
  }

  private async runSyncPass(forceFull: boolean): Promise<void> {
    try {
      await syncMailboxes(this.port, this.db, this.accountId, this.clock)
      await this.ensureInboxWindow()
      await syncThreads(this.port, this.db, this.accountId, this.clock)
      await syncEmails(this.port, this.db, this.accountId, this.clock)
      await this.reconcileWatched(forceFull)
      await replayOutbox(this.port, this.db, this.accountId, { rollbacks: this.rollbacks })
      const pending = await pendingOutbox(this.db, this.accountId)
      this.patch({ phase: 'idle', lastSyncedAt: this.clock.now(), pendingActions: pending.length })
    } catch (error) {
      // A background 401/403 means the session expired — route it to the re-auth funnel (FR-AUTH-06)
      // rather than sitting in a perpetual "Sync problem"; the overlay handles the UX.
      if (isAuthExpiry(error) && this.deps.onAuthExpired) {
        this.deps.onAuthExpired()
        this.patch({ phase: 'idle', error: null })
      } else {
        this.patch({ phase: 'error', error: errorMessage(error) })
      }
    }
  }

  /** Watch the inbox recent window: adopt an existing cached window if present, else backfill it. */
  private async ensureInboxWindow(): Promise<void> {
    if (this.watched.size > 0) return
    const inbox = await mailboxByRole(this.db, this.accountId, 'inbox')
    if (!inbox) return
    const now = this.clock.now()
    const { key } = windowQueryKey(inbox.id, this.deps.config.cacheDays, now)
    // A prior leader may already have backfilled today's window (the key is day-stable) — adopt it
    // instead of re-querying the whole window on every hand-over.
    if ((await getQueryCache(this.db, this.accountId, key)) !== undefined) {
      this.watched.add(key)
      return
    }
    const result = await backfillMailbox(this.port, this.db, this.accountId, inbox.id, {
      cacheDays: this.deps.config.cacheDays,
      now,
    })
    this.watched.add(result.key)
  }

  private async reconcileWatched(forceFull: boolean): Promise<void> {
    for (const key of this.watched) {
      const row = await getQueryCache(this.db, this.accountId, key)
      if (!row) continue
      const spec = { filter: row.filter, sort: row.sort, collapseThreads: row.collapseThreads }
      await reconcileQuery(this.port, this.db, this.accountId, key, spec, this.clock, forceFull)
    }
  }

  private async refreshPendingCount(): Promise<void> {
    const pending = await pendingOutbox(this.db, this.accountId)
    this.patch({ pendingActions: pending.length })
  }

  private patch(partial: Partial<EngineStatus>): void {
    // No status writes after teardown — a sync pass finishing during/after stop() must not clobber
    // the reset status (stop() owns the final write directly).
    if (this.stopController.signal.aborted) return
    this.setStatus({ ...this.status, ...partial }, this.isLeader)
  }

  private setStatus(next: EngineStatus, broadcast: boolean): void {
    this.status = next
    setEngineStatus(next)
    if (broadcast) this.bus?.postStatus(next)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A background 401/403 — the session expired and the engine should route to re-auth, not "error". */
function isAuthExpiry(error: unknown): boolean {
  return error instanceof JmapHttpError && (error.status === 401 || error.status === 403)
}

// The single running engine for this tab, so the out-of-React sign-out path can stop it (release
// the Web Lock + close push) BEFORE wiping the replica — deleting IndexedDB blocks on open handles.
// Observable so React consumers (the message list) re-run their watch effect the moment the engine
// appears, rather than racing the SyncEngineHost effect that sets it (a null read = a stuck window).
let activeEngine: SyncEngine | null = null
const activeEngineListeners = new Set<() => void>()

export function setActiveEngine(engine: SyncEngine | null): void {
  activeEngine = engine
  for (const listener of activeEngineListeners) listener()
}
export function getActiveEngine(): SyncEngine | null {
  return activeEngine
}
export function subscribeActiveEngine(listener: () => void): () => void {
  activeEngineListeners.add(listener)
  return () => {
    activeEngineListeners.delete(listener)
  }
}

/** Browser-wired {@link SyncEngine}: real locks, BroadcastChannel, push, and `navigator.onLine`. */
export function createSyncEngine(deps: {
  db: ReplicaDb
  port: JmapPort
  session: Session
  auth: AuthProvider
  config: { cacheDays: number }
  onAuthExpired?: () => void
  clock?: EngineClock
  safetyIntervalMs?: number
}): SyncEngine {
  const clock: EngineClock = deps.clock ?? {
    now: () => Date.now(),
    setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms) as unknown as number,
    clearTimeout: (id) => globalThis.clearTimeout(id),
  }
  return new SyncEngine({
    db: deps.db,
    port: deps.port,
    session: deps.session,
    auth: deps.auth,
    config: deps.config,
    clock,
    locks: navigator.locks as unknown as LockManagerLike,
    createBus: () => defaultBroadcast(),
    createPush: (session, options) => createPushChannel(session, options),
    isOnline: () => navigator.onLine,
    onOnlineChange: (listener) => {
      const on = () => listener(true)
      const off = () => listener(false)
      window.addEventListener('online', on)
      window.addEventListener('offline', off)
      return () => {
        window.removeEventListener('online', on)
        window.removeEventListener('offline', off)
      }
    },
    ...(deps.onAuthExpired === undefined ? {} : { onAuthExpired: deps.onAuthExpired }),
    ...(deps.safetyIntervalMs === undefined ? {} : { safetyIntervalMs: deps.safetyIntervalMs }),
  })
}
