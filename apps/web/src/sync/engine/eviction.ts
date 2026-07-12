/**
 * The cache-policy planner (M3.4, FR-OFF-04) — PURE. No Dexie, no clock, no I/O: it is handed the
 * cached items, the protected id sets and a budget, and it returns a plan. Every hard invariant of
 * the policy is therefore a unit test over a plain function, not an integration test over a database.
 *
 * ## The policy, in order
 *  1. **Orphans** — bodies/blobs whose owning envelope no longer exists. Pure garbage: always dropped,
 *     no budget check, at any usage level.
 *  2. **Blob bytes** (attachments, inline images) — oldest `lastAccessedAt` first. They are by far the
 *     largest rows and the cheapest to re-fetch (one authenticated `download`, no JMAP round-trip),
 *     and losing one degrades an attachment preview, not the message text.
 *  3. **Bodies** — oldest first. Losing a body costs a re-fetch on the next open; it is only VISIBLE
 *     offline.
 *  4. Stop at the low watermark. Never below it (that is what stops the cache from thrashing).
 *
 * Envelopes are NOT part of this at all — not in the loop, and not in its usage figure. They are the
 * index the whole UI renders from, they cannot be freed here, and they are bounded by the `cacheDays`
 * horizon instead ({@link planEnvelopePrune}). Counting bytes the loop is unable to release does not
 * merely make it evict too eagerly: it sets a target that cannot be reached, so the loop drains every
 * body and blob and misses anyway.
 */

import type { Id } from '@waxwing/jmap'
import type { QueryCacheRow } from '../db'
import type { CacheItem } from '../repo'
import type { StorageEstimateLike } from '../storage'

/** Evict down to 80 % of the effective budget, so the next write does not immediately re-trigger a pass. */
export const LOW_WATERMARK = 0.8

/** `estimate().usage / quota` above which we force a pass even though our own accounting is under budget. */
export const PRESSURE_RATIO = 0.9

/** Never claim more than 80 % of the browser's quota — the origin holds more than the mail cache. */
export const QUOTA_SAFETY = 0.8

/** Envelopes must be `cacheDays` + this grace old before pruning: a day-stable window key one boundary
 *  behind must never lose rows out from under it. */
export const PRUNE_GRACE_MS = 7 * 86_400_000

/** An unwatched `queryCache` window older than this is reaped (a closed search, a folder from last week). */
export const QUERY_WINDOW_TTL_MS = 2 * 86_400_000

/** Below this a pass would evict the cache it just filled; a misconfigured `maxStorageMB` cannot go lower. */
export const MIN_BUDGET_BYTES = 50 * 1024 * 1024

/** A pressured pass frees ~20 % of the evictable pool — never all of it (see {@link planEviction}). */
export const PRESSURE_SHARE = 0.8

/** Below this our mail cache is not what is filling the origin; a pressured pass stops shrinking it. */
export const MIN_EVICTABLE_BYTES = 32 * 1024 * 1024

/**
 * The effective byte budget: the configured budget, capped by a safe share of the browser's quota.
 * Without the quota cap a 512 MB config on a 100 MB-quota origin would evict nothing until the browser
 * started throwing.
 *
 * The {@link MIN_BUDGET_BYTES} floor applies ONLY when the browser reports no quota. When it DOES
 * report one, the cap must win: flooring a 10 MB-quota origin up to 50 MB would hand us a budget five
 * times the space we are allowed to use, so budget-driven eviction would never fire at all and only
 * the pressure path — which by definition engages after the origin is already at 90 % — could save us.
 * `clampMaxStorageMB` already keeps the CONFIGURED value at or above the floor.
 */
export function chooseBudget(maxStorageMB: number, estimate: StorageEstimateLike | null): number {
  const configured = Math.max(0, maxStorageMB) * 1024 * 1024
  if (estimate === null) return Math.max(MIN_BUDGET_BYTES, configured)
  return Math.min(configured, estimate.quota * QUOTA_SAFETY)
}

export interface EvictionInputs {
  readonly budgetBytes: number
  /** Unordered — the planner sorts. */
  readonly bodies: readonly CacheItem[]
  readonly blobs: readonly CacheItem[]
  /** Bodies/blobs whose owning envelope is gone — dropped FIRST, ignoring the budget. */
  readonly orphanBodyIds: ReadonlySet<Id>
  readonly orphanBlobIds: ReadonlySet<Id>
  /** NEVER evictable: pinned folders, the open message, and everything the outbox/drafts still need. */
  readonly protectedEmailIds: ReadonlySet<Id>
  readonly protectedBlobIds: ReadonlySet<Id>
  /** Extra bytes the caller needs free RIGHT NOW (the QuotaExceededError path); default 0. */
  readonly needBytes?: number
  /** The origin (not us) is near its quota — free a bounded share of the pool on top of the budget. */
  readonly pressured?: boolean
}

