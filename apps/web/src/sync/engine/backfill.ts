/**
 * Windowed backfill (M1.3, FR-OFF-02): seed and page the replica's watched `Email/query` windows —
 * the recent-N-days-per-mailbox horizon from `config.json` `offline.cacheDays` — and the "load more"
 * older pages. Operates on the narrow {@link JmapPort} so it is testable against a plain fake. The
 * ordered id window lives in `queryCache`; the virtualized list (M1.6) renders from it. Full
 * queryState reconciliation lives in `delta.reconcileQuery`; here we only seed and append.
 */

import type { EmailComparator, EmailFilter, Id } from '@waxwing/jmap'
import type { EmailEnvelopeInput, QueryCacheRow, ReplicaDb } from '../db'
import { canonicalQueryKey, type QuerySpec } from '../query-key'
import {
  getQueryCache,
  getSyncState,
  putEmails,
  putQueryCache,
  putThreads,
  recordAddressStats,
  setSyncState,
} from '../repo'
import type { JmapPort } from './types'

const DAY_MS = 86_400_000
const DEFAULT_LIMIT = 50
const DEFAULT_SORT: readonly EmailComparator[] = [{ property: 'receivedAt', isAscending: false }]

/**
 * The recent-window filter for a mailbox: `inMailbox AND receivedAt >= now - cacheDays`. The
 * boundary is floored to UTC midnight so the canonical query key is STABLE across a day (and across
 * leader hand-overs within it) instead of drifting every millisecond, which would orphan the cached
 * window and re-backfill on every new leader. (Reaping day-old orphaned windows is cache policy, M3.4.)
 */
export function windowFilter(mailboxId: Id, cacheDays: number, now: number): EmailFilter {
  const boundaryMs = now - cacheDays * DAY_MS
  const midnightMs = boundaryMs - (boundaryMs % DAY_MS)
  const after = new Date(midnightMs).toISOString()
  return { operator: 'AND', conditions: [{ inMailbox: mailboxId }, { after }] }
}

/** Sort + threading options that distinguish one watched window from another for the same mailbox. */
export interface WindowSpec {
  readonly sort?: EmailComparator[]
  readonly collapseThreads?: boolean
}

/**
 * The canonical key + spec for a mailbox's recent window — lets a leader ADOPT an existing window
 * and lets the M1.6 list compute the SAME key the engine watches (per mailbox + sort + threading).
 */
export function windowQueryKey(
  mailboxId: Id,
  cacheDays: number,
  now: number,
  opts: WindowSpec = {},
): { key: string; spec: QuerySpec } {
  const spec: QuerySpec = {
    filter: windowFilter(mailboxId, cacheDays, now),
    sort: opts.sort ?? [...DEFAULT_SORT],
    collapseThreads: opts.collapseThreads ?? true,
  }
  return { key: canonicalQueryKey(spec), spec }
}

export interface BackfillOptions {
  readonly cacheDays: number
  readonly limit?: number
  readonly sort?: EmailComparator[]
  readonly collapseThreads?: boolean
  readonly now: number
}

export interface BackfillResult {
  readonly key: string
  readonly ids: Id[]
  readonly total: number | undefined
}

/** Fetch + store the Thread objects the given envelopes belong to (deduped). */
async function fetchThreadsFor(
  port: JmapPort,
  db: ReplicaDb,
  accountId: Id,
  envelopes: readonly EmailEnvelopeInput[],
): Promise<void> {
  const threadIds = [...new Set(envelopes.map((envelope) => envelope.threadId))]
  if (threadIds.length === 0) return
  const threads = await port.getThreads(threadIds)
  await putThreads(db, accountId, threads.list)
}

/**
 * Seed an ARBITRARY watched query (a mailbox recent-window OR a search, M3.1): run the initial
 * `Email/query`, fetch the envelopes + their threads into the replica, seed the `Email` sync state
 * (so `delta.syncEmails` can take over), and write the `queryCache` row the list renders from.
 */
