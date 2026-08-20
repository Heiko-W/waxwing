/**
 * The sync-engine facade (M1.3, hardened in M3.3). One instance runs per tab; only the
 * {@link startLeaderElection} leader actually syncs — followers reflect the leader's status off the
 * {@link EngineBus} while reading the same replica via Dexie's cross-tab liveQuery. The leader:
 *  - opens a push channel (SSE-first per D2) and, on every `StateChange`, runs a delta {@link sync};
 *  - runs an initial sync (mailbox pull → inbox backfill → email/thread delta) on becoming leader;
 *  - runs a periodic safety sweep — the polling fallback AND the SP.4 "absence ≠ freshness"
 *    re-probe (every Nth sweep forces a full query re-reconcile);
 *  - replays the outbox — after every sync AND on demand ({@link requestReplay}), so a queued action
 *    never waits for a full delta round-trip, and a FOLLOWER's action wakes the leader over the bus.
 *
 * Everything external (locks, push, broadcast, clock, online-ness, randomness) is injected so the
 * whole loop — including offline/online flapping and retry backoff — is hermetically testable with
 * fakes; {@link createSyncEngine} fills the browser defaults.
 */

import {
  type AuthProvider,
  createPushChannel,
  type EmailFilter,
  getCoreCapability,
  type Id,
  JmapHttpError,
  JmapProblemError,
  type PushChannel,
  type PushTransport,
  type SchedulerLike,
  type SearchSnippet,
  type Session,
} from '@waxwing/jmap'
import type { NotifyNewMail } from '../../notify/notifier'
import {
  collectBodyBlobIds,
  type EmailBodyRow,
  type EmailEnvelopeInput,
  estimateBodyBytes,
  type ReplicaDb,
  scopeKey,
} from '../db'
import { canonicalContactQueryKey, canonicalQueryKey, type QuerySpec } from '../query-key'
import {
  failedOutbox,
  getContactQueryCache,
  getQueryCache,
  getSyncState,
  mailboxByRole,
  newestReceivedAt,
  pendingOutbox,
  putContactQueryCache,
  putEmailBody,
  putEmails,
  putQueryCache,
  setSyncState,
} from '../repo'
import { browserEstimate, type EstimateFn, isQuotaExceeded, reportStorageFull } from '../storage'
import {
  backfillMailbox,
  backfillQuery,
  loadMore,
  type WindowSpec,
  windowQueryKey,
} from './backfill'
import { backoffDelayMs, clampRetryAfter, STUCK_AFTER_ATTEMPTS } from './backoff'
import { type BroadcastChannelLike, defaultBroadcast, EngineBus } from './bus'
import { isAuthExpiry } from './conflict'
import {
  type ContactQuerySpecInput,
  reconcileContactQuery,
  reconcileQuery,
  syncAddressBooks,
  syncContactCards,
  syncEmails,
  syncIdentities,
  syncMailboxes,
  syncThreads,
} from './delta'
import { type LockManagerLike, startLeaderElection } from './leader'
import { type MaintenanceResult, runMaintenance, withQuotaRecovery } from './maintenance'
import {
  applyOptimistic,
  applyUndo,
  type EnqueueOptions,
  enqueueAction,
  type OutboxIntent,
  reapplyPendingCounts,
  replayOutbox,
  stateGuardType,
} from './outbox'
import { setEngineStatus } from './status'
import {
  CannotCalculateChangesError,
  type EngineClock,
  type EngineStatus,
  INITIAL_ENGINE_STATUS,
  type JmapPort,
} from './types'

/** Data types we ask push to notify on and delta-sync. */
const WATCHED_TYPES = ['Mailbox', 'Thread', 'Email', 'AddressBook', 'ContactCard']

/**
 * The push transports a *browser* may use (decision D2, ratified at G1; ADR-005).
 *
 * A browser cannot set the `Authorization` header on a `WebSocket` upgrade, and Stalwart offers no
 * query-param or subprotocol token fallback — so the RFC 8887 WS transport can never authenticate
 * here. It stays in the library for the Node/server-side path; this list states the browser's own
 * constraint at the only place that knows it.
 *
 * This is an allowlist (`transports`), NOT a preference (`prefer:'sse'`), and the difference is
 * load-bearing. `prefer` only *reorders*: it would yield `['sse','websocket','polling']`, leaving
 * the un-authable WebSocket in the chain one hop behind SSE. SSE would then have a real failover
 * target where today it has none, so a couple of transient SSE errors at login (server restarting,
 * a CORS blip) would spend the failover budget and strand the channel on the WebSocket — which is
 * itself terminal. Push would be permanently dead for the session, in exactly the case the current
 * order self-heals. Restricting the set instead keeps SSE last-real, so it retries forever.
 *
 * If a server ever ships browser-viable WS auth (the D2 revisit trigger), THIS is the first place
 * to look — it is what would keep the browser off a WebSocket that finally works.
 */
const BROWSER_PUSH_TRANSPORTS: readonly PushTransport[] = ['sse', 'polling']

/** Force a full query re-reconcile every Nth safety sweep (SP.4 freshness re-probe). */
const FULL_SWEEP_EVERY = 5

/**
 * A flapping connection fires `online` in bursts; each one used to start a full sync pass. Collapse
 * a burst into ONE pass once the line has settled for this long (M3.3).
 */
const RECONNECT_DEBOUNCE_MS = 750

/**
 * How often the periodic cache-maintenance pass may run (M3.4). Decoupled from the 60 s safety sweep:
 * eviction is bookkeeping, not freshness, and running it every minute would be pure churn.
 */
export const MAINTENANCE_INTERVAL_MS = 5 * 60_000

export interface SyncEngineDeps {
  readonly db: ReplicaDb
  readonly port: JmapPort
  /** The JMAP session, for the push channel. */
  readonly session: Session
  readonly auth: AuthProvider
  readonly config: { readonly cacheDays: number; readonly maxStorageMB: number }
  readonly clock: EngineClock
  /** Origin storage estimate (M3.4); defaults to {@link browserEstimate}. Injected in tests. */
  readonly estimate?: EstimateFn
  readonly locks: LockManagerLike
  /**
   * The exclusive leader lock name (M4.4). Omitted ⇒ the shared {@link SYNC_LOCK} — the historical
   * single-account name. A per-account engine passes `${SYNC_LOCK}:${accountId}` so two tabs never
   * elect two leaders for the SAME account, while the primary keeps the bare name unchanged.
   */
  readonly lockName?: string
  /**
   * Where this engine publishes its {@link EngineStatus} (M4.4). Omitted ⇒ the global
   * {@link setEngineStatus} store the chrome badge reads. A SECONDARY (shared-account) engine passes a
   * sink that discards it, so a background account's sync never flickers the primary's status badge.
   */
  readonly publishStatus?: (status: EngineStatus) => void
  readonly createBus: () => BroadcastChannelLike
  readonly createPush: (
    session: Session,
    options: {
      auth: AuthProvider
      dataTypes?: string[]
      transports?: readonly PushTransport[]
      scheduler?: SchedulerLike
    },
  ) => PushChannel
  /** Current online-ness + a subscription to changes (defaults wrap `navigator`/`window`). */
  readonly isOnline: () => boolean
  readonly onOnlineChange: (listener: (online: boolean) => void) => () => void
  /** Routed a background-sync 401/403 to the re-auth funnel (FR-AUTH-06) instead of a stuck error. */
  readonly onAuthExpired?: () => void
  /** Safety-sweep / polling-fallback interval (ms). */
  readonly safetyIntervalMs?: number
  /** Jitter source for the outbox retry backoff; defaults to `Math.random` (tests pass `() => 0`). */
  readonly random?: () => number
  /** Raise system notifications for newly delivered mail (M3.6). Absent ⇒ notifications never fire. */
  readonly notify?: NotifyNewMail
  /** Is this tab visible AND focused? Defaults to a document check in {@link createSyncEngine}. */
  readonly isForeground?: () => boolean
  /** How long to wait for another tab to answer the foreground probe; defaults to {@link FOREGROUND_ACK_MS}. */
  readonly foregroundAckMs?: number
}

const DEFAULT_SAFETY_INTERVAL_MS = 60_000

/**
 * Backoff for a sync pass that FAILED, as distinct from the safety sweep above (B47).
 *
 * The sweep is a freshness poll on a fixed cadence — it exists for the case where nothing went
 * wrong and no push arrived. It was also, until this existed, the only thing that ever retried a
 * failed pass: a transient error left `phase: 'error'` on screen and the next attempt came whenever
 * the 60 s timer happened to land, so a reader who tripped the server's request throttle watched
 * skeleton rows for up to a minute under a status line that said "retrying" while nothing was.
 *
 * The write path has had the right shape since M3.3 — `conflict.ts` classifies a 429/5xx as
 * transient and backs the row off, honouring `Retry-After`. This is the same treatment for the READ
 * path, which had none.
 *
 * The cap is the sweep interval, deliberately: past that the sweep would retry sooner anyway, and a
 * backoff that outruns the fallback is a backoff nobody reaches. Base 2 s under half-jitter puts the
 * first retry at 1–2 s, which is the difference between a stalled list and a blink.
 */