export interface EvictionPlan {
  readonly bodyIds: Id[]
  readonly blobIds: Id[]
  readonly freedBytes: number
  readonly usageBefore: number
  readonly usageAfter: number
  readonly reason: 'none' | 'orphans' | 'budget' | 'need'
}

/** Oldest `lastAccessedAt` first; on a tie the LARGER row goes first (free more, delete fewer rows). */
function lruOrder(a: CacheItem, b: CacheItem): number {
  return a.lastAccessedAt - b.lastAccessedAt || b.bytes - a.bytes
}

/**
 * Plan one eviction pass. Never throws, never loops: it walks each category once, so a budget that is
 * unreachable (because everything left is protected) yields a best-effort plan rather than spinning.
 */
export function planEviction(inputs: EvictionInputs): EvictionPlan {
  const needBytes = Math.max(0, inputs.needBytes ?? 0)
  const bodyIds: Id[] = []
  const blobIds: Id[] = []

  // `usage` is the EVICTABLE pool — bodies and blobs — and nothing else. Envelope bytes must NOT seed
  // it: this loop cannot free an envelope (that is the prune's job, stage 3), and a target driven by
  // bytes it is unable to release does not merely under-perform, it empties BOTH lists to completion
  // and still misses. On a normal replica the envelopes dominate (20 000 of them ≈ 24 MB against a few
  // MB of opened bodies), so seeding with them turned "free 20 % under pressure" into "delete the
  // entire offline cache, every pass, forever".
  let usage = 0
  for (const item of inputs.bodies) usage += item.bytes
  for (const item of inputs.blobs) usage += item.bytes
  const usageBefore = usage

  // 1. Orphans: garbage, dropped at any usage level. They are not "eviction" — nothing can ever read
  //    them again — so they are freed before the budget is even consulted.
  //
  //    PROTECTION STILL WINS. A blob uploaded for a draft attachment has no owning message at all, so
  //    "no owner ⇒ orphan" would classify the attachment of a queued send as garbage and ship a broken
  //    message. The invariant is absolute and enforced here, at the one place a plan is produced: a
  //    protected id can NEVER appear in a plan, for any reason.
  let freed = 0
  const liveBodies: CacheItem[] = []
  for (const item of inputs.bodies) {
    if (inputs.orphanBodyIds.has(item.id) && !inputs.protectedEmailIds.has(item.id)) {
      bodyIds.push(item.id)
      freed += item.bytes
    } else liveBodies.push(item)
  }
  const liveBlobs: CacheItem[] = []
  for (const item of inputs.blobs) {
    if (inputs.orphanBlobIds.has(item.id) && !inputs.protectedBlobIds.has(item.id)) {
      blobIds.push(item.id)
      freed += item.bytes
    } else liveBlobs.push(item)
  }
  const orphanCount = bodyIds.length + blobIds.length
  usage = usageBefore - freed

  // 2–4. The byte budget: blobs before bodies, oldest first, down to the low watermark (minus any
  //      bytes the caller urgently needs), never one row further.
  //
  //      Under ORIGIN pressure the browser is about to evict this origin wholesale, so we also shrink
  //      below the configured budget — but by a BOUNDED share of the pool (≈ 20 % per pass), never to
  //      a target we cannot reach, and never below MIN_EVICTABLE_BYTES: a 6 MB mail cache is not what
  //      is filling a 900 MB origin, and deleting it would cost the user their offline mail for
  //      nothing. `needBytes` still overrides both — a write the user is waiting for wins.
  const pressureTarget = inputs.pressured
    ? Math.max(MIN_EVICTABLE_BYTES, usage * PRESSURE_SHARE)
    : Number.POSITIVE_INFINITY
  const target = Math.max(
    0,
    Math.min(inputs.budgetBytes * LOW_WATERMARK, pressureTarget) - needBytes,
  )
  const evict = (items: CacheItem[], protectedIds: ReadonlySet<Id>, sink: Id[]): void => {
    if (usage <= target) return
    for (const item of [...items].sort(lruOrder)) {
      if (usage <= target) return
      if (protectedIds.has(item.id)) continue
      sink.push(item.id)
      freed += item.bytes
      usage -= item.bytes
    }
  }
  evict(liveBlobs, inputs.protectedBlobIds, blobIds)
  evict(liveBodies, inputs.protectedEmailIds, bodyIds)

  const evictedCount = bodyIds.length + blobIds.length
  const reason: EvictionPlan['reason'] =
    evictedCount === 0
      ? 'none'
      : evictedCount === orphanCount
        ? 'orphans'
        : needBytes > 0
          ? 'need'
          : 'budget'

  return { bodyIds, blobIds, freedBytes: freed, usageBefore, usageAfter: usage, reason }
}