export async function backfillQuery(
  port: JmapPort,
  db: ReplicaDb,
  accountId: Id,
  spec: QuerySpec,
  opts: { limit?: number; now: number },
): Promise<BackfillResult> {
  const limit = opts.limit ?? DEFAULT_LIMIT
  const collapseThreads = spec.collapseThreads ?? true
  const key = canonicalQueryKey(spec)

  const result = await port.queryEmails({ ...spec, position: 0, limit, calculateTotal: true })
  const envelopes = await port.getEmailEnvelopes(result.ids)
  await putEmails(db, accountId, envelopes.list)
  // Recents accumulation (M2.4) is best-effort — a failure must never break the backfill.
  try {
    await recordAddressStats(db, accountId, envelopes.list)
  } catch {
    /* non-critical */
  }
  await fetchThreadsFor(port, db, accountId, envelopes.list)

  // Seed the Email sync state from the get so delta email-sync can advance it (the query result
  // carries a queryState, not the object state). Only seed when we don't already have one.
  if ((await getSyncState(db, accountId, 'Email')) === null) {
    await setSyncState(db, accountId, 'Email', envelopes.state, opts.now)
  }

  const row: QueryCacheRow = {
    accountId,
    key,
    ids: result.ids,
    queryState: result.queryState,
    total: result.total ?? null,
    upToId: result.ids.at(-1) ?? null,
    filter: spec.filter ?? null,
    sort: spec.sort ?? null,
    collapseThreads,
    lastUsedAt: opts.now,
  }
  await putQueryCache(db, row)
  return { key, ids: result.ids, total: result.total }
}

/** Seed a mailbox's recent window — the `inMailbox AND recent` filter over {@link backfillQuery}. */
export async function backfillMailbox(
  port: JmapPort,
  db: ReplicaDb,
  accountId: Id,
  mailboxId: Id,
  opts: BackfillOptions,
): Promise<BackfillResult> {
  const spec: QuerySpec = {
    filter: windowFilter(mailboxId, opts.cacheDays, opts.now),
    sort: opts.sort ?? [...DEFAULT_SORT],
    collapseThreads: opts.collapseThreads ?? true,
  }
  return backfillQuery(port, db, accountId, spec, {
    limit: opts.limit ?? DEFAULT_LIMIT,
    now: opts.now,
  })
}

export interface LoadMoreOptions {
  readonly limit?: number
  readonly now: number
}

/**
 * Append the next older page to a watched window. Pages by `position` = current window length,
 * dedupes any overlap, fetches the new envelopes + threads, and extends the `queryCache` row.
 * (M1 scope appends optimistically; a stale queryState is reconciled later by `delta.reconcileQuery`.)
 */
export async function loadMore(
  port: JmapPort,
  db: ReplicaDb,
  accountId: Id,
  key: string,
  opts: LoadMoreOptions,
): Promise<{ added: number }> {
  const row = await getQueryCache(db, accountId, key)
  if (!row) throw new Error(`loadMore: no query cache for key ${key}`)
  const limit = opts.limit ?? DEFAULT_LIMIT

  const spec: QuerySpec = {
    filter: row.filter,
    sort: row.sort,
    collapseThreads: row.collapseThreads,
  }
  const result = await port.queryEmails({
    ...spec,
    position: row.ids.length,
    limit,
    calculateTotal: true,
  })

  const existing = new Set(row.ids)
  const fresh = result.ids.filter((id) => !existing.has(id))
  if (fresh.length > 0) {
    const envelopes = await port.getEmailEnvelopes(fresh)
    await putEmails(db, accountId, envelopes.list)
    try {
      await recordAddressStats(db, accountId, envelopes.list)
    } catch {
      /* non-critical */
    }
    await fetchThreadsFor(port, db, accountId, envelopes.list)
  }

  const ids = [...row.ids, ...fresh]
  const updated: QueryCacheRow = {
    ...row,
    ids,
    upToId: ids.at(-1) ?? null,
    queryState: result.queryState,
    total: result.total ?? row.total,
    lastUsedAt: opts.now,
  }
  await putQueryCache(db, updated)
  return { added: fresh.length }
}