const SYNC_RETRY_BACKOFF = { baseMs: 2_000, factor: 2, capMs: DEFAULT_SAFETY_INTERVAL_MS } as const

/**
 * How long the leader waits for another tab to admit it is in the foreground (M3.6). A
 * `BroadcastChannel` round-trip inside one browser is sub-millisecond; this is generous, and it is
 * paid only on a pass that has new mail AND has cleared every other notification guard.
 */
const FOREGROUND_ACK_MS = 100

export class SyncEngine {
  private readonly db: ReplicaDb
  private readonly port: JmapPort
  /**
   * The account this engine speaks for — every write it enqueues and every row it reads is keyed on
   * it. Readable so a consumer or a test can prove the engine it holds is the one for its replica's
   * account: that pairing is the invariant the engine registry carries (see `getEngineFor`).
   */
  readonly accountId: Id
  private readonly clock: EngineClock
  private readonly random: () => number
  /** Where {@link setStatus} publishes; the global store by default (M4.4). */
  private readonly publishStatus: (status: EngineStatus) => void

  private readonly stopController = new AbortController()
  private bus: EngineBus | undefined
  private push: PushChannel | undefined
  private leaderPromise: Promise<void> | undefined
  private offlineUnsub: (() => void) | undefined
  private busUnsub: (() => void) | undefined
  private safetyTimer: number | undefined
  /** Consecutive failed sync passes. Drives {@link scheduleSyncRetry}; reset by the first success. */
  private syncFailures = 0
  private syncRetryTimer: number | undefined
  /** Wakes the leader when the earliest `notBefore` grace / `nextAttemptAt` backoff elapses. */
  private queueWakeTimer: number | undefined
  /** Debounces an `online` burst into a single reconnect sync (M3.3). */
  private reconnectTimer: number | undefined

  private isLeader = false
  private started = false
  private status: EngineStatus = INITIAL_ENGINE_STATUS

  /** Canonical keys of the queries kept fresh; their specs live in the persisted QueryCacheRow. */
  private readonly watched = new Set<string>()
  /** Query keys with a backfill in flight — dedups a search's watch-effect unwatch→rewatch churn. */
  private readonly inFlightBackfills = new Set<string>()

  /** Canonical keys of the CONTACT queries kept fresh (M4.2); specs live in the ContactQueryCacheRow. */
  private readonly watchedContacts = new Set<string>()
  /** Contact query keys with a backfill in flight — same unwatch→rewatch dedup as {@link inFlightBackfills}. */
  private readonly inFlightContactBackfills = new Set<string>()

  /** Identities are pulled once per leadership session (M2.5; Identity/changes deferred). */
  private identitiesSynced = false

  /**
   * M3.6's storm guard. The FIRST successful sync pass of a leadership session never notifies: that
   * pass IS the catch-up — a sign-in, a fresh tab, a re-election — and its delta may legitimately add
   * hundreds of ids. Silencing it structurally beats trying to date-filter our way out afterwards.
   *
   * It does NOT cover a laptop waking from sleep: a Web Lock survives suspend, so the tab is still the
   * leader, this flag is still armed, and every id that arrived overnight is genuinely new and clears
   * the floor. What bounds *that* case is the notifier's rolling burst budget, which collapses the
   * night's mail into one summary banner. Two different guards, two different jobs.
   */
  private notifyArmed = false
  /**
   * Stamped when leadership is acquired; mail not strictly newer than this is never notified.
   *
   * `clock.now()` is the CLIENT's clock while `receivedAt` is the SERVER's, so the floor is clamped
   * down to the newest `receivedAt` the replica already holds — see {@link anchorNotifyFloor}.
   */
  private notifySinceMs = 0
  /** The in-flight {@link anchorNotifyFloor}; awaited before the floor is first used, never before. */
  private notifyFloorReady: Promise<void> | undefined
  /** Settles the in-flight `foreground?` probe — on the first `foreground!` back, or on {@link stop}. */
  private settleForeground: ((foreground: boolean) => void) | undefined
  private syncing = false
  private syncQueued = false
  /** The replay-only pass, coalesced exactly like `syncing`/`syncQueued` — and shared with it, so a
   *  full sync and an on-demand replay can never interleave on the same queue. */
  private replaying: Promise<void> | undefined
  private replayQueued = false
  private sweepCount = 0
  /** The in-flight sync pass, so {@link stop} can await it before the caller wipes the replica. */
  private activeSync: Promise<void> | undefined

  /** The message the reading pane has open (M3.4) — never evicted out from under the reader. */
  private lastBodyFetchId: Id | null = null
  private lastMaintenanceAt = 0
  /** The in-flight maintenance pass, coalesced exactly like {@link replaying} and awaited by {@link stop}. */
  private maintaining: Promise<MaintenanceResult | null> | undefined
  private readonly estimate: EstimateFn

  constructor(private readonly deps: SyncEngineDeps) {
    this.db = deps.db
    this.port = deps.port
    this.accountId = deps.port.accountId
    this.clock = deps.clock
    this.random = deps.random ?? Math.random
    this.estimate = deps.estimate ?? browserEstimate
    this.publishStatus = deps.publishStatus ?? setEngineStatus
    this.status = { ...INITIAL_ENGINE_STATUS, online: deps.isOnline() }
  }

  /** Start participating: elect leadership, reflect status, track online-ness. Idempotent. */
  start(): void {
    if (this.started) return
    this.started = true
    this.bus = new EngineBus(this.deps.createBus())
    this.busUnsub = this.bus.onMessage((message) => {
      if (message.type === 'wake') {
        // A follower queued an action. Replay it now (and arm the grace/backoff timer for it) rather
        // than making it wait for the next push event or the 60 s sweep (M3.3, defect D7).
        if (this.isLeader) {
          this.requestReplay()
          void this.scheduleQueueWake()
        }
        return
      }
      if (message.type === 'foreground?') {
        // M3.6: the leader is about to raise a banner and wants to know whether the user is looking at
        // ANY tab of this app. Every tab answers for itself — leader or follower — and a tab that is
        // not in the foreground stays silent, because silence is the "no".
        if (this.deps.isForeground?.() === true) this.bus?.postForegroundAck()
        return
      }
      if (message.type === 'foreground!') {
        this.settleForeground?.(true)
        return
      }
      // Followers mirror the leader's status (but keep their own leadership + online flags).
      if (!this.isLeader) {
        this.setStatus({ ...message.status, isLeader: false, online: this.deps.isOnline() }, false)
      }
    })
    this.offlineUnsub = this.deps.onOnlineChange((online) => {
      if (!online) {
        this.cancelReconnect()
        this.patch({ online: false, phase: 'offline' })
        return
      }
      this.patch({ online: true })
      this.scheduleReconnect()
    })
    this.leaderPromise = startLeaderElection({
      locks: this.deps.locks,
      signal: this.stopController.signal,
      onLeadership: (isLeader) => this.onLeadership(isLeader),
      // Omitted ⇒ startLeaderElection defaults to the bare SYNC_LOCK (the primary's historical name).
      ...(this.deps.lockName === undefined ? {} : { lockName: this.deps.lockName }),
    })
  }

  /** Stop syncing, release the lock, close push/bus. Awaitable so sign-out can wipe afterwards. */
  async stop(): Promise<void> {
    if (!this.started) return
    this.stopController.abort()
    if (this.safetyTimer !== undefined) this.clock.clearTimeout(this.safetyTimer)
    if (this.queueWakeTimer !== undefined) this.clock.clearTimeout(this.queueWakeTimer)
    // A pending retry outlives `stop()` otherwise, and fires a sync against a torn-down engine.
    this.cancelSyncRetry()
    this.cancelReconnect()
    // A foreground probe in flight would otherwise sit on its timeout while `stop()` awaits the pass
    // that owns it. Settle it as "foreground" — on the way out, the safe direction is silence.
    this.settleForeground?.(true)
    this.push?.close()
    this.busUnsub?.()
    this.offlineUnsub?.()
    this.bus?.close()
    this.push = undefined
    this.bus = undefined
    this.isLeader = false
    this.identitiesSynced = false // refetch identities on the next leadership session
    // Await the in-flight sync so a following wipe cannot delete the DB out from under it (which
    // would throw DatabaseClosedError and strand a bogus 'error' status into the next session).
    await this.activeSync?.catch(() => {})
    await this.replaying?.catch(() => {})
    // Same for a maintenance pass: it deletes rows in chunked transactions, so a wipeReplica() racing
    // it would abort mid-pass with a DatabaseClosedError (M3.4).
    await this.maintaining?.catch(() => {})
    await this.leaderPromise?.catch(() => {})
    // Reset the shared status store so a fresh login never inherits this session's phase.
    this.status = { ...INITIAL_ENGINE_STATUS, online: this.deps.isOnline() }
    this.publishStatus(this.status)
  }

