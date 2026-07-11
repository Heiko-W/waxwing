/**
 * Delta sync (M1.3, FR-NOTIF-01, tech-stack §4.3). Advances the replica from a JMAP push
 * `StateChange` (or a reconnect re-sync) using `Foo/changes` + `Email/queryChanges`, keyed by the
 * per-type JMAP state strings in `syncState`. Everything speaks the narrow {@link JmapPort}, so the
 * logic is tested against a plain fake port.
 *
 * Splits by object type: mailboxes and threads are small and pulled/deltaed whole; emails are NOT
 * pulled from a null state (a mailbox may hold 100k) — their initial population is the
 * backfill/query path ({@link fullRequery}), and {@link syncEmails} only advances an existing state.
 */

import type { EmailComparator, EmailFilter, Id, Mailbox } from '@waxwing/jmap'
import type { MailboxRow, QueryCacheRow, ReplicaDb } from '../db'
import {
  deleteEmails,
  deleteMailbox,
  deleteThreads,
  emailsByIds,
  getQueryCache,
  getSyncState,
  putEmails,
  putMailboxes,
  putQueryCache,
  putThreads,
  recordAddressStats,
  setSyncState,
} from '../repo'
import { CannotCalculateChangesError, type EngineClock, type JmapPort } from './types'

/** The `{filter, sort, collapseThreads}` a watched query is defined by. */
export interface QuerySpecInput {
  readonly filter?: EmailFilter | null
  readonly sort?: EmailComparator[] | null
  readonly collapseThreads?: boolean
}

/** Fallback window size for a full re-query when no prior window length is known (mirrors backfill). */
const DEFAULT_WINDOW_LIMIT = 50

/** Accumulated effect of a (possibly multi-page) `Foo/changes` run. */
interface ChangesAccumulator {
  readonly changed: Id[]
  readonly destroyed: Id[]
  readonly newState: string
  /** Union of `updatedProperties` across pages, or null if any page reported a full update. */
  readonly updatedProperties: string[] | null
}

/**
 * Drain a `Foo/changes` feed to its end, folding across `hasMoreChanges` pages. An id created then
 * destroyed (or vice-versa) across pages ends in its last-seen bucket; `changed` excludes anything
 * ultimately destroyed.
 */
async function drainChanges(
  fetchPage: (sinceState: string) => Promise<{
    newState: string
    hasMoreChanges: boolean
    created: Id[]
    updated: Id[]
    destroyed: Id[]
    updatedProperties?: string[] | null
  }>,
  sinceState: string,
): Promise<ChangesAccumulator> {
  const changed = new Set<Id>()
  const destroyed = new Set<Id>()
  const props = new Set<string>()
  let propsWholeUpdate = false
  let state = sinceState

  for (;;) {
    const page = await fetchPage(state)
    for (const id of page.created) {
      destroyed.delete(id)
      changed.add(id)
    }
    for (const id of page.updated) {
      destroyed.delete(id)
      changed.add(id)
    }
    for (const id of page.destroyed) {
      changed.delete(id)
      destroyed.add(id)
    }
    if (page.updatedProperties === null || page.updatedProperties === undefined) {
      propsWholeUpdate = true
    } else {
      for (const prop of page.updatedProperties) props.add(prop)
    }
    state = page.newState
    if (!page.hasMoreChanges) break
  }

  return {
    changed: [...changed],
    destroyed: [...destroyed],
    newState: state,
    updatedProperties: propsWholeUpdate ? null : [...props],
  }
}

/**
 * Mailbox sync. Initial (no state) pulls every mailbox; delta applies `Mailbox/changes`, honoring
 * the `updatedProperties` optimization — when only named props (typically the counts) changed, the
 * existing rows are patched rather than replaced.
 */
