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
  type PushChannel,
  type SchedulerLike,
  type SearchSnippet,
  type Session,
} from '@waxwing/jmap'
import {
  collectBodyBlobIds,
  type EmailBodyRow,
  estimateBodyBytes,
  type ReplicaDb,
  scopeKey,
} from '../db'
import { canonicalQueryKey, type QuerySpec } from '../query-key'
import {
  failedOutbox,
  getQueryCache,
  getSyncState,
  mailboxByRole,
  pendingOutbox,
  putEmailBody,
  putEmails,
  putQueryCache,
} from '../repo'
import { browserEstimate, type EstimateFn, isQuotaExceeded, reportStorageFull } from '../storage'
import {
  backfillMailbox,
  backfillQuery,
  loadMore,
  type WindowSpec,
  windowQueryKey,
} from './backfill'
import { STUCK_AFTER_ATTEMPTS } from './backoff'
import { type BroadcastChannelLike, defaultBroadcast, EngineBus } from './bus'
import { isAuthExpiry } from './conflict'
import { reconcileQuery, syncEmails, syncIdentities, syncMailboxes, syncThreads } from './delta'
import { type LockManagerLike, startLeaderElection } from './leader'
import { type MaintenanceResult, runMaintenance, withQuotaRecovery } from './maintenance'
import {
  applyOptimistic,
  applyUndo,
  type EnqueueOptions,
  enqueueAction,
  type OutboxIntent,
  replayOutbox,
  STATE_GUARDED_INTENTS,
} from './outbox'
import { setEngineStatus } from './status'
import { type EngineClock, type EngineStatus, INITIAL_ENGINE_STATUS, type JmapPort } from './types'

/** Data types we ask push to notify on and delta-sync. */
const WATCHED_TYPES = ['Mailbox', 'Thread', 'Email']

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
  /** Jitter source for the outbox retry backoff; defaults to `Math.random` (tests pass `() => 0`). */
  readonly random?: () => number
}

const DEFAULT_SAFETY_INTERVAL_MS = 60_000

export class SyncEngine {
  private readonly db: ReplicaDb
  private readonly port: JmapPort
  private readonly accountId: Id
  private readonly clock: EngineClock
  private readonly random: () => number

  private readonly stopController = new AbortController()
  private bus: EngineBus | undefined
  private push: PushChannel | undefined
  private leaderPromise: Promise<void> | undefined
  private offlineUnsub: (() => void) | undefined
  private busUnsub: (() => void) | undefined
  private safetyTimer: number | undefined
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

  /** Identities are pulled once per leadership session (M2.5; Identity/changes deferred). */
  private identitiesSynced = false
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
    })
  }

  /** Stop syncing, release the lock, close push/bus. Awaitable so sign-out can wipe afterwards. */
  async stop(): Promise<void> {
    if (!this.started) return
    this.stopController.abort()
    if (this.safetyTimer !== undefined) this.clock.clearTimeout(this.safetyTimer)
    if (this.queueWakeTimer !== undefined) this.clock.clearTimeout(this.queueWakeTimer)
    this.cancelReconnect()
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
    setEngineStatus(this.status)
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
      options.ifInState !== undefined ? options.ifInState : await this.mailboxGuard(intent)
    await enqueueAction(this.db, this.accountId, intent, {
      ...options,
      ifInState,
      now: this.clock.now(),
    })
    await this.refreshQueueCounts()
    this.wakeQueue()
  }

  /**
   * The `ifInState` guard for a `Mailbox/set` (M3.3): folder state churns rarely and a concurrent
   * folder mutation by another client is exactly the "gentle notice" case. `Email/set` stays
   * UNGUARDED on purpose — the Email state is account-global and advances on every inbound message,
   * so a guard would turn every offline replay into a bogus conflict (and the auto-chunker cannot
   * split a state-guarded set, which would break every bulk cleanup chunk).
   */
  private async mailboxGuard(intent: OutboxIntent): Promise<string | null> {
    if (!STATE_GUARDED_INTENTS.has(intent.kind)) return null
    return getSyncState(this.db, this.accountId, 'Mailbox')
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
    if (existing !== undefined) {
      await this.db.emailBodies.update([this.accountId, emailId], { lastAccessedAt: now })
      return null
    }
    const { list } = await this.port.getEmailBodies([emailId])
    let unstored: EmailBodyRow | null = null
    for (const body of list) {
      const row = { accountId: this.accountId, ...body, fetchedAt: now, lastAccessedAt: now }
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
          await syncMailboxes(this.port, this.db, this.accountId, this.clock)
          return getSyncState(this.db, this.accountId, type)
        },
      })
    }
    await this.scheduleQueueWake()
    await this.refreshQueueCounts()
  }

  private async runSyncPass(forceFull: boolean): Promise<void> {
    try {
      let deltaError: unknown
      try {
        await syncMailboxes(this.port, this.db, this.accountId, this.clock)
        if (!this.identitiesSynced) {
          await syncIdentities(this.port, this.db, this.accountId, this.clock)
          this.identitiesSynced = true // only after success, so an offline first pass retries
        }
        await this.ensureInboxWindow()
        await syncThreads(this.port, this.db, this.accountId, this.clock)
        await syncEmails(this.port, this.db, this.accountId, this.clock)
        await this.reconcileWatched(forceFull)
      } catch (error) {
        // Re-throw ONLY auth-expiry (→ the re-auth funnel). A transient DELTA failure must not skip
        // the replay below: that would starve the outbox — a queued send would sit unsent for as
        // long as the server kept failing one `Email/changes` call (M3.3).
        if (isAuthExpiry(error)) throw error
        deltaError = error
      }
      await this.runReplayCoalesced()
      if (deltaError !== undefined) {
        this.patch({
          phase: this.deps.isOnline() ? 'error' : 'offline',
          error: errorMessage(deltaError),
        })
        return
      }
      // Cache policy runs at the END of a SUCCESSFUL pass (M3.4): the replica is at its freshest, so
      // the horizon, the orphan set and the watched windows are all accurate. It is interval-gated,
      // so the 60 s safety sweep does not evict every minute.
      await this.runMaintenance()
      this.patch({ phase: 'idle', lastSyncedAt: this.clock.now(), error: null })
    } catch (error) {
      this.reportError(error)
    }
  }

  /** A background 401/403 means the session expired — route it to re-auth (FR-AUTH-06). */
  private reportError(error: unknown): void {
    if (isAuthExpiry(error) && this.deps.onAuthExpired) {
      this.deps.onAuthExpired()
      this.patch({ phase: 'idle', error: null })
      return
    }
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

  private async reconcileWatched(forceFull: boolean): Promise<void> {
    for (const key of this.watched) {
      const row = await getQueryCache(this.db, this.accountId, key)
      if (!row) continue
      const spec = { filter: row.filter, sort: row.sort, collapseThreads: row.collapseThreads }
      try {
        await reconcileQuery(this.port, this.db, this.accountId, key, spec, this.clock, forceFull)
      } catch (error) {
        // Isolate per key: one watched query's failure must not fail the whole sync pass — that
        // would starve the keys after it. A server-rejected search filter (e.g. free-text on an
        // FTS-less server) would otherwise re-throw on every sweep. Re-throw ONLY auth-expiry so the
        // pass can still route to re-auth (FR-AUTH-06); swallow the rest (it self-heals next sweep).
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
    setEngineStatus(next)
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
  config: { cacheDays: number; maxStorageMB: number }
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
    random: () => Math.random(),
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
