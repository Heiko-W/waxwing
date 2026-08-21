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

import type {
  CalendarEventFilter,
  ContactCardComparator,
  ContactCardFilter,
  EmailComparator,
  EmailFilter,
  Id,
  Mailbox,
} from '@waxwing/jmap'
import type {
  CalendarQueryCacheRow,
  ContactQueryCacheRow,
  EmailEnvelopeInput,
  MailboxRow,
  QueryCacheRow,
  ReplicaDb,
} from '../db'
import {
  calendarEventsForBase,
  calendarQueryCacheForAccount,
  contactCardsByIds,
  deleteAddressBooks,
  deleteCalendarEvents,
  deleteCalendars,
  deleteContactCards,
  deleteEmails,
  deleteFileNodes,
  deleteMailbox,
  deleteThreads,
  emailsByIds,
  getCalendarQueryCache,
  getContactQueryCache,
  getQueryCache,
  getSyncState,
  markCalendarWindowsStale,
  putAddressBooks,
  putCalendarEvents,
  putCalendarQueryCache,
  putCalendars,
  putContactCards,
  putContactQueryCache,
  putEmails,
  putFileNodes,
  putMailboxes,
  putQueryCache,
  putThreads,
  recordAddressStats,
  replaceIdentities,
  setFileTreeState,
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
  /**
   * The ids the server reported as CREATED — a strict subset of {@link changed}, kept apart because
   * "new" and "changed" are different questions and only one of them means new mail (M3.6).
   *
   * Everything else in the engine wants `changed` (fetch it, store it). The notifier wants exactly
   * this: fold the two together and a `$seen` flip from a phone, a move, a label edit — any write by
   * any client — becomes indistinguishable from an arrival, and the app buzzes at the user for
   * reading their own mail somewhere else.
   */
  readonly created: Id[]
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
  const created = new Set<Id>()
  const destroyed = new Set<Id>()
  const props = new Set<string>()
  let propsWholeUpdate = false
  let state = sinceState

  for (;;) {
    const page = await fetchPage(state)
    for (const id of page.created) {
      destroyed.delete(id)
      changed.add(id)
      created.add(id)
    }
    for (const id of page.updated) {
      destroyed.delete(id)
      changed.add(id)
      // NOT `created.delete(id)`: an id created on one page and updated on a later one is still an
      // arrival — the server is describing one object's history, not two events.
    }
    for (const id of page.destroyed) {
      changed.delete(id)
      created.delete(id)
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
    created: [...created],
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
/**
 * One-shot identity pull (M2.5). Identities rarely change and are few, so `Identity/changes` is
 * deferred — the engine fetches them once per leadership session (guarded by a flag there).
 */
export async function syncIdentities(
  port: JmapPort,
  db: ReplicaDb,
  accountId: Id,
  clock: EngineClock,
): Promise<void> {
  const { list, state } = await port.getIdentities()
  await replaceIdentities(db, accountId, list)
  await setSyncState(db, accountId, 'Identity', state, clock.now())
}

/**
 * Which mailbox rows this pass overwrote with the server's ABSOLUTE count, PER FIELD (M3.10, gap B7).
 *
 * Per field because `Mailbox/changes` may name `updatedProperties`, and a pass that rewrote only
 * `unreadEmails` must not have an optimistic `totalEmails` delta re-applied on top of a `totalEmails`
 * it never touched. Empty ⇒ nothing to re-apply, which is the common case: `syncMailboxes` patches
 * only the mailboxes the server actually reports as changed.
 */
export interface MailboxCountWrites {
  readonly total: readonly Id[]
  readonly unread: readonly Id[]
}

const NO_COUNT_WRITES: MailboxCountWrites = { total: [], unread: [] }

export async function syncMailboxes(
  port: JmapPort,
  db: ReplicaDb,
  accountId: Id,
  clock: EngineClock,
): Promise<MailboxCountWrites> {
  const sinceState = await getSyncState(db, accountId, 'Mailbox')
  if (sinceState === null) {
    const { list, state } = await port.getMailboxes(null)
    await putMailboxes(db, accountId, list)
    await setSyncState(db, accountId, 'Mailbox', state, clock.now())
    const ids = list.map((mailbox) => mailbox.id)
    return { total: ids, unread: ids }
  }

  const acc = await drainChanges((s) => port.mailboxChanges(s), sinceState)
  let writes = NO_COUNT_WRITES
  if (acc.changed.length > 0) {
    const { list } = await port.getMailboxes(acc.changed)
    const ids = list.map((mailbox) => mailbox.id)
    if (acc.updatedProperties === null) {
      await putMailboxes(db, accountId, list)
      writes = { total: ids, unread: ids } // a whole-row put rewrites both
    } else {
      await patchMailboxes(db, accountId, list, acc.updatedProperties)
      writes = {
        total: acc.updatedProperties.includes('totalEmails') ? ids : [],
        unread: acc.updatedProperties.includes('unreadEmails') ? ids : [],
      }
    }
  }
  for (const id of acc.destroyed) await deleteMailbox(db, accountId, id)
  await setSyncState(db, accountId, 'Mailbox', acc.newState, clock.now())
  return writes
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
 *
 * Returns the envelopes of the emails `Email/changes` reported as **created** — and only those. This
 * is the sole place in the engine that learns "this Email is new to the account", and M3.6's notifier
 * is built on it. It is deliberately a RETURN VALUE and not a callback: `delta.ts` stays a pure data
 * function tested against a fake port, while the policy (leader? first pass? foreground? which
 * folders?) sits in the engine and the notifier, where the session facts it needs actually live.
 *
 * **Nothing else may serve as the new-mail seam.** `putEmails` is also called by {@link fullRequery}
 * (the periodic `forceFull` re-probe), by every backfill page and by `hydrateMissing` — a hook there
 * would fire on a re-probe of mail the user read last week.
 */
export async function syncEmails(
  port: JmapPort,
  db: ReplicaDb,
  accountId: Id,
  clock: EngineClock,
): Promise<EmailEnvelopeInput[]> {
  const sinceState = await getSyncState(db, accountId, 'Email')
  if (sinceState === null) return []

  const acc = await drainChanges((s) => port.emailChanges(s), sinceState)
  let created: EmailEnvelopeInput[] = []
  if (acc.changed.length > 0) {
    const { list } = await port.getEmailEnvelopes(acc.changed)
    await putEmails(db, accountId, list)
    const createdIds = new Set(acc.created)
    // From `list`, not from `acc.created`: an id the server reported as created but did not return
    // from the `/get` (destroyed in the meantime, or not visible to us) has no envelope to notify with.
    created = list.filter((email) => createdIds.has(email.id))
    // Recents accumulation (M2.4) is best-effort — never break delta sync on a stats failure.
    try {
      await recordAddressStats(db, accountId, list)
    } catch {
      /* non-critical */
    }
  }
  if (acc.destroyed.length > 0) await deleteEmails(db, accountId, acc.destroyed)
  await setSyncState(db, accountId, 'Email', acc.newState, clock.now())
  return created
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
  // Re-materialize a same-sized window on a full pass so forceFull/recovery never replaces a bounded
  // recent window with the entire (possibly huge) filtered result set — but never SMALLER than the
  // window every query starts with. `ids.length` is a floor on what the user has loaded, not a target:
  // messages LEAVE a window all the time (a server-side removal, or the optimistic prune of an archive
  // — M3.8/outbox.ts), and re-querying at the shrunken length would bake each departure in. Undoing an
  // archive would then restore the row at the top of the list while silently dropping the oldest row
  // off the bottom, and the window would ratchet down one row per triaged message.
  const windowLimit = Math.max(row?.ids.length ?? 0, DEFAULT_WINDOW_LIMIT)
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

// ---------------------------------------------------------------------------------------------
// Contacts delta (M4.2, RFC 9610). AddressBooks mirror {@link syncMailboxes} (small, pulled whole);
// ContactCards mirror {@link syncEmails} (delta only, initial population via {@link fullRequeryContacts});
// {@link reconcileContactQuery} mirrors {@link reconcileQuery} incl. the `cannotCalculateChanges` recovery.
// ---------------------------------------------------------------------------------------------

/** The `{filter, sort}` a watched `ContactCard/query` is defined by (no `collapseThreads`). */
export interface ContactQuerySpecInput {
  readonly filter?: ContactCardFilter | null
  readonly sort?: ContactCardComparator[] | null
}

/**
 * AddressBook sync (mirror of {@link syncMailboxes}, minus the mailbox count bookkeeping — address
 * books carry no unread/total counts). Initial (no state) pulls every book; delta applies
 * `AddressBook/changes` (whole-row put on the changed set — `AddressBook/changes` reports no
 * `updatedProperties`).
 */
export async function syncAddressBooks(
  port: JmapPort,
  db: ReplicaDb,
  accountId: Id,
  clock: EngineClock,
): Promise<void> {
  const sinceState = await getSyncState(db, accountId, 'AddressBook')
  if (sinceState === null) {
    const { list, state } = await port.getAddressBooks(null)
    await putAddressBooks(db, accountId, list)
    await setSyncState(db, accountId, 'AddressBook', state, clock.now())
    return
  }

  const acc = await drainChanges((s) => port.addressBookChanges(s), sinceState)
  if (acc.changed.length > 0) {
    const { list } = await port.getAddressBooks(acc.changed)
    await putAddressBooks(db, accountId, list)
  }
  if (acc.destroyed.length > 0) await deleteAddressBooks(db, accountId, acc.destroyed)
  await setSyncState(db, accountId, 'AddressBook', acc.newState, clock.now())
}

/**
 * ContactCard sync — delta only (no-op from a null state; initial population is
 * {@link fullRequeryContacts}). Advances the ContactCard state by applying `ContactCard/changes` into
 * the card table. Mirror of {@link syncEmails}, without the new-mail return (contacts have no notifier).
 */
export async function syncContactCards(
  port: JmapPort,
  db: ReplicaDb,
  accountId: Id,
  clock: EngineClock,
): Promise<void> {
  const sinceState = await getSyncState(db, accountId, 'ContactCard')
  if (sinceState === null) return

  const acc = await drainChanges((s) => port.contactCardChanges(s), sinceState)
  if (acc.changed.length > 0) {
    const { list } = await port.getContactCards(acc.changed)
    await putContactCards(db, accountId, list)
  }
  if (acc.destroyed.length > 0) await deleteContactCards(db, accountId, acc.destroyed)
  await setSyncState(db, accountId, 'ContactCard', acc.newState, clock.now())
}

/**
 * Keep one watched `ContactCard/query` window current (mirror of {@link reconcileQuery}). Prefers
 * `ContactCard/queryChanges` (cheap delta) and falls back to a full re-query on
 * `cannotCalculateChanges`. `forceFull` skips the delta entirely — the same SP.4 "absence of the
 * error is not proof of freshness" re-probe as the mail path.
 */
export async function reconcileContactQuery(
  port: JmapPort,
  db: ReplicaDb,
  accountId: Id,
  queryKey: string,
  spec: ContactQuerySpecInput,
  clock: EngineClock,
  forceFull = false,
): Promise<void> {
  const row = await getContactQueryCache(db, accountId, queryKey)
  // Same window-floor reasoning as {@link reconcileQuery}: never re-materialize SMALLER than the
  // window every query starts with, or a removal would ratchet the window down one row at a time.
  const windowLimit = Math.max(row?.ids.length ?? 0, DEFAULT_WINDOW_LIMIT)
  if (forceFull || row === undefined || row.queryState === null) {
    await fullRequeryContacts(port, db, accountId, queryKey, spec, clock, windowLimit)
    return
  }

  let changes: Awaited<ReturnType<JmapPort['queryContactCardChanges']>>
  try {
    changes = await port.queryContactCardChanges({
      filter: spec.filter ?? null,
      sort: spec.sort ?? null,
      sinceQueryState: row.queryState,
      // Bound the delta to THIS window (RFC 8620 §5.6) — without upToId the server reports adds past
      // our window whose indexes corrupt the id order.
      upToId: row.upToId,
    })
  } catch (error) {
    if (error instanceof CannotCalculateChangesError) {
      await fullRequeryContacts(port, db, accountId, queryKey, spec, clock, windowLimit)
      return
    }
    throw error
  }

  const removed = new Set(changes.removed)
  const ids = row.ids.filter((id) => !removed.has(id))
  // `added` is index-ascending: splice each into place in order; drop any landing past the window.
  for (const item of changes.added) {
    if (item.index <= ids.length) ids.splice(item.index, 0, item.id)
  }

  await hydrateMissingContacts(
    port,
    db,
    accountId,
    changes.added.map((item) => item.id),
  )

  await putContactQueryCache(db, {
    ...row,
    ids,
    queryState: changes.newQueryState,
    total: changes.total ?? row.total,
    upToId: ids.length > 0 ? (ids[ids.length - 1] ?? null) : null,
    lastUsedAt: clock.now(),
  })
}

/**
 * Replace a watched contact query window wholesale via `ContactCard/query` (mirror of
 * {@link fullRequery}). Seeds the ContactCard sync state from the card fetch when none exists yet, so
 * subsequent {@link syncContactCards} deltas have a cursor.
 */
export async function fullRequeryContacts(
  port: JmapPort,
  db: ReplicaDb,
  accountId: Id,
  queryKey: string,
  spec: ContactQuerySpecInput,
  clock: EngineClock,
  limit?: number,
): Promise<void> {
  const query = await port.queryContactCards({
    filter: spec.filter ?? null,
    sort: spec.sort ?? null,
    calculateTotal: true,
    ...(limit === undefined ? {} : { limit }),
  })
  const cards = await port.getContactCards(query.ids)
  await putContactCards(db, accountId, cards.list)

  if ((await getSyncState(db, accountId, 'ContactCard')) === null) {
    await setSyncState(db, accountId, 'ContactCard', cards.state, clock.now())
  }

  const row: ContactQueryCacheRow = {
    accountId,
    key: queryKey,
    ids: query.ids,
    queryState: query.queryState,
    total: query.total ?? null,
    upToId: query.ids.length > 0 ? (query.ids[query.ids.length - 1] ?? null) : null,
    filter: spec.filter ?? null,
    sort: spec.sort ?? null,
    lastUsedAt: clock.now(),
  }
  await putContactQueryCache(db, row)
}

/** Fetch + store cards for any of `ids` not already in the replica (mirror of {@link hydrateMissing}). */
export async function hydrateMissingContacts(
  port: JmapPort,
  db: ReplicaDb,
  accountId: Id,
  ids: Id[],
): Promise<void> {
  if (ids.length === 0) return
  const present = await contactCardsByIds(db, accountId, ids)
  const missing = ids.filter((_, index) => present[index] === undefined)
  if (missing.length === 0) return
  const cards = await port.getContactCards(missing)
  await putContactCards(db, accountId, cards.list)
}

// ---------------------------------------------------------------------------------------------
// Calendar delta (K-8). Calendars mirror {@link syncAddressBooks} — few, pulled whole, deltaed by
// `Calendar/changes`. Events do NOT mirror {@link syncContactCards}, and the difference is the whole
// point of this block: what the grid draws are SYNTHETIC occurrences the server expanded, and no
// delta reports on those. `CalendarEvent/changes` reports on STORED events, so it is used for the
// one thing it can honestly say — these objects moved — after which the windows they appear in are
// re-materialized whole by {@link fullRequeryCalendar}.
// ---------------------------------------------------------------------------------------------

/** The filter a watched calendar window is defined by (a month grid × the visible calendars). */
export interface CalendarQuerySpecInput {
  readonly filter?: CalendarEventFilter | null
}

/**
 * Calendar-list sync. Initial (no state) pulls every calendar; a delta applies `Calendar/changes`.
 *
 * A server that cannot compute the delta is not an error and never reaches the caller: it means the
 * list has to be read again, which is precisely what the initial branch does. An account that has
 * never had a calendar change is the ordinary case here, not a corner one.
 */
export async function syncCalendars(
  port: JmapPort,
  db: ReplicaDb,
  accountId: Id,
  clock: EngineClock,
): Promise<void> {
  const sinceState = await getSyncState(db, accountId, 'Calendar')
  if (sinceState === null) {
    await reloadCalendars(port, db, accountId, clock)
    return
  }

  let acc: ChangesAccumulator
  try {
    acc = await drainChanges((state) => port.calendarChanges(state), sinceState)
  } catch (error) {
    if (error instanceof CannotCalculateChangesError) {
      await reloadCalendars(port, db, accountId, clock)
      return
    }
    throw error
  }

  if (acc.changed.length > 0) {
    const { list } = await port.getCalendars(acc.changed)
    await putCalendars(db, accountId, list)
  }
  if (acc.destroyed.length > 0) await deleteCalendars(db, accountId, acc.destroyed)
  await setSyncState(db, accountId, 'Calendar', acc.newState, clock.now())
}

/** Read the whole calendar list and re-seed the cursor — the initial pull AND the recovery. */
async function reloadCalendars(
  port: JmapPort,
  db: ReplicaDb,
  accountId: Id,
  clock: EngineClock,
): Promise<void> {
  const { list, state } = await port.getCalendars(null)
  await putCalendars(db, accountId, list)
  // Whatever the server dropped since the last pull is gone from the answer but still in the
  // replica; the whole-list read is the only chance to notice.
  const known = await db.calendars.where('accountId').equals(accountId).primaryKeys()
  const fresh = new Set(list.map((calendar) => calendar.id))
  const gone = known.map(([, id]) => id).filter((id) => !fresh.has(id))
  if (gone.length > 0) await deleteCalendars(db, accountId, gone)
  await setSyncState(db, accountId, 'Calendar', state, clock.now())
}

/**
 * Event sync — the STORED-object delta, whose only product is a set of stale windows.
 *
 * It deliberately fetches nothing. A changed master says nothing about how many occurrence rows it
 * produces in a given month (a weekly meeting is one id and up to five rows), and computing that
 * locally is the recurrence expansion this client has never done. So the delta marks and moves on;
 * {@link reconcileCalendarQuery} does the reading.
 *
 * A no-op from a null state — the initial population is {@link fullRequeryCalendar}, which seeds the
 * cursor from its own `/get`.
 *
 * Returns the number of windows it marked, purely so the engine can tell a pass that found nothing
 * from one that did.
 */
export async function syncCalendarEvents(
  port: JmapPort,
  db: ReplicaDb,
  accountId: Id,
  clock: EngineClock,
): Promise<number> {
  const sinceState = await getSyncState(db, accountId, 'CalendarEvent')
  if (sinceState === null) return 0

  let acc: ChangesAccumulator
  try {
    acc = await drainChanges((state) => port.calendarEventChanges(state), sinceState)
  } catch (error) {
    if (!(error instanceof CannotCalculateChangesError)) throw error
    // The measured trap, and the requirement: a server that cannot diff has NOT failed. Everything
    // it holds may have moved, so every window is stale and the cursor is dropped — the next full
    // re-query re-seeds it from its own `/get`. Treating this as an error is what would take a
    // brand-new account's calendar down on its very first sync.
    await markCalendarWindowsStale(db, accountId)
    await setSyncState(db, accountId, 'CalendarEvent', null, clock.now())
    return (await calendarQueryCacheForAccount(db, accountId)).length
  }

  const touched = [...new Set([...acc.changed, ...acc.destroyed])]
  let marked = 0
  if (touched.length > 0) {
    // A destroyed master takes its expanded rows with it: they are derived from it and nothing else
    // will ever remove them.
    if (acc.destroyed.length > 0) {
      const orphans: Id[] = []
      for (const baseId of acc.destroyed) {
        for (const row of await calendarEventsForBase(db, accountId, baseId)) orphans.push(row.id)
      }
      if (orphans.length > 0) await deleteCalendarEvents(db, accountId, orphans)
    }
    // Which windows the touched objects appear in. A CREATED event appears in none of them yet — so
    // the id test alone would miss every new event — which is why any created id marks them all.
    const windows = await calendarQueryCacheForAccount(db, accountId)
    const anyCreated = acc.created.length > 0
    const touchedSet = new Set(touched)
    for (const window of windows) {
      if (window.stale) continue
      const hit =
        anyCreated ||
        window.objectIds.some((id) => touchedSet.has(id)) ||
        window.ids.some((id) => touchedSet.has(id))
      if (!hit) continue
      await putCalendarQueryCache(db, { ...window, stale: true })
      marked += 1
    }
  }
  await setSyncState(db, accountId, 'CalendarEvent', acc.newState, clock.now())
  return marked
}

/**
 * Keep one watched calendar window current.
 *
 * There is no cheap path here and there is no pretending otherwise: an expanded window has no
 * `queryChanges` to ask (the ids are synthetic), so "reconcile" means "re-query when due". Due is
 * `forceFull`, an absent row, or the {@link CalendarQueryCacheRow.stale} flag a delta set.
 */
export async function reconcileCalendarQuery(
  port: JmapPort,
  db: ReplicaDb,
  accountId: Id,
  queryKey: string,
  spec: CalendarQuerySpecInput,
  clock: EngineClock,
  forceFull = false,
): Promise<void> {
  const row = await getCalendarQueryCache(db, accountId, queryKey)
  if (!forceFull && row !== undefined && !row.stale) return
  await fullRequeryCalendar(port, db, accountId, queryKey, spec, clock)
}

/**
 * Materialize one calendar window: the expanded occurrences the grid draws, and the unexpanded
 * stored objects behind them.
 *
 * Both halves, in one function, because neither is usable alone — see the note on
 * {@link CalendarQueryCacheRow}. The identity half is best-effort: a server that refuses it leaves
 * every occurrence unresolved, which is a month that reads but cannot be edited, and that is a far
 * better answer than no month at all (the online path has made the same trade since K-2).
 *
 * Seeds the `CalendarEvent` cursor from the `/get` when none exists, so the delta can take over.
 */
export async function fullRequeryCalendar(
  port: JmapPort,
  db: ReplicaDb,
  accountId: Id,
  queryKey: string,
  spec: CalendarQuerySpecInput,
  clock: EngineClock,
): Promise<void> {
  const filter = spec.filter ?? null
  const query = await port.queryCalendarEvents({ filter, expandRecurrences: true })
  const occurrences = await port.getCalendarEvents(query.ids, true)

  let objectIds: Id[] = []
  try {
    const objectQuery = await port.queryCalendarEvents({ filter })
    objectIds = objectQuery.ids
    const objects = await port.getCalendarEvents(objectIds, false)
    // Objects FIRST, occurrences second. On a server that does not synthesise ids the two answers
    // name the same records, and the occurrence set is the richer one — writing it last is what
    // keeps the lean identity fetch from overwriting properties the grid needs.
    await putCalendarEvents(db, accountId, objects.list, false)
  } catch {
    objectIds = []
  }
  await putCalendarEvents(db, accountId, occurrences.list, true)

  if ((await getSyncState(db, accountId, 'CalendarEvent')) === null) {
    await setSyncState(db, accountId, 'CalendarEvent', occurrences.state, clock.now())
  }

  const row: CalendarQueryCacheRow = {
    accountId,
    key: queryKey,
    ids: query.ids,
    objectIds,
    filter,
    stale: false,
    syncedAt: clock.now(),
    lastUsedAt: clock.now(),
  }
  await putCalendarQueryCache(db, row)
}

// ---------------------------------------------------------------------------------------------
// Files (D-4). The whole tree, mirrored — see the note on `FileNodeRow` in `db.ts`.
// ---------------------------------------------------------------------------------------------

/**
 * One page of the tree walk, and the ceiling the `#ids` back-reference has to respect.
 *
 * `maxObjectsInGet` is 500 on Stalwart 0.16, and the get addresses its ids by back-reference — so
 * the generic chunking cannot help and the query's limit IS the get's limit. Mirrors `PAGE` in
 * `files-client.ts`, which pays the same price online.
 */
const FILE_PAGE = 500

/**
 * How many pages one walk will spend before it gives up and says so.
 *
 * Mirrors `MAX_PAGES` in `files-client.ts`. What is not acceptable is silence: a tree that stopped
 * short while looking complete makes every conclusion the reader draws from it ("I must have deleted
 * that") wrong, so the shortfall is recorded and the screen states it.
 */
const FILE_MAX_PAGES = 10

/**
 * File-tree sync.
 *
 * No state ⇒ walk the whole tree; a state ⇒ `FileNode/changes` + a `/get` of what moved. A server
 * that cannot compute the delta gets the walk instead — that is the D-4 measured case (an account
 * with no change history refusing to diff the state its own `/get` just returned) and it means
 * "read it again", not "this failed".
 */
export async function syncFileNodes(
  port: JmapPort,
  db: ReplicaDb,
  accountId: Id,
  clock: EngineClock,
): Promise<void> {
  const sinceState = await getSyncState(db, accountId, 'FileNode')
  if (sinceState === null) {
    await walkFileTree(port, db, accountId, clock)
    return
  }

  let acc: ChangesAccumulator
  try {
    acc = await drainChanges((state) => port.fileNodeChanges(state), sinceState)
  } catch (error) {
    if (error instanceof CannotCalculateChangesError) {
      await walkFileTree(port, db, accountId, clock)
      return
    }
    throw error
  }

  if (acc.changed.length > 0) {
    const { list } = await port.getFileNodes(acc.changed)
    await putFileNodes(db, accountId, list)
  }
  if (acc.destroyed.length > 0) await deleteFileNodes(db, accountId, acc.destroyed)
  await setSyncState(db, accountId, 'FileNode', acc.newState, clock.now())
}

/**
 * Read every node in the account, page by page, and replace the replica's tree with the answer.
 *
 * Three ways out of the loop, and they are NOT the same answer:
 *  - a short page: that was the end of the query, and the tree is COMPLETE;
 *  - {@link FILE_MAX_PAGES} spent: truncated, and the screen says so;
 *  - a page that added nothing new: a server ignoring `position` and handing back the same page for
 *    ever. Also truncated — and the guard that stops this being an infinite loop.
 *
 * Rows the walk did not see are deleted, but ONLY on a complete walk: a truncated one has not seen
 * the whole tree, and treating "not in this answer" as "gone" would delete the very nodes the walk
 * ran out of pages before reaching.
 */
async function walkFileTree(
  port: JmapPort,
  db: ReplicaDb,
  accountId: Id,
  clock: EngineClock,
): Promise<void> {
  const seen = new Set<Id>()
  let truncated = false
  let state: string | null = null
  let position = 0

  for (let page = 0; ; page += 1) {
    const answer = await port.fileNodePage(position, FILE_PAGE)
    const before = seen.size
    for (const node of answer.list) seen.add(node.id)
    await putFileNodes(db, accountId, answer.list)
    state = answer.state
    if (answer.ids.length < FILE_PAGE) break
    if (seen.size === before || page + 1 >= FILE_MAX_PAGES) {
      truncated = true
      break
    }
    position += answer.ids.length
  }

  if (!truncated) {
    const known = await db.fileNodes.where('accountId').equals(accountId).primaryKeys()
    const gone = known.map(([, id]) => id).filter((id) => !seen.has(id))
    if (gone.length > 0) await deleteFileNodes(db, accountId, gone)
  }

  await setFileTreeState(db, accountId, { syncedAt: clock.now(), truncated })
  if (state !== null) await setSyncState(db, accountId, 'FileNode', state, clock.now())
}