export async function syncMailboxes(
  port: JmapPort,
  db: ReplicaDb,
  accountId: Id,
  clock: EngineClock,
): Promise<void> {
  const sinceState = await getSyncState(db, accountId, 'Mailbox')
  if (sinceState === null) {
    const { list, state } = await port.getMailboxes(null)
    await putMailboxes(db, accountId, list)
    await setSyncState(db, accountId, 'Mailbox', state, clock.now())
    return
  }

  const acc = await drainChanges((s) => port.mailboxChanges(s), sinceState)
  if (acc.changed.length > 0) {
    const { list } = await port.getMailboxes(acc.changed)
    if (acc.updatedProperties === null) {
      await putMailboxes(db, accountId, list)
    } else {
      await patchMailboxes(db, accountId, list, acc.updatedProperties)
    }
  }
  for (const id of acc.destroyed) await deleteMailbox(db, accountId, id)
  await setSyncState(db, accountId, 'Mailbox', acc.newState, clock.now())
}

/** Patch only the changed props onto existing mailbox rows; full-insert any not present locally. */
async function patchMailboxes(
  db: ReplicaDb,
  accountId: Id,
  list: Mailbox[],
  changedProps: string[],
): Promise<void> {
  for (const mailbox of list) {
    const patch: Partial<MailboxRow> = {}
    const source = mailbox as unknown as Record<string, unknown>
    for (const prop of changedProps) {
      if (prop in source) (patch as Record<string, unknown>)[prop] = source[prop]
    }
    const updated = await db.mailboxes.update([accountId, mailbox.id], patch)
    if (updated === 0) await putMailboxes(db, accountId, [mailbox])
  }
}

/**
 * Thread sync — delta only. Threads are never pulled from a null state (there can be many); they
 * are fetched on demand by backfill/reconcile, which seeds the Thread state. Once a state exists,
 * `Thread/changes` keeps it current.
 */
export async function syncThreads(
  port: JmapPort,
  db: ReplicaDb,
  accountId: Id,
  clock: EngineClock,
): Promise<void> {
  const sinceState = await getSyncState(db, accountId, 'Thread')
  if (sinceState === null) return

  const acc = await drainChanges((s) => port.threadChanges(s), sinceState)
  if (acc.changed.length > 0) {
    const { list } = await port.getThreads(acc.changed)
    await putThreads(db, accountId, list)
  }
  if (acc.destroyed.length > 0) await deleteThreads(db, accountId, acc.destroyed)
  await setSyncState(db, accountId, 'Thread', acc.newState, clock.now())
}

/**
 * Email sync — delta only (no-op from a null state; initial population is {@link fullRequery}).
 * Advances the Email state by applying `Email/changes` into the envelope table.
 */
export async function syncEmails(
  port: JmapPort,
  db: ReplicaDb,
  accountId: Id,
  clock: EngineClock,
): Promise<void> {
  const sinceState = await getSyncState(db, accountId, 'Email')
  if (sinceState === null) return

  const acc = await drainChanges((s) => port.emailChanges(s), sinceState)
  if (acc.changed.length > 0) {
    const { list } = await port.getEmailEnvelopes(acc.changed)
    await putEmails(db, accountId, list)
    // Recents accumulation (M2.4) is best-effort — never break delta sync on a stats failure.
    try {
      await recordAddressStats(db, accountId, list)
    } catch {
      /* non-critical */
    }
  }
  if (acc.destroyed.length > 0) await deleteEmails(db, accountId, acc.destroyed)
  await setSyncState(db, accountId, 'Email', acc.newState, clock.now())
}

/**
 * Keep one watched `Email/query` window current. Prefers `Email/queryChanges` (cheap delta) and
 * falls back to a full re-query on `cannotCalculateChanges`. `forceFull` skips the delta entirely:
 * because Stalwart did NOT raise `cannotCalculateChanges` for a bogus `sinceQueryState` (SP.4), the
 * absence of that error is not proof of freshness, so the engine periodically forces a full pass.
 */
