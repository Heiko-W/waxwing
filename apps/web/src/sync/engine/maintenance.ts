/**
 * The maintenance pass (M3.4, FR-OFF-02/FR-OFF-04) — the I/O half of cache policy: gather → plan
 * (pure, {@link planEviction}) → apply in chunked `rw` transactions.
 *
 * ## What it may NEVER touch
 * `outbox` and `drafts` are not a cache — they are the user's unsent work — so no stage of this pass
 * may delete a row from either. That is enforced BY CONSTRUCTION: the maintenance transactions do not
 * name those tables, so a bug in the planner cannot reach them. Everything they REFERENCE (the emails
 * of a queued intent, a draft's attachment blobs, a reply's source message) is collected into the
 * protected sets before anything is planned — a queued send whose attachment blob was evicted would
 * ship a broken message.
 *
 * ## Order is load-bearing
 *  1. Reap stale `queryCache` windows — an unwatched, day-old search window must stop pinning its
 *     envelopes BEFORE the prune runs, or nothing below the horizon is ever prunable.
 *  2. Evict bytes (orphans → blobs → bodies) to the low watermark.
 *  3. Prune envelopes below the `cacheDays` + grace horizon that NOTHING still references — where
 *     "references" includes every id in a SURVIVING window (so an open search/label view can never
 *     lose rows out from under it) and every body that just survived stage 2.
 *  4. Prune threads whose members are all gone.
 *  5. Top up the pinned folders (bounded, and it stops at the low watermark).
 *
 * It NEVER throws: a failing chunk stops that stage and is retried next pass, so a pass interrupted by
 * a quota abort still commits the bytes it already freed.
 */

import type { Id } from '@waxwing/jmap'
import type { CacheUsage } from '../cache-usage'
import { collectCacheUsage } from '../cache-usage'
import {
  type DraftRow,
  ENVELOPE_BYTES_ESTIMATE,
  type OutboxRow,
  type QueryCacheRow,
  type ReplicaDb,
} from '../db'
import {
  allEmailIds,
  blobCacheEntries,
  blobOwners,
  bodyCacheEntries,
  type CacheItem,
  deleteBlobs,
  deleteEmailBodies,
  deleteQueryCacheRows,
  emailIdsInMailbox,
  envelopeIdsBefore,
  pinnedMailboxes,
  queryCacheRows,
} from '../repo'
import { type EstimateFn, isQuotaExceeded } from '../storage'
import {
  chooseBudget,
  classifyBlobOrphans,
  type EvictionPlan,
  LOW_WATERMARK,
  PRESSURE_RATIO,
  PRUNE_GRACE_MS,
  planEnvelopePrune,
  planEviction,
  planWindowReap,
} from './eviction'
import type { OutboxIntent } from './outbox'

const DAY_MS = 86_400_000

/** Primary keys deleted per `rw` transaction — a quota abort mid-pass then loses at most one chunk. */
export const EVICT_CHUNK = 200

/** Bodies prefetched into a pinned folder per pass. Bounded and resumable: the next pass continues. */
export const PIN_PREFETCH_PER_PASS = 100

export interface MaintenanceDeps {
  readonly db: ReplicaDb
  readonly accountId: Id
  readonly config: { readonly cacheDays: number; readonly maxStorageMB: number }
  readonly estimate: EstimateFn
  readonly now: number
  /** The query keys some tab is actively rendering — never reaped, however old. */
  readonly watchedKeys: ReadonlySet<string>
  /**
   * The message whose body was fetched most recently — i.e. the one the reader is almost certainly
   * looking at. Never evicted out from under them. (It is also the MRU entry, so the LRU order would
   * spare it anyway; this makes the guarantee explicit rather than incidental.)
   */
  readonly lastBodyFetchId: Id | null
  /** Extra bytes the caller needs free right now (the QuotaExceededError recovery path). */
  readonly needBytes?: number
  /** Aborted on `stop()` — the prefetch checks it between fetches so sign-out never waits on the net. */
  readonly signal?: AbortSignal
  /**
   * Fetches one message body into the replica — the pinned-folder prefetch. Omitted ⇒ no prefetch
   * (a follower, or an offline pass): topping a pin up is the ONE stage that talks to the server.
   */
  readonly fetchBody?: (emailId: Id) => Promise<unknown>
}