  /**
   * Enqueue a user action: apply it optimistically, persist the intent AND its durable undo, then
   * replay. The undo is data on the row (M3.3), so whichever tab is leader when the server rejects
   * the write can roll the replica back — including for an action a FOLLOWER dispatched.
   *
   * A follower cannot replay (it holds no lock), so it wakes the leader over the bus instead of
   * leaving the action — a SEND, possibly — parked until the leader's next sweep.
   */
  async dispatch(intent: OutboxIntent, options: Omit<EnqueueOptions, 'now'>): Promise<void> {
    const ifInState =
      options.ifInState !== undefined ? options.ifInState : await this.stateGuard(intent)
    await enqueueAction(this.db, this.accountId, intent, {
      ...options,
      ifInState,
      now: this.clock.now(),
    })
    await this.refreshQueueCounts()
    this.wakeQueue()
  }

  /**
   * The `ifInState` guard for a guarded `Foo/set` (M3.3; M4.2 for contacts): a Mailbox or ContactCard
   * state churns rarely, so a concurrent mutation by another client is exactly the "gentle notice"
   * case. `Email/set` stays UNGUARDED on purpose — the Email state is account-global and advances on
   * every inbound message, so a guard would turn every offline replay into a bogus conflict (and the
   * auto-chunker cannot split a state-guarded set, which would break every bulk cleanup chunk). Which
   * intents are guarded, and against which type's state, is decided by {@link stateGuardType}.
   */
  private async stateGuard(intent: OutboxIntent): Promise<string | null> {
    const type = stateGuardType(intent.kind)
    if (type === null) return null
    return getSyncState(this.db, this.accountId, type)
  }

  /**
   * Undo-send (M2.8): delete the still-`pending` submission, roll back its optimistic source flag
   * from the PERSISTED undo, and reset the draft to editable. Returns `true` if it was canceled,
   * `false` if it already fired / is firing.
   *
   * The only safety property required is "the EmailSubmission has not been dispatched" — which is
   * exactly `status === 'pending'`, enforced transactionally against replay's claim-to-`inflight`.
   * There is deliberately NO `notBefore` check (M3.3): a send queued offline, or one backed off
   * after a transient failure, is long past its grace yet has provably not been sent — it must stay
   * cancelable.
   */
  async cancelSend(id: Id): Promise<boolean> {
    // Claim the cancellation in ONE rw txn (re-read + delete) so it is mutually exclusive with
    // replayOutbox's claim-to-inflight on the same row: whichever txn commits first wins. If replay
    // already flipped it to `inflight` (send firing), the re-read sees non-`pending` → we abort.
    const row = await this.db.transaction('rw', this.db.outbox, async () => {
      const current = await this.db.outbox.get([this.accountId, id])
      if (current === undefined || current.status !== 'pending') return undefined
      await this.db.outbox.delete([this.accountId, id])
      return current
    })
    if (row === undefined) return false
    const intent = row.payload as OutboxIntent
    const undo = row.undo ?? null
    // A send's undo is local-only (the source `$answered`/`$forwarded` flag) — it cannot throw.
    if (undo !== null) await applyUndo(this.db, this.port, this.accountId, intent, undo, null)
    if (intent.kind === 'sendEmail') {
      await this.db.drafts.update([this.accountId, intent.localId], {
        status: 'pending',
        lastError: null,
      })
    }
    await this.scheduleQueueWake()
    await this.refreshQueueCounts()
    // Tell the LEADER too: it owns the status broadcast, so without this its stale queue counts
    // overwrite this tab's correct ones on the next tick (the badge would report a row we just removed).
    this.wakeQueue()
    return true
  }

  /**
   * Re-queue a dead letter (M3.3): re-apply the optimistic change, arm a FRESH undo, reset the
   * backoff. Returns `false` when the row is gone, is not a dead letter, still OWES its rollback
   * (applying the optimistic change on top of an un-undone one would double it), or is a `sendEmail`
   * — a rejected send is retried by the user from the reopened draft, never by re-queuing the
   * non-idempotent submission.
   *
   * The read, the optimistic re-apply and the row update are ONE `rw` transaction, so a concurrent
   * retry from another tab cannot apply it twice.
   */
  async retryFailed(id: Id): Promise<boolean> {
    const requeued = await this.db.transaction(
      'rw',
      this.db.outbox,
      this.db.emails,
      // `emailBodies` is in scope because a destroy's optimistic apply is `deleteEmails`, which
      // cascades to the bodies (M3.4) — and Dexie requires a sub-transaction's tables to be a SUBSET
      // of its parent's, so omitting it would make every retried destroy throw SubTransactionError.
      this.db.emailBodies,
      // Same rule for `queryCache`: a move/destroy's optimistic apply also prunes the message out of
      // the cached list windows (M3.8), in its own sub-transaction.
      this.db.queryCache,
      this.db.mailboxes,
      async (): Promise<OutboxIntent | null> => {
        const current = await this.db.outbox.get([this.accountId, id])
        if (current === undefined || current.status !== 'error') return null
        if ((current.undo ?? null) !== null) return null
        const intent = current.payload as OutboxIntent
        if (intent.kind === 'sendEmail') return null
        const undo = await applyOptimistic(this.db, this.accountId, intent)
        await this.db.outbox.update([this.accountId, id], {
          status: 'pending',
          attempts: 0,
          nextAttemptAt: null,
          refreshes: 0,
          lastError: null,
          conflict: null,
          undo,
        })
        return intent
      },
    )
    if (requeued === null) return false
    // `stampDraftError` flagged the drafts row `error` when this intent dead-lettered. Its intent is
    // back in the queue now, so clear that flag — otherwise the draft stays visibly "failed" forever
    // while it is in fact being retried.
    if (requeued.kind === 'saveDraft' || requeued.kind === 'discardDraft') {
      await this.db.drafts.update([this.accountId, requeued.localId], {
        status: 'pending',
        lastError: null,
      })
    }
    await this.refreshQueueCounts()
    this.wakeQueue()
    return true
  }

  /**
   * Discard a dead letter (M3.3). Its rollback normally ran when it failed, so the replica is
   * already consistent and the row is just a notice to dismiss. If the rollback is still OWED
   * (a re-fetch that could not reach the server), it is applied FIRST — and if that still fails the
   * row is KEPT, so the stale optimistic change stays visible as a problem instead of becoming
   * permanent, invisible corruption.
   */
  async discardFailed(id: Id): Promise<boolean> {
    const row = await this.db.outbox.get([this.accountId, id])
    if (row === undefined || row.status !== 'error') return false
    const undo = row.undo ?? null
    if (undo !== null) {
      try {
        await applyUndo(
          this.db,
          this.port,
          this.accountId,
          row.payload as OutboxIntent,
          undo,
          row.conflict?.ids ?? null,
        )
      } catch {
        return false // still owed — keep the row listed
      }
    }
    await this.db.outbox.delete([this.accountId, id])
    await this.refreshQueueCounts()
    this.wakeQueue() // the leader owns the status broadcast — make it recount, or the badge lies
    return true
  }

  /** Discard every dead letter (the problems dialog's "Discard all"). */
  async discardAllFailed(): Promise<void> {
    for (const row of await failedOutbox(this.db, this.accountId)) {
      await this.discardFailed(row.id)
    }
    await this.refreshQueueCounts()
    this.wakeQueue()
  }

  /** Replay now on the leader; on a follower, ask the leader to (BroadcastChannel skips the sender). */
  private wakeQueue(): void {
    if (this.isLeader) this.requestReplay()
    else this.bus?.postWake('outbox')
  }

