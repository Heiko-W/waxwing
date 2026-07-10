/**
 * Repository layer (M1.2): the indexed CRUD + read paths the folder tree (M1.5) and the message
 * list (M1.6) need. Every function is account-scoped and served by an index declared in
 * {@link ReplicaDb} — no full-table scans (the Done-when). The sync engine (M1.3) writes through
 * the `put*`/`set*`/`enqueue*` helpers; the views read through the query helpers (usually via the
 * liveQuery hooks in `./react`).
 */

import type { Id, Mailbox, Thread } from '@waxwing/jmap'
import Dexie from 'dexie'
import {
  type AccountRecord,
  type BlobMetaRow,
  type EmailBodyRow,
  type EmailEnvelopeInput,
  type EmailRow,
  type LocalPrefRow,
  type MailboxRow,
  type OutboxRow,
  type QueryCacheRow,
  type ReplicaDb,
  type SyncStateRow,
  scopeKey,
  type ThreadRow,
  toEmailRow,
  toMailboxRow,
  toThreadRow,
} from './db'

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

/** The messages of a thread, for threaded rendering and collapse (FR-LST-02). */
export function emailsInThread(db: ReplicaDb, accountId: Id, threadId: Id): Promise<EmailRow[]> {
  return db.emails.where('[accountId+threadId]').equals([accountId, threadId]).toArray()
}

export function deleteEmails(db: ReplicaDb, accountId: Id, ids: Id[]): Promise<void> {
  return db.emails.bulkDelete(ids.map((id) => [accountId, id]))
}

// -------------------------------------------------------------------------------------------
// Email bodies (M1.8 — opened messages, FR-OFF-02) with LRU bookkeeping.
// -------------------------------------------------------------------------------------------

export async function putEmailBody(db: ReplicaDb, body: EmailBodyRow): Promise<void> {
  await db.emailBodies.put(body)
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

// -------------------------------------------------------------------------------------------
// Blob metadata (attachments/inline images fetched on demand).
// -------------------------------------------------------------------------------------------

export async function putBlobMeta(db: ReplicaDb, blob: BlobMetaRow): Promise<void> {
  await db.blobsMeta.put(blob)
}

export function getBlobMeta(
  db: ReplicaDb,
  accountId: Id,
  blobId: Id,
): Promise<BlobMetaRow | undefined> {
  return db.blobsMeta.get([accountId, blobId])
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

// -------------------------------------------------------------------------------------------
// Outbox (schema-level; replay is M1.3 / M3.3).
// -------------------------------------------------------------------------------------------

export async function enqueue(db: ReplicaDb, row: OutboxRow): Promise<void> {
  await db.outbox.put(row)
}

/** Pending/errored intents for an account in FIFO (createdAt) order — the replay queue (M1.3). */
export function pendingOutbox(db: ReplicaDb, accountId: Id): Promise<OutboxRow[]> {
  return db.outbox
    .where('[accountId+createdAt]')
    .between([accountId, Dexie.minKey], [accountId, Dexie.maxKey])
    .filter((row) => row.status === 'pending' || row.status === 'error')
    .toArray()
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
