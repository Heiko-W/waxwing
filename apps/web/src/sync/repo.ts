/**
 * Repository layer (M1.2): the indexed CRUD + read paths the folder tree (M1.5) and the message
 * list (M1.6) need. Every function is account-scoped and served by an index declared in
 * {@link ReplicaDb} — no full-table scans (the Done-when). The sync engine (M1.3) writes through
 * the `put*`/`set*`/`enqueue*` helpers; the views read through the query helpers (usually via the
 * liveQuery hooks in `./react`).
 */

import type { AddressBook, ContactCard, Id, Identity, Mailbox, Thread } from '@waxwing/jmap'
import Dexie from 'dexie'
import { LABELS_PREF_KEY, type LabelPref } from '../mail/labels/label-model'
import { PINNED_PREF_KEY, type PinnedPref } from '../mail/pinned/pinned-model'
// `notify-model` is pure and has only type-only imports of its own, so this pulls no runtime
// dependency into the sync layer (the `label-model` / `pinned-model` precedent).
import {
  coerceNotificationPrefs,
  NOTIFY_PREF_KEY,
  type NotificationPrefs,
} from '../notify/notify-model'
import {
  type AccountRecord,
  type AddressBookRow,
  type AddressStatRow,
  type BlobMetaRow,
  type ContactCardRow,
  type ContactQueryCacheRow,
  collectBodyBlobIds,
  type DraftRow,
  type EmailBodyRow,
  type EmailEnvelopeInput,
  type EmailRow,
  estimateBlobBytes,
  estimateBodyBytes,
  type IdentityRow,
  type LocalPrefRow,
  type MailboxRow,
  type OutboxRow,
  type QueryCacheRow,
  type ReplicaDb,
  type SyncStateRow,
  scopeKey,
  type ThreadRow,
  toAddressBookRow,
  toContactCardRow,
  toEmailRow,
  toIdentityRow,
  toMailboxRow,
  toThreadRow,
} from './db'

/** One cached, evictable item — the ONLY shape the eviction planner and the usage UI ever see. */
export interface CacheItem {
  readonly id: Id
  readonly bytes: number
  readonly lastAccessedAt: number
}

// -------------------------------------------------------------------------------------------
// Accounts (registry).
// -------------------------------------------------------------------------------------------

export async function upsertAccount(db: ReplicaDb, account: AccountRecord): Promise<void> {
  await db.accounts.put(account)
}

export function listAccounts(db: ReplicaDb): Promise<AccountRecord[]> {
  return db.accounts.orderBy('addedAt').toArray()
}

export function getAccount(db: ReplicaDb, accountId: Id): Promise<AccountRecord | undefined> {
  return db.accounts.get(accountId)
}

// -------------------------------------------------------------------------------------------
// Mailboxes (M1.5 — folder tree). Counts come straight off these rows; no scan over `emails`.
// -------------------------------------------------------------------------------------------

export async function putMailboxes(
  db: ReplicaDb,
  accountId: Id,
  mailboxes: Mailbox[],
): Promise<void> {
  await db.mailboxes.bulkPut(mailboxes.map((mailbox) => toMailboxRow(accountId, mailbox)))
}

/** Every mailbox for an account, ordered by `sortOrder` then name — the tree source (assembled in memory). */
export async function mailboxesForAccount(db: ReplicaDb, accountId: Id): Promise<MailboxRow[]> {
  const rows = await db.mailboxes.where('accountId').equals(accountId).toArray()
  return rows.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
}

/** A role mailbox (`inbox`, `sent`, …) by direct index lookup (FR-MBX-01). */
export function mailboxByRole(
  db: ReplicaDb,
  accountId: Id,
  role: string,
): Promise<MailboxRow | undefined> {
  return db.mailboxes.where('[accountId+role]').equals([accountId, role]).first()
}

export function deleteMailbox(db: ReplicaDb, accountId: Id, id: Id): Promise<void> {
  return db.mailboxes.delete([accountId, id])
}

// -------------------------------------------------------------------------------------------
// Identities (M2.5 — the From selector + per-identity signatures).
// -------------------------------------------------------------------------------------------

export async function putIdentities(
  db: ReplicaDb,
  accountId: Id,
  identities: Identity[],
): Promise<void> {
  await db.identities.bulkPut(identities.map((identity) => toIdentityRow(accountId, identity)))
}

/** Every send identity for an account, ordered by name then email — the From-selector source. */
export async function identitiesForAccount(db: ReplicaDb, accountId: Id): Promise<IdentityRow[]> {
  const rows = await db.identities.where('accountId').equals(accountId).toArray()
  return rows.sort((a, b) => a.name.localeCompare(b.name) || a.email.localeCompare(b.email))
}

// -------------------------------------------------------------------------------------------
// Threads (M1.6 — conversation grouping).
// -------------------------------------------------------------------------------------------

export async function putThreads(db: ReplicaDb, accountId: Id, threads: Thread[]): Promise<void> {
  await db.threads.bulkPut(threads.map((thread) => toThreadRow(accountId, thread)))
}