export async function reconcileQuery(
  port: JmapPort,
  db: ReplicaDb,
  accountId: Id,
  queryKey: string,
  spec: QuerySpecInput,
  clock: EngineClock,
  forceFull = false,
): Promise<void> {
  const row = await getQueryCache(db, accountId, queryKey)
  // Re-materialize a same-sized window on a full pass so forceFull/recovery never replaces a
  // bounded recent window with the entire (possibly huge) filtered result set.
  const windowLimit = row && row.ids.length > 0 ? row.ids.length : DEFAULT_WINDOW_LIMIT
  if (forceFull || row === undefined || row.queryState === null) {
    await fullRequery(port, db, accountId, queryKey, spec, clock, windowLimit)
    return
  }

  let changes: Awaited<ReturnType<JmapPort['queryEmailChanges']>>
  try {
    changes = await port.queryEmailChanges({
      filter: spec.filter ?? null,
      sort: spec.sort ?? null,
      collapseThreads: spec.collapseThreads ?? false,
      sinceQueryState: row.queryState,
      // Bound the delta to THIS window (RFC 8620 §5.6): without upToId the server reports adds
      // across the whole result set, whose indexes lie past our window and corrupt the id order.
      upToId: row.upToId,
    })
  } catch (error) {
    if (error instanceof CannotCalculateChangesError) {
      await fullRequery(port, db, accountId, queryKey, spec, clock, windowLimit)
      return
    }
    throw error
  }

  const removed = new Set(changes.removed)
  const ids = row.ids.filter((id) => !removed.has(id))
  // `added` is index-ascending (RFC 8620 §5.6): splice each into place in order. Defensively drop
  // any item whose index lands past the current window (a server that ignored upToId) rather than
  // letting splice append it at the wrong position.
  for (const item of changes.added) {
    if (item.index <= ids.length) ids.splice(item.index, 0, item.id)
  }

  await hydrateMissing(
    port,
    db,
    accountId,
    changes.added.map((item) => item.id),
  )

  await putQueryCache(db, {
    ...row,
    ids,
    queryState: changes.newQueryState,
    total: changes.total ?? row.total,
    upToId: ids.length > 0 ? (ids[ids.length - 1] ?? null) : null,
    lastUsedAt: clock.now(),
  })
}

/**
 * Replace a watched query window wholesale via `Email/query`. Seeds the Email sync state from the
 * envelope fetch when none exists yet, so subsequent {@link syncEmails} deltas have a cursor.
 */
export async function fullRequery(
  port: JmapPort,
  db: ReplicaDb,
  accountId: Id,
  queryKey: string,
  spec: QuerySpecInput,
  clock: EngineClock,
  limit?: number,
): Promise<void> {
  const query = await port.queryEmails({
    filter: spec.filter ?? null,
    sort: spec.sort ?? null,
    collapseThreads: spec.collapseThreads ?? false,
    calculateTotal: true,
    ...(limit === undefined ? {} : { limit }),
  })
  const envelopes = await port.getEmailEnvelopes(query.ids)
  await putEmails(db, accountId, envelopes.list)

  if ((await getSyncState(db, accountId, 'Email')) === null) {
    await setSyncState(db, accountId, 'Email', envelopes.state, clock.now())
  }

  const row: QueryCacheRow = {
    accountId,
    key: queryKey,
    ids: query.ids,
    queryState: query.queryState,
    total: query.total ?? null,
    upToId: query.ids.length > 0 ? (query.ids[query.ids.length - 1] ?? null) : null,
    filter: spec.filter ?? null,
    sort: spec.sort ?? null,
    collapseThreads: spec.collapseThreads ?? false,
    lastUsedAt: clock.now(),
  }
  await putQueryCache(db, row)
}

/** Fetch + store envelopes for any of `ids` not already in the replica. */
async function hydrateMissing(
  port: JmapPort,
  db: ReplicaDb,
  accountId: Id,
  ids: Id[],
): Promise<void> {
  if (ids.length === 0) return
  const present = await emailsByIds(db, accountId, ids)
  const missing = ids.filter((_, index) => present[index] === undefined)
  if (missing.length === 0) return
  const envelopes = await port.getEmailEnvelopes(missing)
  await putEmails(db, accountId, envelopes.list)
}
