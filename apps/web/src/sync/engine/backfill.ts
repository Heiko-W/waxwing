/**
 * Backfill (M1.3, FR-OFF-02): seed and page the replica's watched `Email/query` windows, and the
 * "load more" older pages. Operates on the narrow {@link JmapPort} so it is testable against a plain
 * fake. The ordered id window lives in `queryCache`; the virtualized list (M1.6) renders from it.
 * Full queryState reconciliation lives in `delta.reconcileQuery`; here we only seed and append.
 *
 * ## A folder query is NOT date-limited, and the cache still is
 * Until M-13 the folder filter carried `receivedAt >= now − offline.cacheDays`, which made the
 * 30-day CACHE horizon double as a 30-day VISIBILITY horizon: a folder whose mail was all older
 * simply had no reachable messages. `loadMore` could not rescue it either — it pages the row's own
 * `filter`, so every page it asked for was bounded by the same `after` and came back empty. Measured
 * against the fixture: 12 messages in the folder, `Mailbox.totalEmails: 12`, and the query the app
 * ran returned `total: 0`. Mail older than a month was unreachable except through search.
 *
 * The two horizons are now separate, which is what they always should have been. What a folder SHOWS
 * is the whole folder, paged 50 at a time by `loadMore` exactly as before — the page limit, not a
 * date, is what keeps the first screen cheap. What the replica KEEPS is still `cacheDays`: the M3.4
 * prune (`maintenance.ts`) is untouched and still drops envelopes past `cacheDays + grace` that no
 * live window references. Scrolling deep into an old folder therefore holds those envelopes for as
 * long as the window is watched, and the ordinary reap + prune reclaims them afterwards.
 *
 * A second effect, free: the key no longer contains a date, so it is stable indefinitely rather than
 * only within a UTC day. The midnight roll used to orphan every folder window and re-backfill it.
 */

import type { EmailComparator, EmailFilter, Id } from '@waxwing/jmap'
import { SNOOZE_KEYWORD } from '../../mail/snooze'
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

const DEFAULT_LIMIT = 50
const DEFAULT_SORT: readonly EmailComparator[] = [{ property: 'receivedAt', isAscending: false }]

/**
 * A folder's filter: every message in it, newest first — the server pages it, `loadMore` walks it.
 * Deliberately carries no date bound; see the file header for why one used to be here and what the
 * `cacheDays` horizon governs instead.
 */
export function folderFilter(mailboxId: Id): EmailFilter {
  return {
    operator: 'AND',
    conditions: [
      { inMailbox: mailboxId },
      // Snoozed messages are hidden until their time comes (M5.8, FR-ORG-03). Excluding them in
      // the QUERY rather than after the fact is what keeps the window counts and the paging
      // honest — a client-side filter would leave gaps in a page the server considers full.
      { notKeyword: SNOOZE_KEYWORD },
    ],
  }
}

/** Sort + threading options that distinguish one watched window from another for the same mailbox. */
export interface WindowSpec {
  readonly sort?: EmailComparator[]
  readonly collapseThreads?: boolean
}

/**
 * The canonical key + spec for a mailbox's window — lets a leader ADOPT an existing window and lets
 * the M1.6 list compute the SAME key the engine watches (per mailbox + sort + threading).
 */
export function folderQueryKey(
  mailboxId: Id,
  opts: WindowSpec = {},
): { key: string; spec: QuerySpec } {
  const spec: QuerySpec = {
    filter: folderFilter(mailboxId),
    sort: opts.sort ?? [...DEFAULT_SORT],
    collapseThreads: opts.collapseThreads ?? true,
  }
  return { key: canonicalQueryKey(spec), spec }
}

export interface BackfillOptions {
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

  // One request, two method calls (B55): `Email/query` and the `Email/get` that reads its ids, with
  // the server resolving `#ids` between them. The write ORDER below is unchanged and still
  // load-bearing — see the note on the window row — but the second round-trip is gone.
  const { query: result, envelopes } = await port.queryEmailsWithEnvelopes({
    ...spec,
    position: 0,
    limit,
    calculateTotal: true,
  })

  // The window row is persisted BEFORE the envelopes it lists — deliberately, and M3.4's envelope
  // prune depends on it. A window is what makes its ids un-prunable, so if the envelopes landed first
  // there would be a wide interval (this function makes a NETWORK round-trip for the threads between
  // the two writes) in which a maintenance pass sees old envelopes that no window claims yet — and
  // prunes the results of the search that is still loading them. Writing the claim first means an
  // envelope can never exist un-claimed. (Since B55 the envelopes arrive in the SAME response as the
  // ids, so the interval is now the width of two `await`s rather than a round-trip — narrower, but
  // the ordering is what makes it impossible rather than merely unlikely, so it stays.) The reverse gap — a window listing ids whose envelopes have
  // not arrived — is the state `hydrateMissing` already exists to handle, and the next reconcile fills.
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

  return { key, ids: result.ids, total: result.total }
}

/** Seed a mailbox's window — the `inMailbox` filter over {@link backfillQuery}. */
export async function backfillMailbox(
  port: JmapPort,
  db: ReplicaDb,
  accountId: Id,
  mailboxId: Id,
  opts: BackfillOptions,
): Promise<BackfillResult> {
  const spec: QuerySpec = {
    filter: folderFilter(mailboxId),
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
  // Batched exactly like `backfillQuery` (B55). The `get` covers every id the query returned, so the
  // envelopes are filtered down to the FRESH ones below — the page is normally all-fresh (the query
  // starts at `position: row.ids.length`), and filtering keeps `recordAddressStats` from counting a
  // recipient twice on the rare overlap.
  const { query: result, envelopes: page } = await port.queryEmailsWithEnvelopes({
    ...spec,
    position: row.ids.length,
    limit,
    calculateTotal: true,
  })

  const existing = new Set(row.ids)
  const fresh = result.ids.filter((id) => !existing.has(id))

  // Same ordering rule as `backfillQuery`: the window claims the new ids BEFORE their envelopes are
  // written, so a concurrent maintenance pass can never prune a page the user just asked to load.
  const ids = [...row.ids, ...fresh]
  const updated: QueryCacheRow = {
    ...row,
    ids,
    upToId: ids.at(-1) ?? null,
    // A VOIDED window stays voided (M3.8): `queryState: null` means "these ids have been edited
    // locally — re-query fully" (outbox.ts). Appending an older page does not make the edited part of
    // the window honest again, so adopting this query's fresh state here would hand `queryChanges` a
    // baseline it never produced — and the delta against it would never re-add what the edit removed.
    queryState: row.queryState === null ? null : result.queryState,
    total: result.total ?? row.total,
    lastUsedAt: opts.now,
  }
  await putQueryCache(db, updated)

  if (fresh.length > 0) {
    const wanted = new Set(fresh)
    const envelopes = { ...page, list: page.list.filter((email) => wanted.has(email.id)) }
    await putEmails(db, accountId, envelopes.list)
    try {
      await recordAddressStats(db, accountId, envelopes.list)
    } catch {
      /* non-critical */
    }
    await fetchThreadsFor(port, db, accountId, envelopes.list)
  }

  return { added: fresh.length }
}