export function getThread(db: ReplicaDb, accountId: Id, id: Id): Promise<ThreadRow | undefined> {
  return db.threads.get([accountId, id])
}

export function deleteThreads(db: ReplicaDb, accountId: Id, ids: Id[]): Promise<void> {
  return db.threads.bulkDelete(ids.map((id) => [accountId, id]))
}

// -------------------------------------------------------------------------------------------
// Emails (M1.6 — the hot path). The ordered list renders from a QueryCache id window; these
// helpers hydrate that window and serve membership/threading queries off indexes.
// -------------------------------------------------------------------------------------------

export async function putEmails(
  db: ReplicaDb,
  accountId: Id,
  emails: EmailEnvelopeInput[],
): Promise<void> {
  await db.emails.bulkPut(emails.map((email) => toEmailRow(accountId, email)))
}

/** How many recency-ordered rows `suggestAddresses` scans before prefix-filtering (bounded work). */
const ADDRESS_STAT_SCAN_CAP = 500

interface FoldedStat {
  email: string
  name: string | null
  sent: number
  received: number
  lastSeenAt: number
}

/**
 * Accumulate recent-correspondent stats from synced envelopes (M2.4, FR-CMP-05). `lastSeenAt` is
 * `max(receivedAt)` (monotonic → idempotent for recency); counts are additive (approximate on
 * re-sync — only relative rank matters). When `ownEmailsLower` is given, a message whose `from` is
 * the user counts as SENT (harvest to/cc) else RECEIVED (harvest from/to/cc/replyTo — `bcc` is not
 * on the stored envelope). Never throws for callers on the sync path — they wrap it best-effort.
 */
export async function recordAddressStats(
  db: ReplicaDb,
  accountId: Id,
  emails: readonly EmailEnvelopeInput[],
  ownEmailsLower?: ReadonlySet<string>,
): Promise<void> {
  const folded = new Map<string, FoldedStat>()
  for (const email of emails) {
    const receivedAt = (email.receivedAt ? Date.parse(email.receivedAt) : 0) || 0
    const isSent =
      ownEmailsLower !== undefined &&
      (email.from ?? []).some((address) => ownEmailsLower.has(address.email.toLowerCase()))
    const harvest = isSent
      ? [...(email.to ?? []), ...(email.cc ?? [])]
      : [...(email.from ?? []), ...(email.to ?? []), ...(email.cc ?? []), ...(email.replyTo ?? [])]
    for (const address of harvest) {
      const key = address.email.toLowerCase()
      if (key === '') continue
      const entry = folded.get(key) ?? {
        email: address.email,
        name: null,
        sent: 0,
        received: 0,
        lastSeenAt: 0,
      }
      if (isSent) entry.sent += 1
      else entry.received += 1
      if (receivedAt >= entry.lastSeenAt) {
        entry.lastSeenAt = receivedAt
        entry.email = address.email
      }
      if ((entry.name === null || entry.name === '') && address.name) entry.name = address.name
      folded.set(key, entry)
    }
  }
  if (folded.size === 0) return

  await db.transaction('rw', db.addressStats, async () => {
    const entries = [...folded.entries()]
    const existing = await db.addressStats.bulkGet(
      entries.map(([emailLower]) => [accountId, emailLower] as [Id, string]),
    )
    const rows: AddressStatRow[] = entries.map(([emailLower, entry], index) => {
      const prior = existing[index]
      const newer = entry.lastSeenAt >= (prior?.lastSeenAt ?? 0)
      return {
        accountId,
        emailLower,
        email: newer ? entry.email : (prior?.email ?? entry.email),
        name: entry.name ?? prior?.name ?? null,
        sentCount: (prior?.sentCount ?? 0) + entry.sent,
        receivedCount: (prior?.receivedCount ?? 0) + entry.received,
        lastSeenAt: Math.max(prior?.lastSeenAt ?? 0, entry.lastSeenAt),
      }
    })
    await db.addressStats.bulkPut(rows)
  })
}

/**
 * Recency-ordered candidate rows for a recipient-autocomplete prefix (empty prefix → most recent).
 * Ranking (frequency × recency) is applied by the compose-side source, so this stays a pure sync
 * read; it scans at most {@link ADDRESS_STAT_SCAN_CAP} recent rows before prefix-filtering.
 */
export async function suggestAddresses(
  db: ReplicaDb,
  accountId: Id,
  prefix: string,
): Promise<AddressStatRow[]> {
  const candidates = await db.addressStats
    .where('[accountId+lastSeenAt]')
    .between([accountId, Dexie.minKey], [accountId, Dexie.maxKey])
    .reverse()
    .limit(ADDRESS_STAT_SCAN_CAP)
    .toArray()
  const needle = prefix.trim().toLowerCase()
  if (needle === '') return candidates
  return candidates.filter(
    (row) =>
      row.emailLower.startsWith(needle) || (row.name?.toLowerCase().includes(needle) ?? false),
  )
}