export interface MaintenanceResult {
  readonly evicted: EvictionPlan
  /** Bytes ACTUALLY reclaimed — deleted bodies + blobs + pruned envelopes. What the UI may report. */
  readonly freedBytes: number
  readonly prunedEnvelopes: number
  readonly reapedWindows: number
  readonly prefetchedBodies: number
  readonly usage: CacheUsage
}

/** Everything a pass must not delete, and the garbage it must. */
interface Guards {
  readonly protectedEmailIds: Set<Id>
  readonly protectedBlobIds: Set<Id>
  readonly orphanBodyIds: Set<Id>
  readonly orphanBlobIds: Set<Id>
}

/** The blobIds an outbox intent still needs (a queued send must not ship a missing attachment). */
function intentBlobIds(intent: OutboxIntent): Id[] {
  if (intent.kind !== 'saveDraft' && intent.kind !== 'sendEmail') return []
  const parts = intent.email.attachments ?? []
  return parts.flatMap((part) => (typeof part.blobId === 'string' ? [part.blobId] : []))
}

/** The email ids an outbox intent still needs — including an `error` row's, whose undo may re-fetch them. */
function intentEmailIds(intent: OutboxIntent): Id[] {
  switch (intent.kind) {
    case 'setKeywords':
    case 'move':
    case 'destroyEmails':
      return [...intent.emailIds]
    case 'saveDraft':
      return intent.priorServerId === null ? [] : [intent.priorServerId]
    case 'discardDraft':
      return [intent.serverEmailId]
    case 'sendEmail':
      return [
        ...(intent.priorServerId === null ? [] : [intent.priorServerId]),
        ...(intent.source === null ? [] : [intent.source.emailId]),
      ]
    default:
      return []
  }
}

function draftIds(row: DraftRow): { emails: Id[]; blobs: Id[] } {
  const emails: Id[] = []
  if (row.serverEmailId !== null) emails.push(row.serverEmailId)
  if (row.content.sourceEmailId !== null) emails.push(row.content.sourceEmailId)
  return { emails, blobs: row.content.attachments.map((attachment) => attachment.blobId) }
}

/**
 * Collect the protected sets and the orphans. Reads `outbox`/`drafts` — but only ever READS them: the
 * pass that follows names neither table in any of its write transactions.
 */
async function collectGuards(
  deps: MaintenanceDeps,
  bodies: readonly CacheItem[],
  blobs: readonly CacheItem[],
  pinned: readonly Id[],
): Promise<Guards> {
  const { db, accountId } = deps
  const protectedEmailIds = new Set<Id>()
  const protectedBlobIds = new Set<Id>()

  if (deps.lastBodyFetchId !== null) protectedEmailIds.add(deps.lastBodyFetchId)

  const outbox: OutboxRow[] = await db.outbox.where('accountId').equals(accountId).toArray()
  for (const row of outbox) {
    const intent = row.payload as OutboxIntent
    for (const id of intentEmailIds(intent)) protectedEmailIds.add(id)
    for (const id of intentBlobIds(intent)) protectedBlobIds.add(id)
  }

  const drafts: DraftRow[] = await db.drafts.where('accountId').equals(accountId).toArray()
  for (const row of drafts) {
    const ids = draftIds(row)
    for (const id of ids.emails) protectedEmailIds.add(id)
    for (const id of ids.blobs) protectedBlobIds.add(id)
  }

  for (const mailboxId of pinned) {
    for (const id of await emailIdsInMailbox(db, accountId, mailboxId)) protectedEmailIds.add(id)
  }

  // Orphans: a cached body/blob whose owning envelope no longer exists. `deleteEmails` now cascades to
  // bodies, so a body orphan only arises from an older replica (or a crash between the two deletes) —
  // but blobs are never addressed by email id, so this owner map is the ONLY way to collect theirs.
  const live = new Set(await allEmailIds(db, accountId))
  const orphanBodyIds = new Set<Id>()
  for (const body of bodies) {
    if (!live.has(body.id)) orphanBodyIds.add(body.id)
  }

  // The blob rule is PURE and lives in `eviction.ts` — it is the one most easily got wrong, and it
  // must be provable without a database. See {@link classifyBlobOrphans}.
  const classified = classifyBlobOrphans({
    blobs,
    owners: await blobOwners(db, accountId),
    orphanBodyIds,
    protectedEmailIds,
  })
  for (const id of classified.protectedBlobIds) protectedBlobIds.add(id)

  return {
    protectedEmailIds,
    protectedBlobIds,
    orphanBodyIds,
    orphanBlobIds: classified.orphanBlobIds,
  }
}