  /** Arm/refresh the timer that wakes the leader when the earliest grace/backoff deadline elapses. */
  private async scheduleQueueWake(): Promise<void> {
    if (this.queueWakeTimer !== undefined) {
      this.clock.clearTimeout(this.queueWakeTimer)
      this.queueWakeTimer = undefined
    }
    if (this.stopController.signal.aborted) return
    const now = this.clock.now()
    const deadlines = (await pendingOutbox(this.db, this.accountId))
      .filter((row) => row.status === 'pending')
      .map((row) => Math.max(row.notBefore ?? 0, row.nextAttemptAt ?? 0))
      .filter((at) => at > now)
    if (deadlines.length === 0) return
    const delay = Math.max(0, Math.min(...deadlines) - now)
    this.queueWakeTimer = this.clock.setTimeout(() => {
      this.queueWakeTimer = undefined
      if (this.isLeader) this.requestReplay()
    }, delay)
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
   * Register an ARBITRARY watched query (a search, M3.1). Returns the canonical key SYNCHRONOUSLY so
   * the caller can subscribe to `queryCache[key]` immediately; the initial backfill runs in the
   * background. Reuses the folder-window machinery — `reconcileWatched` keeps it fresh (incl. the
   * forced full re-query re-probe). Searches are EPHEMERAL: the caller MUST {@link unwatchQuery} on
   * unmount / when the query changes, or `watched` grows unbounded (row eviction is M3.4).
   */
  watchQuery(spec: QuerySpec): string {
    const key = canonicalQueryKey(spec)
    if (this.watched.has(key)) return key
    this.watched.add(key)
    void this.backfillQueryIfAbsent(key, spec)
    return key
  }

  /** Stop keeping a search window fresh (folder windows stay watched for the session; searches don't). */
  unwatchQuery(key: string): void {
    this.watched.delete(key)
  }

  private async backfillQueryIfAbsent(key: string, spec: QuerySpec): Promise<void> {
    // A search's watch effect unwatches on cleanup then re-watches when its source ref churns (e.g. a
    // concurrent delta writes the mailboxes table). Without an in-flight guard the second call would
    // re-issue the whole Email/query+get before the first's putQueryCache lands — a wasted round-trip.
    if (this.inFlightBackfills.has(key)) return
    if ((await getQueryCache(this.db, this.accountId, key)) !== undefined) {
      if (this.isLeader) void this.sync()
      return
    }
    this.inFlightBackfills.add(key)
    try {
      await backfillQuery(this.port, this.db, this.accountId, spec, { now: this.clock.now() })
    } catch {
      // Shutdown is not a failed search. `stop()` does not await an in-flight backfill, so a sign-out
      // mid-search leaves this one running against a replica that is being wiped: every further write
      // throws `DatabaseClosedError`, and the recovery write below would throw too — an unhandled
      // rejection, and a pointless one. Bail out instead.
      if (this.stopController.signal.aborted) return
      // A rejected search filter (e.g. a server without full-text support) must not raise an
      // unhandled rejection OR leave the list spinning forever: write an empty window so it shows
      // "no results", and — the key stays watched — the next reconcile self-heals a transient error.
      await putQueryCache(this.db, {
        accountId: this.accountId,
        key,
        ids: [],
        queryState: '',
        total: 0,
        upToId: null,
        filter: spec.filter ?? null,
        sort: spec.sort ?? null,
        collapseThreads: spec.collapseThreads ?? false,
        lastUsedAt: this.clock.now(),
      })
    } finally {
      this.inFlightBackfills.delete(key)
    }
  }

  /**
   * Register a watched `ContactCard/query` (M4.2) — the contacts analogue of {@link watchQuery}.
   * Returns the canonical key SYNCHRONOUSLY so the caller can subscribe to `contactQueryCache[key]`
   * immediately; the initial backfill runs in the background. `reconcileWatchedContacts` keeps it
   * fresh (incl. the forced full re-query re-probe). The caller MUST {@link unwatchContactQuery} on
   * unmount / when the query changes, or `watchedContacts` grows unbounded.
   */
  watchContactQuery(spec: ContactQuerySpecInput): string {
    const key = canonicalContactQueryKey(spec)
    if (this.watchedContacts.has(key)) return key
    this.watchedContacts.add(key)
    void this.backfillContactQueryIfAbsent(key, spec)
    return key
  }

  /** Stop keeping a contact query window fresh. */
  unwatchContactQuery(key: string): void {
    this.watchedContacts.delete(key)
  }

  private async backfillContactQueryIfAbsent(
    key: string,
    spec: ContactQuerySpecInput,
  ): Promise<void> {
    // Same in-flight guard as {@link backfillQueryIfAbsent}: a watch effect that unwatches then
    // re-watches on a source-ref churn must not re-issue the whole query before the first lands.
    if (this.inFlightContactBackfills.has(key)) return
    if ((await getContactQueryCache(this.db, this.accountId, key)) !== undefined) {
      if (this.isLeader) void this.sync()
      return
    }
    this.inFlightContactBackfills.add(key)
    try {
      // A brand-new window has no cached row, so `forceFull` here is the initial full materialization.
      await reconcileContactQuery(this.port, this.db, this.accountId, key, spec, this.clock, true)
    } catch {
      if (this.stopController.signal.aborted) return
      // A rejected contact filter must not leave the list spinning forever: write an empty window so it
      // shows "no results", and — the key stays watched — the next reconcile self-heals a transient error.
      await putContactQueryCache(this.db, {
        accountId: this.accountId,
        key,
        ids: [],
        queryState: '',
        total: 0,
        upToId: null,
        filter: spec.filter ?? null,
        sort: spec.sort ?? null,
        lastUsedAt: this.clock.now(),
      })
    } finally {
      this.inFlightContactBackfills.delete(key)
    }
  }

  /**
   * Highlighted (`<mark>` markup) subject/preview for the visible slice of a search (M3.1). Transient
   * VIEW data (query-specific) — NOT persisted. A failure returns an empty map (the list falls back
   * to plain previews); the caller SANITIZES the markup before rendering.
   */
  async fetchSnippets(
    emailIds: Id[],
    filter: EmailFilter | null,
  ): Promise<Map<Id, Pick<SearchSnippet, 'subject' | 'preview'>>> {
    if (emailIds.length === 0) return new Map()
    try {
      const { list } = await this.port.getSearchSnippets(emailIds, filter)
      return new Map(list.map((snippet) => [snippet.emailId, snippet]))
    } catch {
      return new Map()
    }
  }

  /**
   * Fetch a message's full body (values/structure/attachments) into the replica when the reading
   * pane opens it (M1.8, FR-OFF-02: cached until LRU eviction). Already-cached bodies just get their
   * `lastAccessedAt` bumped (LRU touch) rather than re-fetched, so re-opens are offline-instant.
   *
   * M3.4: the opened message is recorded as {@link lastBodyFetchId} (it must never be evicted while
   * the reader is looking at it), and a body write rejected for lack of space triggers ONE forced
   * maintenance pass for exactly the bytes it needs and ONE retry.
   *
   * RETURNS the body when — and only when — it could NOT be persisted (the disk is full even after a
   * forced eviction pass). The reading pane is local-first: it renders from a liveQuery over
   * `emailBodies`, so a body that never lands in the replica would otherwise leave it spinning
   * FOREVER. Handing the caller the in-memory row keeps "caching is best-effort and must never fail
   * the read" actually true instead of merely intended. `null` = "it is in the replica, read it there".
   */
  async fetchBody(emailId: Id): Promise<EmailBodyRow | null> {
    const now = this.clock.now()
    this.lastBodyFetchId = emailId
    const existing = await this.db.emailBodies.get([this.accountId, emailId])
    // The LRU touch is UNCONDITIONAL — a row the reader just opened is hot whatever else happens
    // next. Leaving it inside the early return below made a pre-M3.9 row age toward eviction while
    // being re-fetched on every open, and offline it never ran at all (the fetch throws first).
    if (existing !== undefined) {
      await this.db.emailBodies.update([this.accountId, emailId], { lastAccessedAt: now })
    }
    // M3.9 INVARIANT: every write below sets `authResults` (`[]` when the message carries no such
    // header), so `undefined` means EXACTLY "this row was written before M3.9 and lacks the header
    // details". Re-fetch it — otherwise a message the reader has already opened would never gain them
    // until it happened to be evicted. (Once, in practice: the fetch rewrites the row with `[]` at
    // minimum. A message destroyed server-side yields no row and so re-fetches on each open — bounded
    // by the reader's own opens, and it is about to disappear from the list anyway.)
    if (existing !== undefined && existing.authResults !== undefined) return null
    const { list } = await this.port.getEmailBodies([emailId])
    let unstored: EmailBodyRow | null = null
    for (const body of list) {
      const row = {
        accountId: this.accountId,
        ...body,
        authResults: body.authResults ?? [],
        fetchedAt: now,
        lastAccessedAt: now,
      }
      try {
        await withQuotaRecovery(
          () => putEmailBody(this.db, row),
          (needBytes) => this.runMaintenance({ force: true, needBytes }),
          estimateBodyBytes(body),
        )
      } catch (error) {
        if (!isQuotaExceeded(error)) throw error
        reportStorageFull(now)
        if (body.id === emailId) {
          unstored = {
            ...row,
            bytes: estimateBodyBytes(body),
            ablob: collectBodyBlobIds(row).map((blobId) => scopeKey(this.accountId, blobId)),
          }
        }
      }
    }
    return unstored
  }

  /**
   * Run cache maintenance (M3.4): reap stale windows, evict to the low watermark, prune aged-out
   * envelopes, top up the pinned folders. Never throws.
   *
   * PERIODIC passes are leader-only — single-writer discipline: two tabs planning eviction against the
   * same replica would each measure a usage the other is already changing. A FORCED pass (the user's
   * "Free up space now", or the quota-recovery path) runs on any tab: its deletes are idempotent and
   * transactional, and a follower that just hit a full disk must be able to do something about it.
   *
   * A periodic pass COALESCES (a concurrent caller joins it), but a FORCED one must not: the in-flight
   * pass was planned with `needBytes: 0` and its eviction stage has very likely already run, so joining
   * it would resolve without freeing the bytes the caller is waiting for — the retry would hit
   * `QuotaExceededError` again and the user would be told the disk is full while megabytes of evictable
   * rows sat there. A forced pass therefore waits its turn and then runs a fresh one.
   */
  async runMaintenance(
    options: { force?: boolean; needBytes?: number } = {},
  ): Promise<MaintenanceResult | null> {
    if (this.stopController.signal.aborted) return null
    if (options.force !== true && this.maintaining !== undefined) return this.maintaining
    while (this.maintaining !== undefined) await this.maintaining
    if (this.stopController.signal.aborted) return null
    const now = this.clock.now()
    if (!options.force) {
      if (!this.isLeader) return null
      // `lastMaintenanceAt === 0` ⇒ this tab has never run one: the first pass after taking
      // leadership always maintains, whatever the wall clock says.
      if (this.lastMaintenanceAt !== 0 && now - this.lastMaintenanceAt < MAINTENANCE_INTERVAL_MS) {
        return null
      }
    }
    const pass = runMaintenance({
      db: this.db,
      accountId: this.accountId,
      config: {
        cacheDays: this.deps.config.cacheDays,
        maxStorageMB: this.deps.config.maxStorageMB,
      },
      estimate: this.estimate,
      now,
      watchedKeys: this.watched,
      lastBodyFetchId: this.lastBodyFetchId,
      signal: this.stopController.signal,
      ...(options.needBytes === undefined ? {} : { needBytes: options.needBytes }),
      // Prefetching a pinned folder is the one stage that talks to the server: leader + online only.
      ...(this.isLeader && this.deps.isOnline()
        ? { fetchBody: (id: Id) => this.prefetchBody(id) }
        : {}),
    }).catch(() => null)
    this.maintaining = pass
    try {
      return await pass
    } finally {
      this.maintaining = undefined
      this.lastMaintenanceAt = this.clock.now()
    }
  }

  /** Fetch one body for the pinned-folder prefetch — a plain write, with no quota-recovery re-entry. */
  private async prefetchBody(emailId: Id): Promise<void> {
    const now = this.clock.now()
    const { list } = await this.port.getEmailBodies([emailId])
    for (const body of list) {
      await putEmailBody(this.db, {
        accountId: this.accountId,
        ...body,
        // Same invariant as {@link fetchBody}: without this, a prefetched row would look like a
        // pre-M3.9 legacy row and be re-fetched the moment the reader opened it.
        authResults: body.authResults ?? [],
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

  /**
   * Empty a mailbox (M3.2 cleanup): destroy every message in it. Goes through the durable outbox
   * `destroyEmails` intent, chunked at the engine level (one resumable intent per batch). Returns the
   * number of messages scheduled for destruction.
   */
  emptyMailbox(mailboxId: Id): Promise<{ scheduled: number }> {
    return this.destroyMatching({ inMailbox: mailboxId })
  }

  /** Permanently destroy messages older than `beforeIso` in a mailbox — for Trash/Junk cleanup. */
  deleteOlderThan(mailboxId: Id, beforeIso: string): Promise<{ scheduled: number }> {
    return this.destroyMatching(olderFilter(mailboxId, beforeIso))
  }

  /**
   * Move messages older than `beforeIso` from `mailboxId` to `toMailboxId` (the Trash) — the
   * RECOVERABLE "delete older than" for a NORMAL folder, so a message multi-filed elsewhere is not
   * permanently destroyed everywhere (destroy is reserved for Trash/Junk).
   */
  trashOlderThan(
    mailboxId: Id,
    toMailboxId: Id,
    beforeIso: string,
  ): Promise<{ scheduled: number }> {
    return this.moveMatching(olderFilter(mailboxId, beforeIso), mailboxId, toMailboxId)
  }

  /** The bulk-cleanup chunk size = the server's `maxObjectsInSet` (fallback 500). */
  private get cleanupChunkSize(): number {
    return getCoreCapability(this.deps.session)?.maxObjectsInSet ?? 500
  }

  /**
   * Page ALL matching ids (oldest first) BEFORE any write, so a destructive/move pass never shifts
   * its own query positions. Terminates on the authoritative `total` when advertised (a short page is
   * not assumed to be the last), else on the first short/empty page.
   */
  private async collectMatchingIds(filter: EmailFilter): Promise<Id[]> {
    const PAGE = 500
    const ids: Id[] = []
    let position = 0
    for (;;) {
      const result = await this.port.queryEmails({
        filter,
        sort: [{ property: 'receivedAt', isAscending: true }],
        limit: PAGE,
        position,
        calculateTotal: true,
      })
      if (result.ids.length === 0) break
      ids.push(...result.ids)
      position += result.ids.length
      if (result.total !== undefined ? ids.length >= result.total : result.ids.length < PAGE) break
    }
    return ids
  }

  /**
   * Enqueue chunked `destroyEmails` intents — one durable outbox row per `maxObjectsInSet`-sized
   * batch, so a large purge survives a reload and resumes. NEVER passes `ifInState`: a bulk destroy
   * must not fail the whole batch on an unrelated concurrent change (and the auto-chunker cannot
   * split a state-guarded set anyway). The N dispatches coalesce into ONE replay pass.
   */
  private async destroyMatching(filter: EmailFilter): Promise<{ scheduled: number }> {
    const ids = await this.collectMatchingIds(filter)
    const cap = this.cleanupChunkSize
    let scheduled = 0
    for (let start = 0; start < ids.length; start += cap) {
      const chunk = ids.slice(start, start + cap)
      await this.dispatch({ kind: 'destroyEmails', emailIds: chunk }, { id: crypto.randomUUID() })
      scheduled += chunk.length
    }
    return { scheduled }
  }

  /** Like {@link destroyMatching} but MOVES each batch from `from` to `to` (recoverable cleanup). */
  private async moveMatching(
    filter: EmailFilter,
    from: Id,
    to: Id,
  ): Promise<{ scheduled: number }> {
    const ids = await this.collectMatchingIds(filter)
    const cap = this.cleanupChunkSize
    let scheduled = 0
    for (let start = 0; start < ids.length; start += cap) {
      const chunk = ids.slice(start, start + cap)
      await this.dispatch({ kind: 'move', emailIds: chunk, from, to }, { id: crypto.randomUUID() })
      scheduled += chunk.length
    }
    return { scheduled }
  }

  // ------------------------------------------------------------------------------------------

  private async onLeadership(isLeader: boolean): Promise<void> {
    this.isLeader = isLeader
    this.patch({ isLeader })
    if (!isLeader || this.stopController.signal.aborted) return
    // Re-arm M3.6's storm guard for THIS leadership session: the next successful pass is the catch-up
    // and stays silent, and nothing older than this instant may ever notify.
    this.notifyArmed = false
    this.notifySinceMs = this.clock.now()
    // Started, NOT awaited. `onLeadership` must not yield before `sync()` has marked itself busy —
    // everything from the lock grant to that point runs in one task, and callers observe a freshly
    // elected leader as already syncing. The floor is only consulted by the notifier, which cannot run
    // before the second pass (the first is the silent catch-up), so it has all the time it needs.
    this.notifyFloorReady = this.anchorNotifyFloor()
    this.openPush()
    this.scheduleSafetySweep()
    await this.sync()
  }

  /**
   * Clamp M3.6's notification floor onto the SERVER's timeline (defect found in review).
   *
   * The floor is stamped from the CLIENT's clock, but every `receivedAt` it is compared against comes
   * from the SERVER's. A client running Δ ahead — a dead RTC battery, no NTP, a VM with a drifted host
   * clock — puts the floor Δ into the server's future, and then *every* arrival fails the "strictly
   * newer" test for the next Δ. Notifications simply stop: no error, no status, no diagnostic. Hours
   * ahead means hours of silence.
   *
   * The replica already holds the answer. The newest `receivedAt` we have synced is a timestamp in the
   * server's own units, so clamping the floor down to it re-anchors us onto the right timeline. Mail
   * genuinely newer than everything we hold still clears it, which is the only property the floor
   * needs. A read failure (or an empty replica) leaves the synchronous stamp in place — degraded, not
   * broken.
   */
  private async anchorNotifyFloor(): Promise<void> {
    try {
      const newest = await newestReceivedAt(this.db, this.accountId)
      if (newest !== null) this.notifySinceMs = Math.min(this.notifySinceMs, newest)
    } catch {
      /* the client-clock stamp stands; a floor is not worth failing a leadership hand-over over */
    }
  }

  private openPush(): void {
    const push = this.deps.createPush(this.deps.session, {
      auth: this.deps.auth,
      dataTypes: [...WATCHED_TYPES],
      transports: BROWSER_PUSH_TRANSPORTS,
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

  /**
   * A `Retry-After` the server actually sent, in ms — the only number here that is not a guess.
   * Mirrors what `conflict.ts` reads for the write path, across both classes that carry it
   * (`JmapProblemError` is NOT a subclass of `JmapHttpError`, so one check cannot span both).
   */
  private static retryAfterOf(error: unknown): number | undefined {
    if (error instanceof JmapProblemError || error instanceof JmapHttpError) {
      return error.retryAfterMs === undefined ? undefined : clampRetryAfter(error.retryAfterMs)
    }
    return undefined
  }

  /**
   * Retry a FAILED pass before the safety sweep would (B47).
   *
   * Cancels any pending retry first: passes coalesce, so two failures must not leave two timers
   * racing to start the same sync. A server-supplied `Retry-After` wins over the curve — it is the
   * server saying when it will answer, and guessing earlier is how a throttled client stays
   * throttled.
   */
  private scheduleSyncRetry(error: unknown): void {
    this.cancelSyncRetry()
    if (this.stopController.signal.aborted || !this.isLeader) return
    this.syncFailures += 1
    const hinted = SyncEngine.retryAfterOf(error)
    const delay = hinted ?? backoffDelayMs(this.syncFailures, Math.random(), SYNC_RETRY_BACKOFF)
    this.syncRetryTimer = this.clock.setTimeout(() => {
      this.syncRetryTimer = undefined
      if (this.isLeader) void this.sync()
    }, delay)
  }

  private cancelSyncRetry(): void {
    if (this.syncRetryTimer === undefined) return
    this.clock.clearTimeout(this.syncRetryTimer)
    this.syncRetryTimer = undefined
  }

  /** A pass got through: drop the backoff so the next failure starts from the short end again. */
  private noteSyncSuccess(): void {
    this.syncFailures = 0
    this.cancelSyncRetry()
  }

  private scheduleSafetySweep(): void {
    if (this.stopController.signal.aborted) return
    const interval = this.deps.safetyIntervalMs ?? DEFAULT_SAFETY_INTERVAL_MS
    this.safetyTimer = this.clock.setTimeout(() => {
      if (this.isLeader) void this.sync()
      this.scheduleSafetySweep()
    }, interval)
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer === undefined) return
    this.clock.clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
  }

  /** Collapse an `online` burst (a flapping line) into ONE sync pass once it has settled. */
  private scheduleReconnect(): void {
    this.cancelReconnect()
    if (this.stopController.signal.aborted) return
    this.reconnectTimer = this.clock.setTimeout(() => {
      this.reconnectTimer = undefined
      if (this.isLeader) void this.sync()
    }, RECONNECT_DEBOUNCE_MS)
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

  /**
   * A REPLAY-ONLY pass (no delta round-trip). Dispatching an action, a follower's wake and the
   * grace/backoff timer all take this path: flushing a LOCAL queue does not need two full delta
   * round-trips, and an M3.2 cleanup that enqueues N chunk intents in a loop collapses to ONE pass.
   *
   * NOTE (deliberate non-goal): intents are NOT coalesced with each other. Merging two `setKeywords`
   * over overlapping id sets is only safe under last-writer-wins over IDENTICAL id sets; the general
   * case reorders user intent. The coalescing that matters (drafts, via the stable `draft:<id>`
   * outbox id) already happens at enqueue time.
   */
  requestReplay(): void {
    if (!this.isLeader || this.stopController.signal.aborted) return
    void this.runReplayCoalesced()
  }

  /** The shared guard: a full sync and an on-demand replay can never run the queue concurrently. */
  private async runReplayCoalesced(): Promise<void> {
    if (this.replaying) {
      this.replayQueued = true
      return
    }
    const pass = this.runReplay().catch((error: unknown) => this.reportError(error))
    this.replaying = pass
    await pass
    this.replaying = undefined
    if (this.replayQueued && this.isLeader && !this.stopController.signal.aborted) {
      this.replayQueued = false
      await this.runReplayCoalesced()
    }
  }

  private async runReplay(): Promise<void> {
    // Offline: skip the pass entirely. (The transport-error path still covers a lying
    // `navigator.onLine` / a captive portal — it is a backoff, never a rollback.)
    const online = this.deps.isOnline()
    if (online) {
      await replayOutbox(this.port, this.db, this.accountId, {
        now: this.clock.now(),
        random: this.random,
        online: true,
        refreshState: async (type) => {
          if (type === 'Mailbox') {
            const writes = await syncMailboxes(this.port, this.db, this.accountId, this.clock)
            // Same hazard as in `runSyncPass` (gap B7): this refresh writes the server's ABSOLUTE
            // counts mid-replay, over mailboxes that unsent intents have already patched.
            await reapplyPendingCounts(this.db, this.accountId, writes)
          } else if (type === 'ContactCard') {
            // A guarded contact update/delete lost the `stateMismatch` race: re-pull the ContactCard
            // delta so the re-execute carries the fresh state (M4.2). No badge hazard — cards move no
            // `Mailbox` counts.
            await syncContactCards(this.port, this.db, this.accountId, this.clock)
          } else {
            // AddressBook: no guarded book intent ships this stage (update/delete are 5b), but keep the
            // refresh total so the seam is honest if one is added later.
            await syncAddressBooks(this.port, this.db, this.accountId, this.clock)
          }
          return getSyncState(this.db, this.accountId, type)
        },
      })
      // Re-query the windows the optimistic apply VOIDED — and only those.
      //
      // This path deliberately skips the delta round-trip, so nothing else here reconciles. For a
      // DEPARTURE that is fine: `updateWindows` already pruned the ids, so the list is right locally
      // and offline. For an ARRIVAL it is not — a window is in the SERVER's collation, so the apply
      // always voids the baseline (M3.10 also SPLICES the row in where that is locally provable, but
      // the index is its guess, not the server's answer), leaving the placement unconfirmed until
      // someone re-queries. Nobody did: the correction rode on the server's push echo, and until the
      // push channel connects (the first ~second after a boot) on the 60 s sweep. Undo an archive in
      // that gap and the button looks dead for a minute while the server has long since put the mail
      // back — reproduced live, 3/3, against the fixture (M3.9).
      //
      // Scoped to voided windows so an M3.2 bulk cleanup still costs ONE re-query rather than one per
      // chunk: its N intents void the same window once, and a window with a live baseline is skipped.
      //
      // ONLY once the queue is empty, and that guard is not belt-and-braces — without it this fix
      // creates a worse bug than the one it fixes. A re-query answers with the SERVER's list, which
      // by definition cannot reflect an intent we have not sent yet. Archive, then trash a second
      // message a moment later: the trash's optimistic prune voids the window while this pass is
      // still mid-flight, so the pass re-queries, gets a list that still contains the trashed
      // message, refills the window with it AND restores `queryState` — whereupon the next pass,
      // the one that actually sends the trash, skips the window as "not voided" and the row stays
      // on screen for good. Caught by the M3.8 keyboard E2E (`j o e u x #`), which is exactly that
      // sequence at human speed. A queued row means the next pass reconciles instead.
      if ((await pendingOutbox(this.db, this.accountId)).length === 0) {
        await this.reconcileWatched(false, true)
      }
    }
    await this.scheduleQueueWake()
    await this.refreshQueueCounts()
  }

  /**
   * A `Foo/changes` state the server can no longer resolve (RFC 8620 §5.2 `cannotCalculateChanges`).
   *
   * It happens when a server is restored from a backup, resets, or is replaced — the client's cached
   * `sinceState` names a point in a history the server no longer has. The QUERY path already recovers
   * (`delta.ts#reconcileQuery` → `fullRequery`); the TYPE-changes path (`syncMailboxes`/`syncEmails`/
   * `syncThreads`, all through `drainChanges`) did NOT, so a single such error stranded the whole app
   * on a red "sync problem" that a reload could not clear — the bad state is persisted in IndexedDB.
   *
   * The recovery is a full resync WITHOUT touching user data: reset the three watched-type states to
   * null so `syncMailboxes` re-pulls every folder and `fullRequery` re-seeds the Email state, and
   * force the query windows to re-materialise rather than delta against a query state the server
   * likewise no longer knows. The full-pull paths call `Foo/get`/`Foo/query`, never `Foo/changes`, so
   * this cannot itself raise `cannotCalculateChanges` — there is no loop to guard against.
   */
  private async resetWatchedStates(): Promise<void> {
    const now = this.clock.now()
    for (const type of WATCHED_TYPES) {
      await setSyncState(this.db, this.accountId, type, null, now)
    }
  }

  private async runSyncPass(forceFull: boolean): Promise<void> {
    try {
      let deltaError: unknown
      let created: EmailEnvelopeInput[] = []
      let recoveredFull = forceFull
      try {
        try {
          created = await this.runDeltaBlock(recoveredFull)
        } catch (error) {
          if (!(error instanceof CannotCalculateChangesError)) throw error
          // The server cannot calculate the delta from our state. Drop the states and re-run the
          // whole block as a full resync — once. A second failure is not a state problem and is
          // surfaced like any other.
          await this.resetWatchedStates()
          recoveredFull = true
          created = await this.runDeltaBlock(true)
        }
      } catch (error) {
        if (isAuthExpiry(error)) throw error
        deltaError = error
      }
      await this.runReplayCoalesced()
      if (deltaError !== undefined) {
        // Offline is not a failure to back off from — the online transition schedules its own pass,
        // and counting it would push the first retry after reconnect out to the far end of the curve.
        if (this.deps.isOnline()) this.scheduleSyncRetry(deltaError)
        this.patch({
          phase: this.deps.isOnline() ? 'error' : 'offline',
          error: errorMessage(deltaError),
        })
        return
      }
      await this.raiseNewMailNotifications(created)
      await this.runMaintenance()
      this.noteSyncSuccess()
      this.patch({ phase: 'idle', lastSyncedAt: this.clock.now(), error: null })
    } catch (error) {
      this.reportError(error)
    }
  }

  /** The delta half of a sync pass, factored out so the `cannotCalculateChanges` recovery can re-run it. */
  private async runDeltaBlock(forceFull: boolean): Promise<EmailEnvelopeInput[]> {
    const mailboxWrites = await syncMailboxes(this.port, this.db, this.accountId, this.clock)
    // The folder badges an unsent intent has already moved (M3.10, gap B7). `syncMailboxes`
    // writes the server's ABSOLUTE count, and it runs BEFORE the replay in `runSyncPass` — so a
    // mailbox the server reports as changed for an UNRELATED reason (new mail in the Inbox, another
    // client) silently reverts the optimistic badge to the pre-mutation number, and it stays
    // reverted until the intent lands. Re-applying is scoped to the count fields this pass actually
    // wrote and to intents that have provably NEVER BEEN DISPATCHED — which is NOT the same as
    // `status === 'pending'`, since several paths return an already-dispatched row to `pending`.
    // See {@link reapplyPendingCounts} and `unsentOutbox`.
    await reapplyPendingCounts(this.db, this.accountId, mailboxWrites)
    if (!this.identitiesSynced) {
      await syncIdentities(this.port, this.db, this.accountId, this.clock)
      this.identitiesSynced = true // only after success, so an offline first pass retries
    }
    await this.ensureInboxWindow()
    await syncThreads(this.port, this.db, this.accountId, this.clock)
    const created = await syncEmails(this.port, this.db, this.accountId, this.clock)
    await this.reconcileWatched(forceFull)
    // Contacts (M4.2): the address-book tree (pulled whole) + the ContactCard delta + the watched
    // contact query windows. Independent of mail; the same `forceFull` SP.4 re-probe applies.
    await syncAddressBooks(this.port, this.db, this.accountId, this.clock)
    await syncContactCards(this.port, this.db, this.accountId, this.clock)
    await this.reconcileWatchedContacts(forceFull)
    return created
  }

  /**
   * The engine-session guard around M3.6's notifier. Four conditions, and every one of them is a bug
   * someone would otherwise ship:
   *
   *  - **Armed.** The first successful pass of a leadership session is the catch-up and stays silent
   *    (see {@link notifyArmed}). A FAILED pass does not arm it — otherwise an offline first pass
   *    would spend the exemption on nothing and the real catch-up would then buzz.
   *  - **Still the leader.** `runSyncPass` awaits half a dozen round-trips, and a sign-out or a
   *    hand-over can flip `isLeader` under it. Without this re-check the departing tab notifies while
   *    the incoming leader is silently catching up — a banner nobody is left to explain.
   *  - **No tab in the foreground.** No banner for a message the user is watching land — in ANY tab,
   *    not just this one (see {@link isAppInForeground}).
   *  - **Never fatal.** A notification is a courtesy; a sync pass is not. It is caught (the
   *    `recordAddressStats` precedent in delta.ts).
   */
  private async raiseNewMailNotifications(created: EmailEnvelopeInput[]): Promise<void> {
    const wasArmed = this.notifyArmed
    this.notifyArmed = true
    if (!wasArmed) return
    if (created.length === 0) return
    if (!this.isLeader || this.stopController.signal.aborted) return
    const notify = this.deps.notify
    if (notify === undefined) return
    if (await this.isAppInForeground()) return
    await this.notifyFloorReady // the clamp was started at leadership; this is where it is first needed
    try {
      await notify(created, { now: this.clock.now(), sinceMs: this.notifySinceMs })
    } catch {
      /* non-critical — a failed banner must never fail the pass that produced it */
    }
  }

  /**
   * Is the user looking at ANY tab of this app — not merely at this one?
   *
   * Leadership is per-ORIGIN and sticky: the first tab to take the Web Lock keeps it, so the leader is
   * usually the tab opened FIRST. Open a second tab and work there, and the leader is a hidden tab
   * that would happily banner mail the user is watching arrive in the tab in front of them. That is
   * not an exotic configuration; it is the normal one.
   *
   * So the leader asks. Any tab that is itself visible and focused answers; a tab that is neither, or
   * that has crashed, says nothing — and silence is the "no". A query beats a heartbeat here: there is
   * no TTL to tune, no liveness table, and nothing that can go stale. The cost is bounded by
   * {@link FOREGROUND_ACK_MS} and paid only on a pass that actually has mail to announce.
   */
  private async isAppInForeground(): Promise<boolean> {
    if (this.deps.isForeground?.() === true) return true
    const bus = this.bus
    if (bus === undefined) return false

    return await new Promise<boolean>((resolve) => {
      // The REAL timer, deliberately, not `this.clock`: the injected clock exists to keep the safety
      // sweep and the outbox backoff out of tests' wall-clock, and its `setTimeout` is a no-op stub.
      // This deadline has to actually fire, or a leader with no other tabs would wait for an answer
      // that is never coming and wedge the sync pass.
      const deadline = this.deps.foregroundAckMs ?? FOREGROUND_ACK_MS
      const timer = setTimeout(() => this.settleForeground?.(false), deadline)
      this.settleForeground = (foreground) => {
        this.settleForeground = undefined
        clearTimeout(timer)
        resolve(foreground)
      }
      bus.postForegroundQuery()
    })
  }

  /** A background 401/403 means the session expired — route it to re-auth (FR-AUTH-06). */
  private reportError(error: unknown): void {
    if (isAuthExpiry(error) && this.deps.onAuthExpired) {
      this.deps.onAuthExpired()
      this.patch({ phase: 'idle', error: null })
      return
    }
    // Same split as the delta branch: back off only when we are online and therefore actually
    // retrying. Re-auth returned above — a retry loop against an expired session is not a fix.
    if (this.deps.isOnline()) this.scheduleSyncRetry(error)
    this.patch({ phase: this.deps.isOnline() ? 'error' : 'offline', error: errorMessage(error) })
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

  /**
   * @param onlyVoided Reconcile ONLY windows whose baseline an optimistic apply threw away
   *   (`queryState === null`). See {@link runReplay} for why the replay path needs that.
   */
  private async reconcileWatched(forceFull: boolean, onlyVoided = false): Promise<void> {
    for (const key of this.watched) {
      const row = await getQueryCache(this.db, this.accountId, key)
      if (!row) continue
      if (onlyVoided && row.queryState !== null) continue
      const spec = { filter: row.filter, sort: row.sort, collapseThreads: row.collapseThreads }
      try {
        await reconcileQuery(this.port, this.db, this.accountId, key, spec, this.clock, forceFull)
        // Re-check the queue AFTER the round-trips, not just before them.
        //
        // `runReplay`'s `pendingOutbox` guard is a CHECK-THEN-ACT: it samples an empty queue and then
        // spends two network round-trips here re-querying. An intent dispatched inside that window —
        // `#` a moment after `e`, which is human triage speed — voids this window and queues, but the
        // in-flight answer below it is already stale: it was computed from a server list that predates
        // the trash. Writing it back restores `queryState` to non-null, and the very next pass, the one
        // that finally sends the trash, then SKIPS this window at the `onlyVoided` test above. The row
        // stays on screen until the 60 s safety sweep — four times the E2E's timeout, and forever as
        // far as the reader is concerned. Fixing only the pre-check made the race narrower, not gone
        // (still 2/30 live); the guard has to bracket the round-trips, not precede them.
        //
        // Re-void rather than write: the next pass re-queries with the trash already sent, so the
        // window converges. The cost of a false positive is one extra query, which is the cheap side
        // of this trade.
        if (onlyVoided && (await pendingOutbox(this.db, this.accountId)).length > 0) {
          await this.db.queryCache.update([this.accountId, key], { queryState: null })
        }
      } catch (error) {
        // Isolate per key: one watched query's failure must not fail the whole sync pass — that
        // would starve the keys after it. A server-rejected search filter (e.g. free-text on an
        // FTS-less server) would otherwise re-throw on every sweep. Re-throw ONLY auth-expiry so the
        // pass can still route to re-auth (FR-AUTH-06); swallow the rest (it self-heals next sweep).
        if (isAuthExpiry(error)) throw error
      }
    }
  }

  /**
   * Keep the watched CONTACT query windows fresh (M4.2) — the contacts analogue of
   * {@link reconcileWatched}. No `onlyVoided` path: there is no contact outbox in this stage, so no
   * window is ever locally voided. Per-key isolation + auth-expiry re-throw as on the mail side.
   */
  private async reconcileWatchedContacts(forceFull: boolean): Promise<void> {
    for (const key of this.watchedContacts) {
      const row = await getContactQueryCache(this.db, this.accountId, key)
      if (!row) continue
      const spec: ContactQuerySpecInput = { filter: row.filter, sort: row.sort }
      try {
        await reconcileContactQuery(
          this.port,
          this.db,
          this.accountId,
          key,
          spec,
          this.clock,
          forceFull,
        )
      } catch (error) {
        if (isAuthExpiry(error)) throw error
      }
    }
  }

  /** The three queue counts the chrome renders: live queue, dead letters, and stuck-but-retrying. */
  private async refreshQueueCounts(): Promise<void> {
    const live = await pendingOutbox(this.db, this.accountId)
    const failed = await failedOutbox(this.db, this.accountId)
    const stuck = live.filter(
      (row) => row.status === 'pending' && row.attempts >= STUCK_AFTER_ATTEMPTS,
    ).length
    this.patch({
      pendingActions: live.length,
      failedActions: failed.length,
      stuckActions: stuck,
    })
  }

  private patch(partial: Partial<EngineStatus>): void {
    // No status writes after teardown — a sync pass finishing during/after stop() must not clobber
    // the reset status (stop() owns the final write directly).
    if (this.stopController.signal.aborted) return
    this.setStatus({ ...this.status, ...partial }, this.isLeader)
  }

  private setStatus(next: EngineStatus, broadcast: boolean): void {
    this.status = next
    this.publishStatus(next)
    if (broadcast) this.bus?.postStatus(next)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** `AND(inMailbox, before)` — the "older than" cleanup filter (M3.2). */
function olderFilter(mailboxId: Id, beforeIso: string): EmailFilter {
  return { operator: 'AND', conditions: [{ inMailbox: mailboxId }, { before: beforeIso }] }
}

// ---------------------------------------------------------------------------------------------
// The running engines of this tab (M4.4 Etappe 4).
//
// WHY A KEYED MAP, NOT A SECOND POINTER. The sidebar renders one `FolderTree` per account AT ONCE
// (`mail/AccountTrees.tsx`), each under its own `ReplicaProvider` — a shared account's tree the user
// is not currently "in" is still on screen and still clickable (rename, delete, empty-folder). So
// "which engine is active?" is not a well-formed question: at any instant there are N right answers.
// The engine a call uses is the one whose account matches the `useReplica().accountId` of the
// SUBTREE the call is made in, which is what `getEngineFor` resolves.
//
// WHAT `getActiveEngine()` MEANS NOW: the PRIMARY engine, i.e. the user's own account. Three callers
// are entitled to it and no others should reach for the familiar name — `settings/StorageSection`
// (device-level maintenance), the `accountId === null` degrade below (a component rendered with no
// ReplicaProvider, which happens in component tests only), and the empty-registry fallback.
//
// WHY THE FALLBACK IS KEYED ON *EMPTY* AND NEVER ON A *MISS*. An empty registry means no fleet has
// published yet: the pre-M4.4 world, and the many component tests that call `setActiveEngine(fake)`
// with no account attached — answer with the primary and the single-account path stays byte-for-byte
// what it was. A MISS on a POPULATED registry means something else entirely: this account has no
// running engine (a share revoked mid-session, a teardown window). Then the answer is `null`, never a
// substitute, because JMAP mailbox ids are per-account and SHORT (`a`, `b`, …) — the primary almost
// always holds a real but DIFFERENT mailbox under the id the caller meant. Answering a miss with the
// primary IS the corruption this stage closes: changing that line back to `?? activeEngine` silently
// reopens it.
//
// Observable, and through the ONE listener set both mutators notify: React consumers (the message
// list's watch) must re-render the moment an engine appears, rather than racing the SyncEngineHost
// effect that publishes it — a null read would leave a watch unregistered and the window stuck.
// ---------------------------------------------------------------------------------------------

let activeEngine: SyncEngine | null = null
const engines = new Map<Id, SyncEngine>()
const activeEngineListeners = new Set<() => void>()

function notifyEngineListeners(): void {
  for (const listener of activeEngineListeners) listener()
}

/** Publish/clear the PRIMARY handle — the account-global consumers named in the block above. */
export function setActiveEngine(engine: SyncEngine | null): void {
  activeEngine = engine
  notifyEngineListeners()
}
/** The PRIMARY account's engine. For an acting subtree use {@link getEngineFor} instead. */
export function getActiveEngine(): SyncEngine | null {
  return activeEngine
}
/** Publish (or, with `null`, withdraw) the engine serving `accountId` — every account, primary too. */
export function setEngineFor(accountId: Id, engine: SyncEngine | null): void {
  if (engine === null) engines.delete(accountId)
  else engines.set(accountId, engine)
  notifyEngineListeners()
}
/** The engine serving `accountId` — see the resolution rule in the block above. */
export function getEngineFor(accountId: Id | null): SyncEngine | null {
  if (accountId === null) return activeEngine
  const owned = engines.get(accountId)
  if (owned !== undefined) return owned
  return engines.size === 0 ? activeEngine : null
}
/** Every engine this tab runs, primary first (Map order = fleet order). */
export function getRunningEngines(): readonly SyncEngine[] {
  if (engines.size > 0) return [...engines.values()]
  return activeEngine === null ? [] : [activeEngine]
}
/** Drop every handle without stopping anything — the withdraw half of {@link stopAllEngines}. */
export function clearEngines(): void {
  engines.clear()
  activeEngine = null
  notifyEngineListeners()
}
/**
 * Stop every running engine, handles withdrawn FIRST.
 *
 * `wipeReplica` deletes the IndexedDB database, which blocks on any open handle — and since M4.4
 * every shared account's engine holds one too. `SyncEngineHost`'s effect cleanup cannot run before
 * the sign-out path awaits the wipe in the same tick, so stopping only the primary left the wipe
 * hanging on still-writing shared engines. Withdrawing before stopping also closes the window in
 * which a click could still enqueue onto an engine that is releasing its lock. `stop()` is
 * re-entrant-safe, so the fleet's own later teardown calling it again is harmless.
 */
export async function stopAllEngines(): Promise<void> {
  const running = getRunningEngines()
  clearEngines()
  await Promise.all(running.map((engine) => engine.stop().catch(() => {})))
}
export function subscribeEngines(listener: () => void): () => void {
  activeEngineListeners.add(listener)
  return () => {
    activeEngineListeners.delete(listener)
  }
}

/** Browser-wired {@link SyncEngine}: real locks, BroadcastChannel, push, and `navigator.onLine`. */
/**
 * Is the user actually looking at THIS tab (M3.6)?
 *
 * `hasFocus()` is load-bearing next to `visibilityState`, and dropping it is the easy mistake: a
 * desktop window sitting BEHIND another application is still `visible` to the Page Visibility API. A
 * check on visibility alone would therefore call a buried window "foreground" and suppress the banner
 * at precisely the moment the banner is the only way the user would ever learn the mail arrived.
 *
 * Exported so it can be tested — `createSyncEngine` itself cannot be constructed under jsdom (no
 * `navigator.locks`), which is how this went untested in the first place.
 */
export function isDocumentForeground(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus()
}

export function createSyncEngine(deps: {
  db: ReplicaDb
  port: JmapPort
  session: Session
  auth: AuthProvider
  config: { cacheDays: number; maxStorageMB: number }
  onAuthExpired?: () => void
  clock?: EngineClock
  safetyIntervalMs?: number
  /** M3.6's notifier. Omitted ⇒ no notifications (an unconnected shell, a test). */
  notify?: NotifyNewMail
  /**
   * Per-account overrides for the multi-account host (M4.4). All default to the historical
   * single-account wiring, so the primary engine (which passes none of them) is byte-for-byte the
   * pre-M4.4 engine:
   *  - `lockName` — the leader lock; omitted ⇒ the bare {@link SYNC_LOCK}.
   *  - `createBus` — the cross-tab channel; omitted ⇒ a real {@link defaultBroadcast}.
   *  - `createPush` — the push channel; omitted ⇒ a fresh {@link createPushChannel} (a shared-account
   *    engine passes a shared-mux handle so N accounts share ONE SSE connection).
   *  - `publishStatus` — the status sink; omitted ⇒ the global badge store.
   */
  lockName?: string
  createBus?: () => BroadcastChannelLike
  createPush?: SyncEngineDeps['createPush']
  publishStatus?: (status: EngineStatus) => void
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
    random: () => Math.random(),
    locks: navigator.locks as unknown as LockManagerLike,
    createBus: deps.createBus ?? (() => defaultBroadcast()),
    createPush: deps.createPush ?? ((session, options) => createPushChannel(session, options)),
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
    isForeground: isDocumentForeground,
    ...(deps.onAuthExpired === undefined ? {} : { onAuthExpired: deps.onAuthExpired }),
    ...(deps.safetyIntervalMs === undefined ? {} : { safetyIntervalMs: deps.safetyIntervalMs }),
    ...(deps.notify === undefined ? {} : { notify: deps.notify }),
    ...(deps.lockName === undefined ? {} : { lockName: deps.lockName }),
    ...(deps.publishStatus === undefined ? {} : { publishStatus: deps.publishStatus }),
  })
}