/**
 * Hydrate a window of the list: rows for `ids` in the SAME order (server collation), with
 * `undefined` for any id not yet in the replica (rendered as a skeleton row).
 */
export function emailsByIds(
  db: ReplicaDb,
  accountId: Id,
  ids: Id[],
): Promise<(EmailRow | undefined)[]> {
  return db.emails.bulkGet(ids.map((id) => [accountId, id]))
}

/** All emails in a mailbox (offline filtering / counts) via the account-scoped membership index. */
export function emailsInMailbox(db: ReplicaDb, accountId: Id, mailboxId: Id): Promise<EmailRow[]> {
  return db.emails.where('amb').equals(scopeKey(accountId, mailboxId)).toArray()
}

/** The full id-set of a folder for "select all in folder" (FR-LST-04) — ids only, no row load. */
export async function emailIdsInMailbox(
  db: ReplicaDb,
  accountId: Id,
  mailboxId: Id,
): Promise<Id[]> {
  const keys = (await db.emails
    .where('amb')
    .equals(scopeKey(accountId, mailboxId))
    .primaryKeys()) as [Id, Id][]
  return keys.map(([, id]) => id)
}

/** Emails carrying a keyword (flagged/label views — FR-LST, M3.2) via the membership index. */
export function emailsWithKeyword(
  db: ReplicaDb,
  accountId: Id,
  keyword: string,
): Promise<EmailRow[]> {
  return db.emails.where('akw').equals(scopeKey(accountId, keyword)).toArray()
}

/**
 * The distinct keywords present on cached mail for one account (M3.2 label discovery). Reads the
 * account-scoped slice of the `akw` multiEntry index by prefix — the NUL separator in {@link scopeKey}
 * guarantees no bleed from an account id that is a string prefix of another — and strips the scope,
 * so it is a single indexed range, not a full-table scan. Reflects only the windowed replica subset.
 */
export async function distinctKeywords(db: ReplicaDb, accountId: Id): Promise<string[]> {
  const prefix = scopeKey(accountId, '')
  const keys = (await db.emails.where('akw').startsWith(prefix).uniqueKeys()) as string[]
  return keys.map((key) => key.slice(prefix.length))
}

/** Per-keyword unread (`$seen`-absent) counts over the account's cached mail (M3.2 label badges). */
export async function labelUnreadCounts(
  db: ReplicaDb,
  accountId: Id,
  keywords: readonly string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  for (const keyword of keywords) {
    const count = await db.emails
      .where('akw')
      .equals(scopeKey(accountId, keyword))
      .filter((row) => row.keywords.$seen !== true)
      .count()
    counts.set(keyword, count)
  }
  return counts
}

/** The messages of a thread, for threaded rendering and collapse (FR-LST-02). */
export function emailsInThread(db: ReplicaDb, accountId: Id, threadId: Id): Promise<EmailRow[]> {
  return db.emails.where('[accountId+threadId]').equals([accountId, threadId]).toArray()
}

/**
 * Delete envelopes AND cascade to their bodies in ONE `rw` transaction (M3.4). Before the cascade a
 * delta sync that destroyed N emails orphaned N `emailBodies` rows FOREVER — they are keyed by email
 * id, nothing else references them, and no pass ever looked at them again. Blobs are not addressed
 * by email id; their orphans are collected by the maintenance pass via the `ablob` owner index.
 */
export async function deleteEmails(db: ReplicaDb, accountId: Id, ids: Id[]): Promise<void> {
  if (ids.length === 0) return
  const keys = ids.map((id) => [accountId, id] as [Id, Id])
  await db.transaction('rw', db.emails, db.emailBodies, async () => {
    await db.emails.bulkDelete(keys)
    await db.emailBodies.bulkDelete(keys)
  })
}

/** Ids of envelopes older than `beforeIso` — primary keys only, no rows (the M3.4 prune candidates). */
export async function envelopeIdsBefore(
  db: ReplicaDb,
  accountId: Id,
  beforeIso: string,
): Promise<Id[]> {
  const keys = (await db.emails
    .where('[accountId+receivedAt]')
    .between([accountId, Dexie.minKey], [accountId, beforeIso], true, false)
    .primaryKeys()) as [Id, Id][]
  return keys.map(([, id]) => id)
}

/** How many envelopes an account holds — an index count, never a row load (M3.4 metering). */
export function envelopeCount(db: ReplicaDb, accountId: Id): Promise<number> {
  return db.emails.where('accountId').equals(accountId).count()
}

/** Every envelope id in the replica for an account — primary keys only (the M3.4 orphan check). */
export async function allEmailIds(db: ReplicaDb, accountId: Id): Promise<Id[]> {
  const keys = (await db.emails.where('accountId').equals(accountId).primaryKeys()) as [Id, Id][]
  return keys.map(([, id]) => id)
}

// -------------------------------------------------------------------------------------------
// Email bodies (M1.8 — opened messages, FR-OFF-02) with LRU bookkeeping.
// -------------------------------------------------------------------------------------------