/** Apply `remove` in chunks; a failing chunk STOPS this stage (never the pass) and is retried next time. */
async function deleteInChunks<T>(
  ids: readonly T[],
  remove: (chunk: T[]) => Promise<unknown>,
): Promise<number> {
  let done = 0
  for (let start = 0; start < ids.length; start += EVICT_CHUNK) {
    const chunk = ids.slice(start, start + EVICT_CHUNK)
    try {
      await remove([...chunk])
      done += chunk.length
    } catch {
      // A quota abort / a closed database mid-pass: keep what already committed, retry the rest on
      // the next pass. NEVER throw — cache maintenance must not be able to break the app.
      return done
    }
  }
  return done
}

/**
 * Run one maintenance pass. A failing DELETE returns partial results rather than throwing: every stage
 * is independent, and a stage that fails simply leaves its work for the next pass.
 *
 * The GATHER steps are a different matter and this function does NOT swallow them: a
 * `DatabaseClosedError` from a concurrent `wipeReplica()` (sign-out) rejects the pass, and it should —
 * there is nothing sane to return, and the caller in `SyncEngine` is the one that knows a rejected
 * pass during shutdown is expected. Callers therefore MUST handle a rejection; `SyncEngine`
 * `.catch(() => null)`s it.
 */
export async function runMaintenance(deps: MaintenanceDeps): Promise<MaintenanceResult> {
  const { db, accountId, now } = deps

  // ---- 1. Reap stale windows FIRST, so their ids stop counting as "referenced" below. ----
  const windows: QueryCacheRow[] = await queryCacheRows(db, accountId)
  const reapKeys = planWindowReap(windows, deps.watchedKeys, now)
  const reapedWindows = await deleteInChunks(reapKeys, (chunk) =>
    deleteQueryCacheRows(db, accountId, chunk),
  )

  // ---- 2. Evict bytes. ----
  const usageBefore = await collectCacheUsage(db, accountId, deps.estimate)
  const pinned = await pinnedMailboxes(db, accountId)
  const bodies = await bodyCacheEntries(db, accountId)
  const blobs = await blobCacheEntries(db, accountId)
  const guards = await collectGuards(deps, bodies, blobs, pinned)

  const budgetBytes = chooseBudget(deps.config.maxStorageMB, usageBefore.estimate)
  // Under real ORIGIN pressure the browser is about to evict this origin wholesale, so we shrink below
  // our own budget too — but the PLANNER owns how far (a bounded share of the evictable pool), because
  // only it knows which bytes it can actually release.
  const estimate = usageBefore.estimate
  const pressured = estimate !== null && estimate.usage / estimate.quota > PRESSURE_RATIO

  const plan = planEviction({
    budgetBytes,
    bodies,
    blobs,
    orphanBodyIds: guards.orphanBodyIds,
    orphanBlobIds: guards.orphanBlobIds,
    protectedEmailIds: guards.protectedEmailIds,
    protectedBlobIds: guards.protectedBlobIds,
    pressured,
    ...(deps.needBytes === undefined ? {} : { needBytes: deps.needBytes }),
  })
  // The transaction lists `emailBodies` / `blobsMeta` and NOTHING else — `outbox` and `drafts` are
  // structurally out of reach here (see the module header).
  const evictedBodies = await deleteInChunks(plan.bodyIds, (chunk) =>
    deleteEmailBodies(db, accountId, chunk),
  )
  const evictedBlobs = await deleteInChunks(plan.blobIds, (chunk) =>
    deleteBlobs(db, accountId, chunk),
  )
  const survivingBodies = new Set(bodies.map((body) => body.id))
  for (const id of plan.bodyIds.slice(0, evictedBodies)) survivingBodies.delete(id)

  // ---- 3. Prune aged-out envelopes NOTHING still references. ----
  const horizon = new Date(now - deps.config.cacheDays * DAY_MS - PRUNE_GRACE_MS).toISOString()
  const candidateIds = await envelopeIdsBefore(db, accountId, horizon)
  const candidates = new Set(candidateIds)

  // Re-read the windows AFTER the candidates, and drop the ones we reaped above. This ordering is what
  // makes the invariant below hold under a CONCURRENT backfill — and the gap is not theoretical: a
  // search for old mail writes its envelopes, then makes a NETWORK round-trip for their threads, and
  // only then writes its window row. Against the snapshot taken at the top of the pass those envelopes
  // are candidates that no window claims yet.
  //
  // The proof, given that `backfillQuery`/`loadMoreQuery` persist the window row BEFORE the envelopes
  // it lists: an envelope can only be a candidate if it was written before we read the candidates; its
  // window was therefore written before that too; and we read the windows after. So every live window
  // that lists a candidate is in `livePruneWindows`. There is no interleaving that prunes a listed id.
  const reapedKeys = new Set(reapKeys.slice(0, reapedWindows))
  const livePruneWindows = (await queryCacheRows(db, accountId)).filter(
    (row) => !reapedKeys.has(row.key),
  )

  const referencedIds = new Set<Id>(guards.protectedEmailIds)
  for (const id of survivingBodies) referencedIds.add(id)
  for (const window of livePruneWindows) {
    // THE invariant: an id a live window still lists is never pruned, or MessageList renders a
    // skeleton row that no sync can fill.
    for (const id of window.ids) referencedIds.add(id)
  }
  // Everything above the horizon is inside the offline window by definition.
  for (const id of await allEmailIds(db, accountId)) {
    if (!candidates.has(id)) referencedIds.add(id)
  }
  // A THREAD with any surviving message keeps its whole conversation: pruning the older half of a
  // still-live thread would leave the conversation view with holes it can only fill online — which is
  // precisely the situation the offline cache exists to prevent.
  const threads = await db.threads.where('accountId').equals(accountId).toArray()
  for (const thread of threads) {
    if (!thread.emailIds.some((id) => referencedIds.has(id))) continue
    for (const id of thread.emailIds) referencedIds.add(id)
  }

  const pruneIds = planEnvelopePrune({ candidateIds, referencedIds })
  // `deleteEmails` cascades to `emailBodies` in its own transaction — neither names outbox/drafts.
  const prunedEnvelopes = await deleteInChunks(pruneIds, async (chunk) => {
    await db.transaction('rw', db.emails, db.emailBodies, async () => {
      const keys = chunk.map((id) => [accountId, id] as [Id, Id])
      await db.emails.bulkDelete(keys)
      await db.emailBodies.bulkDelete(keys)
    })
  })

  // ---- 4. Threads whose every member is gone. ----
  if (prunedEnvelopes > 0) {
    const pruned = new Set(pruneIds.slice(0, prunedEnvelopes))
    const remaining = new Set(await allEmailIds(db, accountId))
    const deadThreads = threads
      .filter((thread) => thread.emailIds.every((id) => pruned.has(id) || !remaining.has(id)))
      .map((thread) => thread.id)
    await deleteInChunks(deadThreads, (chunk) =>
      db.threads.bulkDelete(chunk.map((id) => [accountId, id] as [Id, Id])),
    )
  }

  // ---- 5. Top up the pinned folders. ----
  const prefetchedBodies = await prefetchPinned(deps, pinned, plan.usageAfter, budgetBytes)

  const usage = await collectCacheUsage(db, accountId, deps.estimate)
  // What was ACTUALLY freed, not what was planned: a delete chunk can fail (a stage stops, it never
  // aborts the pass), and the pruned envelopes are real bytes too. The plan's own `freedBytes` counts
  // rows we may never have deleted and no envelope at all, so reporting it would have told the user
  // "nothing to free up" right after a pass that dropped five thousand aged-out envelopes.
  const bodyIds = plan.bodyIds.slice(0, evictedBodies)
  const blobIds = plan.blobIds.slice(0, evictedBlobs)
  const bytesOf = (items: readonly CacheItem[], ids: readonly Id[]): number => {
    const wanted = new Set(ids)
    let total = 0
    for (const item of items) if (wanted.has(item.id)) total += item.bytes
    return total
  }
  const freedBytes =
    bytesOf(bodies, bodyIds) + bytesOf(blobs, blobIds) + prunedEnvelopes * ENVELOPE_BYTES_ESTIMATE

  return {
    evicted: { ...plan, bodyIds, blobIds },
    freedBytes,
    prunedEnvelopes,
    reapedWindows,
    prefetchedBodies,
    usage,
  }
}