/**
 * Which cached blobs are GARBAGE (pure — the scariest rule in the module, so it is not left inline in
 * the I/O pass where it cannot be tested).
 *
 * A blob is garbage only when we can PROVE nothing will ever read its bytes again: it has no owning
 * body at all, or every owner is itself an orphan (its envelope is gone). It must NOT be inferred from
 * "no owner among the bodies I happened to snapshot" — the owner map is read from the live `ablob`
 * index, several awaits after that snapshot, so a body written in between (the user just opened the
 * message) appears as an owner but not in the snapshot. Orphans are deleted with no budget check, so
 * that inference threw away the attachment of the message on screen.
 *
 * A blob with NO owner is a draft's uploaded attachment — protected by blobId, and {@link planEviction}
 * refuses to plan a protected id under any circumstance.
 */
export function classifyBlobOrphans(inputs: {
  readonly blobs: readonly CacheItem[]
  /** blobId → the ids of the cached BODIES that reference it (from the live `ablob` index). */
  readonly owners: ReadonlyMap<Id, readonly Id[]>
  readonly orphanBodyIds: ReadonlySet<Id>
  readonly protectedEmailIds: ReadonlySet<Id>
}): { orphanBlobIds: Set<Id>; protectedBlobIds: Set<Id> } {
  const orphanBlobIds = new Set<Id>()
  const protectedBlobIds = new Set<Id>()
  for (const blob of inputs.blobs) {
    const ownerIds = inputs.owners.get(blob.id) ?? []
    // Owned by a protected message (a pin, the open message, a draft's source) ⇒ protected with it.
    if (ownerIds.some((id) => inputs.protectedEmailIds.has(id))) {
      protectedBlobIds.add(blob.id)
      continue
    }
    if (ownerIds.length === 0 || ownerIds.every((id) => inputs.orphanBodyIds.has(id))) {
      orphanBlobIds.add(blob.id)
    }
  }
  return { orphanBlobIds, protectedBlobIds }
}

export interface EnvelopePruneInputs {
  /** From `repo.envelopeIdsBefore(horizon)` — everything below the `cacheDays` + grace boundary. */
  readonly candidateIds: readonly Id[]
  /** Ids that must survive: see the invariant on {@link planEnvelopePrune}. */
  readonly referencedIds: ReadonlySet<Id>
}

/**
 * Which aged-out envelopes may be dropped.
 *
 * **The invariant:** an id listed by ANY live `queryCache` window — a folder window, an open search
 * (M3.1), an open label view (M3.2) — is NEVER pruned. Violating it would make `MessageList` render a
 * permanent skeleton row for a message the window still lists but the replica no longer holds: the
 * list would show a hole that no sync could ever fill. The caller therefore builds `referencedIds`
 * from the SURVIVING windows (reap first, prune second) plus every protected id, every surviving
 * body's owner, and the thread members of those windows.
 */
export function planEnvelopePrune(inputs: EnvelopePruneInputs): Id[] {
  return inputs.candidateIds.filter((id) => !inputs.referencedIds.has(id))
}

/**
 * Windows to reap: NOT currently watched by any tab AND last used longer ago than the TTL. This is
 * what lets a stale search (M3.1) or label view (M3.2) stop pinning its envelopes — without it, one
 * search performed once would keep its results in the replica forever.
 */
export function planWindowReap(
  rows: readonly Pick<QueryCacheRow, 'key' | 'lastUsedAt'>[],
  watchedKeys: ReadonlySet<string>,
  now: number,
): string[] {
  return rows
    .filter((row) => !watchedKeys.has(row.key) && now - row.lastUsedAt > QUERY_WINDOW_TTL_MS)
    .map((row) => row.key)
}