/**
 * Store a body, deriving its accounting fields (M3.4). The derived `bytes`/`ablob` are computed HERE
 * — never by the caller — so the LRU index and the blob→owner link cannot drift out of sync with the
 * payload they describe.
 *
 * `authResults` is REQUIRED here even though `EmailBodyRow` declares it optional, and the asymmetry
 * is the point: on the ROW, `undefined` is the load-bearing signal "written before M3.9, re-fetch it"
 * (`engine.fetchBody`); on the WRITE it must never be producible, or a new writer that simply forgets
 * the field mints rows that look legacy forever and re-fetch on every open. Pass `[]` for a message
 * with no such header — which is exactly what `port.ts` already maps a missing property to.
 */
export async function putEmailBody(
  db: ReplicaDb,
  body: Omit<EmailBodyRow, 'bytes' | 'ablob'> & { authResults: string[] },
): Promise<void> {
  await db.emailBodies.put({
    ...body,
    bytes: estimateBodyBytes(body),
    ablob: collectBodyBlobIds(body).map((blobId) => scopeKey(body.accountId, blobId)),
  })
}

/** Read a cached body and stamp its `lastAccessedAt` (LRU) in the same transaction. */
export function getEmailBody(
  db: ReplicaDb,
  accountId: Id,
  id: Id,
  now: number,
): Promise<EmailBodyRow | undefined> {
  return db.transaction('rw', db.emailBodies, async () => {
    const body = await db.emailBodies.get([accountId, id])
    if (body) await db.emailBodies.update([accountId, id], { lastAccessedAt: now })
    return body
  })
}

/** Oldest-accessed body rows for an account, for LRU eviction (FR-OFF-04). */
export function lruBodies(db: ReplicaDb, accountId: Id, limit: number): Promise<EmailBodyRow[]> {
  return db.emailBodies
    .where('[accountId+lastAccessedAt]')
    .between([accountId, Dexie.minKey], [accountId, Dexie.maxKey])
    .limit(limit)
    .toArray()
}

/**
 * The full account-scoped span of a `[accountId+lastAccessedAt+bytes]` index. NUMERIC bounds, not
 * `Dexie.minKey`/`Dexie.maxKey`: both trailing components are always numbers, so ±Infinity is exactly
 * right — and `Dexie.maxKey` is ONE shared `[[]]` array instance, which a spec-conformant
 * key-conversion routine rejects when it appears twice in the same key (it looks like a cycle).
 */