/** A pass gives up prefetching after this many consecutive failures — it is offline, not unlucky. */
const PREFETCH_FAILURE_BUDGET = 3

/**
 * Fetch the missing bodies of the pinned folders — bounded by {@link PIN_PREFETCH_PER_PASS}, stopping
 * early once the cache would pass the low watermark. So a pin is a strong preference, not a way to
 * fill the disk: it never evicts anything to make room for itself, and what it cannot fetch this pass
 * it fetches on the next one.
 *
 * This is the ONE stage that talks to the network, so it is also the one that must not hold anything
 * up: it checks `signal` between fetches (`stop()` awaits the pass, and sign-out awaits `stop()` —
 * without this, signing out could block on up to a hundred request timeouts), and a single message
 * that always fails (destroyed server-side, envelope lingering) must not starve every id behind it.
 */
async function prefetchPinned(
  deps: MaintenanceDeps,
  pinned: readonly Id[],
  usageAfter: number,
  budgetBytes: number,
): Promise<number> {
  const fetchBody = deps.fetchBody
  if (fetchBody === undefined || pinned.length === 0) return 0
  const ceiling = budgetBytes * LOW_WATERMARK
  if (usageAfter >= ceiling) return 0

  const cached = new Set((await bodyCacheEntries(deps.db, deps.accountId)).map((item) => item.id))
  let fetched = 0
  let failures = 0
  for (const mailboxId of pinned) {
    for (const emailId of await emailIdsInMailbox(deps.db, deps.accountId, mailboxId)) {
      if (fetched >= PIN_PREFETCH_PER_PASS) return fetched
      if (deps.signal?.aborted === true) return fetched
      if (cached.has(emailId)) continue
      try {
        await fetchBody(emailId)
        failures = 0
      } catch {
        // This one message is unreachable — skip PAST it, do not let it block the rest of the folder.
        // A run of failures means we are offline; stop and let the next pass retry the whole folder.
        failures += 1
        if (failures >= PREFETCH_FAILURE_BUDGET) return fetched
        continue
      }
      fetched += 1
    }
  }
  return fetched
}

/**
 * Run `write`; if it fails for want of space, force a maintenance pass for `needBytes` and retry
 * ONCE. A second failure propagates — the caller (a body fetch, a blob cache write) then treats the
 * CACHE write as best-effort and surfaces `status.storage.full` once. There is deliberately no loop:
 * an origin that is genuinely full must not spin the eviction planner.
 */
export async function withQuotaRecovery<T>(
  write: () => Promise<T>,
  recover: (needBytes: number) => Promise<unknown>,
  needBytes: number,
): Promise<T> {
  try {
    return await write()
  } catch (error) {
    if (!isQuotaExceeded(error)) throw error
    await recover(needBytes)
    return await write()
  }
}