function cacheKeyRange(accountId: Id): {
  lower: [Id, number, number]
  upper: [Id, number, number]
} {
  return {
    lower: [accountId, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY],
    upper: [accountId, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
  }
}

/**
 * The cached bodies as `{ id, bytes, lastAccessedAt }` — KEY-ONLY: it reads the
 * `[accountId+lastAccessedAt+bytes]` index and the matching primary keys, so a 200 MB body cache is
 * planned without deserializing one byte of mail. Both passes run in ONE `'r'` transaction (a
 * consistent snapshot) and the index cursor order is identical for `keys()` and `primaryKeys()`
 * (ties break by primary key), so zipping them by position is sound — asserted in `repo.cache.test.ts`.
 */
export function bodyCacheEntries(db: ReplicaDb, accountId: Id): Promise<CacheItem[]> {
  return db.transaction('r', db.emailBodies, async () => {
    const { lower, upper } = cacheKeyRange(accountId)
    const range = db.emailBodies
      .where('[accountId+lastAccessedAt+bytes]')
      .between(lower, upper, true, true)
    const keys = (await range.keys()) as unknown as [Id, number, number][]
    const pks = (await range.primaryKeys()) as [Id, Id][]
    return zipCacheEntries(keys, pks)
  })
}

/**
 * blobId → the ids of the cached BODIES that reference it (M3.4). Read through the `ablob` multiEntry
 * index as keys + primaryKeys, so it costs no row loads at all. A blob with no live owner is an
 * orphan; a blob owned by a protected message is protected.
 */
export function blobOwners(db: ReplicaDb, accountId: Id): Promise<Map<Id, Id[]>> {
  const prefix = scopeKey(accountId, '')
  return db.transaction('r', db.emailBodies, async () => {
    const range = db.emailBodies.where('ablob').startsWith(prefix)
    const keys = (await range.keys()) as string[]
    const pks = (await range.primaryKeys()) as [Id, Id][]
    const owners = new Map<Id, Id[]>()
    for (const [index, key] of keys.entries()) {
      const pk = pks[index]
      if (pk === undefined) continue
      const blobId = key.slice(prefix.length)
      const existing = owners.get(blobId)
      if (existing) existing.push(pk[1])
      else owners.set(blobId, [pk[1]])
    }
    return owners
  })
}

export function deleteEmailBodies(db: ReplicaDb, accountId: Id, ids: Id[]): Promise<void> {
  return db.emailBodies.bulkDelete(ids.map((id) => [accountId, id]))
}

// -------------------------------------------------------------------------------------------
// Blob metadata + cached bytes (attachments/inline images fetched on demand; M3.4 write-through).
// -------------------------------------------------------------------------------------------

/** Store a blob row, deriving its `bytes` (M3.4) — same invariant as {@link putEmailBody}. */
export async function putBlobMeta(db: ReplicaDb, blob: Omit<BlobMetaRow, 'bytes'>): Promise<void> {
  await db.blobsMeta.put({ ...blob, bytes: estimateBlobBytes(blob) })
}

export function getBlobMeta(
  db: ReplicaDb,
  accountId: Id,
  blobId: Id,
): Promise<BlobMetaRow | undefined> {
  return db.blobsMeta.get([accountId, blobId])
}

/** Stamp a cached blob's `lastAccessedAt` (LRU touch on read) — mirrors {@link getEmailBody}. */
export async function touchBlob(
  db: ReplicaDb,
  accountId: Id,
  blobId: Id,
  now: number,
): Promise<void> {
  await db.blobsMeta.update([accountId, blobId], { lastAccessedAt: now })
}

/** The cached blobs as `{ id, bytes, lastAccessedAt }` — key-only, see {@link bodyCacheEntries}. */
export function blobCacheEntries(db: ReplicaDb, accountId: Id): Promise<CacheItem[]> {
  return db.transaction('r', db.blobsMeta, async () => {
    const { lower, upper } = cacheKeyRange(accountId)
    const range = db.blobsMeta
      .where('[accountId+lastAccessedAt+bytes]')
      .between(lower, upper, true, true)
    const keys = (await range.keys()) as unknown as [Id, number, number][]
    const pks = (await range.primaryKeys()) as [Id, Id][]
    return zipCacheEntries(keys, pks)
  })
}

export function deleteBlobs(db: ReplicaDb, accountId: Id, blobIds: Id[]): Promise<void> {
  return db.blobsMeta.bulkDelete(blobIds.map((blobId) => [accountId, blobId]))
}

/** Zip an `[accountId+lastAccessedAt+bytes]` key cursor with its primary keys (same cursor order). */
function zipCacheEntries(
  keys: readonly [Id, number, number][],
  pks: readonly [Id, Id][],
): CacheItem[] {
  const items: CacheItem[] = []
  for (const [index, key] of keys.entries()) {
    const pk = pks[index]
    if (pk === undefined) continue
    items.push({ id: pk[1], lastAccessedAt: key[1], bytes: key[2] })
  }
  return items
}

// -------------------------------------------------------------------------------------------
// Sync state (per account+objectType JMAP state string).
// -------------------------------------------------------------------------------------------

export async function getSyncState(
  db: ReplicaDb,
  accountId: Id,
  type: string,
): Promise<string | null> {
  const row = await db.syncState.get([accountId, type])
  return row?.state ?? null
}

export async function setSyncState(
  db: ReplicaDb,
  accountId: Id,
  type: string,
  state: string | null,
  now: number,
): Promise<void> {
  const row: SyncStateRow = { accountId, type, state, updatedAt: now }
  await db.syncState.put(row)
}

// -------------------------------------------------------------------------------------------
// Query cache (watched Email/query windows — M1.6 list source).
// -------------------------------------------------------------------------------------------

export async function putQueryCache(db: ReplicaDb, row: QueryCacheRow): Promise<void> {
  await db.queryCache.put(row)
}

export function getQueryCache(
  db: ReplicaDb,
  accountId: Id,
  key: string,
): Promise<QueryCacheRow | undefined> {
  return db.queryCache.get([accountId, key])
}

/** Every watched window for an account (M3.4: the reap candidates + the "still referenced" id source). */
export function queryCacheRows(db: ReplicaDb, accountId: Id): Promise<QueryCacheRow[]> {
  return db.queryCache.where('accountId').equals(accountId).toArray()
}

export function deleteQueryCacheRows(db: ReplicaDb, accountId: Id, keys: string[]): Promise<void> {
  return db.queryCache.bulkDelete(keys.map((key) => [accountId, key]))
}

// -------------------------------------------------------------------------------------------
// Outbox (M1.3 replay, M3.3 durability/conflicts).
// -------------------------------------------------------------------------------------------

export async function enqueue(db: ReplicaDb, row: OutboxRow): Promise<void> {
  await db.outbox.put(row)
}

/**
 * The LIVE queue for an account in FIFO (createdAt) order — `pending` + `inflight` (M1.3 replay
 * source, and the `pendingActions` count). A terminal `error` row is a DEAD LETTER and is
 * deliberately NOT returned (M3.3, defect D4): counting it here permanently inflated
 * `EngineStatus.pendingActions` and made replay re-scan rows it can never send. Dead letters are
 * {@link failedOutbox} — surfaced, retryable and discardable, never silently retried.
 */
export function pendingOutbox(db: ReplicaDb, accountId: Id): Promise<OutboxRow[]> {
  return db.outbox
    .where('[accountId+createdAt]')
    .between([accountId, Dexie.minKey], [accountId, Dexie.maxKey])
    .filter((row) => row.status === 'pending' || row.status === 'inflight')
    .toArray()
}

/**
 * The queue rows that have provably NEVER BEEN DISPATCHED — `status === 'pending'` **and**
 * `attempts === 0`, FIFO.
 *
 * WHY THE SECOND CONJUNCT EXISTS. This function used to filter on `status === 'pending'` alone,
 * justified by "a `pending` row has by definition never been dispatched". **That was false.** In
 * this state machine `pending` means "not currently dispatched", not "never dispatched": FOUR
 * paths in `outbox.ts` launder an ALREADY-DISPATCHED row back to `pending`, and every one of them
 * carries `move`/`setKeywords`/`destroyEmails` — exactly the three intents that move a count. (This
 * list said THREE until the fourth was found; it had been missed because it is the only one not
 * reached from a thrown error.)
 *
 *  1. `recoverStranded` — a leader killed mid-request leaves the row `inflight`; recovery puts every
 *     non-`sendEmail` row back to `pending` to be re-sent.
 *  2. The TRANSIENT retry branch — a THROWN error leaves it UNKNOWN whether the request reached the
 *     server (the response may simply have been lost), and the row goes back to `pending`.
 *  3. Auth expiry — a 401/403 puts the row back to `pending` and re-throws to the re-auth funnel.
 *  4. The per-object `rateLimit` retry — a `SetError` on SOME objects backs the WHOLE row off to
 *     `pending` for a later re-execute. This is the LEAST AMBIGUOUS of the four and the one whose
 *     exclusion needs no hedging: a per-object `SetError` means the server ANSWERED, so the request
 *     provably arrived and was processed — and in a bulk intent the objects that were NOT rate-
 *     limited WERE applied, so part of this row's delta is certainly already in the server's number.
 *     Paths 2 and 3 rest on "may have been processed"; this one rests on "was".
 *
 * All four now INCREMENT `attempts`, which is true independently of this predicate (each of those
 * rows genuinely was attempted) and is what makes `attempts === 0` mean "never dispatched".
 *
 * WHY IT MUST FAIL CLOSED, i.e. why the doubt is resolved by SKIPPING. The two errors are not
 * symmetric. A missed re-apply self-corrects: the badge reverts to the server's number until the
 * intent lands, and sending it makes the server re-report the mailbox. A double-count does NOT
 * self-correct: the mailbox is only re-reported when it changes AGAIN, so a ±1 added on top of a
 * server number that already contains it can sit there indefinitely. When in doubt, skip.
 *
 * `inflight` is excluded for the same reason and remains a residual, accepted gap: an inflight
 * intent's count patch still reverts if a pass overwrites its mailbox, bounded by one intent and
 * erased by the next `Mailbox/changes` that reports it.
 *
 * NOT excluded, deliberately: a row requeued by `SyncEngine.retryFailed`, which resets `attempts`
 * to 0. That reset is honest here, because every dead-letter a retry can reach is one the server
 * ANSWERED — a per-object `SetError`, or a method-level error (`forbidden`, `invalid`,
 * `stateConflict`). A transport failure or a lost response classifies as `retry`, never as a
 * dead-letter, so a retryable row's mutation provably did not land. (`sendInterrupted` is the one
 * ambiguous dead-letter, and `retryFailed` refuses `sendEmail` outright — which moves no count
 * anyway.)
 *
 * THE ENUMERATION IS CLOSED, re-derived rather than trusted (it has been found incomplete twice).
 * Every write that can put an outbox row into `pending` is one of six: `enqueueAction` (row
 * creation, `attempts: 0` — the honest case this predicate is FOR), the four laundering paths above,
 * and `SyncEngine.retryFailed`. Nothing else reaches the table: `repo.ts#enqueue` is the only
 * `db.outbox.put`, and `enqueueAction` is its only caller; every other writer is a
 * `db.outbox.update`, and the ones naming `status` set `inflight` or `error`.
 */
export function unsentOutbox(db: ReplicaDb, accountId: Id): Promise<OutboxRow[]> {
  return db.outbox
    .where('[accountId+createdAt]')
    .between([accountId, Dexie.minKey], [accountId, Dexie.maxKey])
    .filter((row) => row.status === 'pending' && row.attempts === 0)
    .toArray()
}

/** Dead-lettered intents (`status: 'error'`), oldest first — the conflict/problems surface (M3.3). */
export async function failedOutbox(db: ReplicaDb, accountId: Id): Promise<OutboxRow[]> {
  const rows = await db.outbox.where('[accountId+status]').equals([accountId, 'error']).toArray()
  return rows.sort((a, b) => a.createdAt - b.createdAt)
}

/** Queued (not yet dispatched) sends, oldest first — the durable "will send" surface (M3.3). */
export async function queuedSends(db: ReplicaDb, accountId: Id): Promise<OutboxRow[]> {
  const rows = await db.outbox.where('[accountId+status]').equals([accountId, 'pending']).toArray()
  return rows.filter((row) => row.type === 'sendEmail').sort((a, b) => a.createdAt - b.createdAt)
}

/** One outbox row by its client-generated intent id. */
export function outboxRow(db: ReplicaDb, accountId: Id, id: Id): Promise<OutboxRow | undefined> {
  return db.outbox.get([accountId, id])
}

// -------------------------------------------------------------------------------------------
// Local preferences (FR-MBX-04 — collapsed tree, per-folder prefs, allowlists).
// -------------------------------------------------------------------------------------------

export async function getPref<T>(
  db: ReplicaDb,
  accountId: Id,
  key: string,
): Promise<T | undefined> {
  const row = await db.localPrefs.get([accountId, key])
  return row?.value as T | undefined
}

export async function setPref(
  db: ReplicaDb,
  accountId: Id,
  key: string,
  value: unknown,
): Promise<void> {
  const row: LocalPrefRow = { accountId, key, value }
  await db.localPrefs.put(row)
}

/**
 * Read-modify-write the label registry (M3.2) inside a single Dexie `rw` transaction so concurrent
 * tabs cannot lose an update (a blind `setPref` would clobber a sibling tab's change). `fn` receives
 * the current registry (empty when unset) and returns the next one.
 */
export async function updateLabels(
  db: ReplicaDb,
  accountId: Id,
  fn: (current: LabelPref[]) => LabelPref[],
): Promise<void> {
  await db.transaction('rw', db.localPrefs, async () => {
    const row = await db.localPrefs.get([accountId, LABELS_PREF_KEY])
    const current = (row?.value as LabelPref[] | undefined) ?? []
    const next = fn(current)
    await db.localPrefs.put({ accountId, key: LABELS_PREF_KEY, value: next })
  })
}

/**
 * The command palette's recent-action list (M3.8) — a most-recent-first array of palette item ids.
 * Unlike the label/pinned/notify keys this one has no feature model of its own to live in: the
 * palette's model is two pure functions in a LAZY chunk, and pulling that chunk into the eager sync
 * layer just to name a string would defeat the split.
 */
export const PALETTE_RECENTS_KEY = 'palette.recents'

/** Read-modify-write the palette's recents (M3.8) — same cross-tab-safe shape as {@link updateLabels}. */
export async function updatePaletteRecents(
  db: ReplicaDb,
  accountId: Id,
  fn: (current: string[]) => string[],
): Promise<void> {
  await db.transaction('rw', db.localPrefs, async () => {
    const row = await db.localPrefs.get([accountId, PALETTE_RECENTS_KEY])
    const stored = row?.value
    const current = Array.isArray(stored)
      ? stored.filter((entry): entry is string => typeof entry === 'string')
      : []
    await db.localPrefs.put({ accountId, key: PALETTE_RECENTS_KEY, value: fn(current) })
  })
}

/** Read-modify-write the "keep offline" pin set (M3.4) — same cross-tab-safe shape as {@link updateLabels}. */
export async function updatePinnedMailboxes(
  db: ReplicaDb,
  accountId: Id,
  fn: (current: PinnedPref) => PinnedPref,
): Promise<void> {
  await db.transaction('rw', db.localPrefs, async () => {
    const row = await db.localPrefs.get([accountId, PINNED_PREF_KEY])
    const current = (row?.value as PinnedPref | undefined) ?? []
    await db.localPrefs.put({ accountId, key: PINNED_PREF_KEY, value: fn(current) })
  })
}

/**
 * Read-modify-write the notification preferences (M3.6) — same cross-tab-safe shape as
 * {@link updateLabels}. The settings screen writes one field at a time (the master switch, a folder
 * checkbox, a quiet-hours time), and a blind `setPref` of the whole object would let a second tab's
 * write clobber the first's.
 */
export async function updateNotificationPrefs(
  db: ReplicaDb,
  accountId: Id,
  fn: (current: NotificationPrefs) => NotificationPrefs,
): Promise<void> {
  await db.transaction('rw', db.localPrefs, async () => {
    const row = await db.localPrefs.get([accountId, NOTIFY_PREF_KEY])
    const next = fn(coerceNotificationPrefs(row?.value))
    await db.localPrefs.put({ accountId, key: NOTIFY_PREF_KEY, value: next })
  })
}

/**
 * Epoch-ms of the newest `receivedAt` the replica holds for this account, or `null` when it holds no
 * mail at all.
 *
 * The point is that this is a timestamp in the SERVER's units. M3.6's notification floor is stamped
 * from the client clock, and a client whose clock runs ahead would otherwise place that floor in the
 * server's future and silence every notification (see `engine.ts#anchorNotifyFloor`). Reads the
 * `[accountId+receivedAt]` index — `receivedAt` is an ISO-8601 UTC string, so its lexicographic order
 * IS its chronological order, and the newest row is simply the last key.
 */
export async function newestReceivedAt(db: ReplicaDb, accountId: Id): Promise<number | null> {
  const newest = await db.emails
    .where('[accountId+receivedAt]')
    .between([accountId, Dexie.minKey], [accountId, Dexie.maxKey])
    .last()
  if (newest === undefined) return null
  const parsed = Date.parse(newest.receivedAt)
  return Number.isNaN(parsed) ? null : parsed
}

/** The pinned ("keep offline") mailbox ids — the engine reads this directly on every pass. */
export async function pinnedMailboxes(db: ReplicaDb, accountId: Id): Promise<Id[]> {
  const row = await db.localPrefs.get([accountId, PINNED_PREF_KEY])
  const value = row?.value as PinnedPref | undefined
  return Array.isArray(value) ? value.filter((id) => typeof id === 'string') : []
}

// ---------------------------------------------------------------------------------------------
// Drafts (M2.6, FR-CMP-03) — crash-safe local edit-state.
// ---------------------------------------------------------------------------------------------

export async function putDraft(db: ReplicaDb, row: DraftRow): Promise<void> {
  await db.drafts.put(row)
}

export function getDraft(
  db: ReplicaDb,
  accountId: Id,
  localId: string,
): Promise<DraftRow | undefined> {
  return db.drafts.get([accountId, localId])
}

/** Find the local draft that mirrors a given Drafts-mailbox `Email` id (open-from-Drafts). */
export function getDraftByServerId(
  db: ReplicaDb,
  accountId: Id,
  serverEmailId: Id,
): Promise<DraftRow | undefined> {
  return db.drafts.where('[accountId+serverEmailId]').equals([accountId, serverEmailId]).first()
}

/** All local drafts for an account, most-recently-edited first (the crash-restore list). */
export function listDrafts(db: ReplicaDb, accountId: Id): Promise<DraftRow[]> {
  return db.drafts
    .where('[accountId+updatedAt]')
    .between([accountId, Dexie.minKey], [accountId, Dexie.maxKey])
    .reverse()
    .toArray()
}

export function deleteDraft(db: ReplicaDb, accountId: Id, localId: string): Promise<void> {
  return db.drafts.delete([accountId, localId])
}

// ---------------------------------------------------------------------------------------------
// Contacts (M4.2, RFC 9610). Address books mirror the folder-tree pattern (fetched whole, sorted in
// memory); contact cards mirror the email pattern (the ordered list renders from a query-cache id
// window, membership queries served off the `abk` multiEntry index).
// ---------------------------------------------------------------------------------------------

export async function putAddressBooks(
  db: ReplicaDb,
  accountId: Id,
  books: AddressBook[],
): Promise<void> {
  await db.addressBooks.bulkPut(books.map((book) => toAddressBookRow(accountId, book)))
}

/** Every address book for an account, ordered by `sortOrder` then name — the tree source (M4.2). */
export async function addressBooksForAccount(
  db: ReplicaDb,
  accountId: Id,
): Promise<AddressBookRow[]> {
  const rows = await db.addressBooks.where('accountId').equals(accountId).toArray()
  return rows.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
}

export function deleteAddressBooks(db: ReplicaDb, accountId: Id, ids: Id[]): Promise<void> {
  return db.addressBooks.bulkDelete(ids.map((id) => [accountId, id]))
}

export async function putContactCards(
  db: ReplicaDb,
  accountId: Id,
  cards: ContactCard[],
): Promise<void> {
  await db.contactCards.bulkPut(cards.map((card) => toContactCardRow(accountId, card)))
}

/**
 * Hydrate a window of the contact list: rows for `ids` in the SAME order (server collation), with
 * `undefined` for any id not yet in the replica (rendered as a skeleton row) — mirrors {@link emailsByIds}.
 */
export function contactCardsByIds(
  db: ReplicaDb,
  accountId: Id,
  ids: Id[],
): Promise<(ContactCardRow | undefined)[]> {
  return db.contactCards.bulkGet(ids.map((id) => [accountId, id]))
}

/** All cards in an address book (offline filtering / counts) via the account-scoped membership index. */
export function contactCardsInBook(
  db: ReplicaDb,
  accountId: Id,
  bookId: Id,
): Promise<ContactCardRow[]> {
  return db.contactCards.where('abk').equals(scopeKey(accountId, bookId)).toArray()
}

export function deleteContactCards(db: ReplicaDb, accountId: Id, ids: Id[]): Promise<void> {
  return db.contactCards.bulkDelete(ids.map((id) => [accountId, id]))
}

// Contact query cache (watched ContactCard/query windows — the list source; mirrors `queryCache`).

export async function putContactQueryCache(
  db: ReplicaDb,
  row: ContactQueryCacheRow,
): Promise<void> {
  await db.contactQueryCache.put(row)
}

export function getContactQueryCache(
  db: ReplicaDb,
  accountId: Id,
  key: string,
): Promise<ContactQueryCacheRow | undefined> {
  return db.contactQueryCache.get([accountId, key])
}
