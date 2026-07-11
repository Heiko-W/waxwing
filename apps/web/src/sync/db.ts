/**
 * Local replica schema (M1.2, FR-OFF-02 basis, FR-AUTH-07 account-scoping, tech-stack §4.3).
 *
 * Waxwing is local-first: the UI never renders from network responses directly. The sync
 * engine (M1.3) maintains a partial replica of server state in this Dexie/IndexedDB database
 * keyed by JMAP state strings, and the UI subscribes to it via liveQuery. This module owns the
 * SCHEMA only — the row shapes, the account-scoped indexes, the JMAP→row mappers, and open/wipe.
 * Sync (delta fetch, outbox replay) and the list/tree views are layered on in M1.3 / M1.5 / M1.6.
 *
 * ## Account scoping (ADR-008, precedent ADR-004)
 * Every data table carries an `accountId` and is keyed `[accountId+id]` so a second account is
 * purely additive (FR-AUTH-07: "the data layer must be account-scoped from day one"). Unlike the
 * auth {@link SecretStore} — which uses a *separate encrypted database per account* (ADR-004)
 * because it holds secrets — the replica is a non-sensitive cache with an `accounts` registry, so
 * a single shared `waxwing-replica` database with compound keys is the better fit (ADR-008).
 * Per-account eviction is {@link clearAccount}; a full wipe (FR-AUTH-05) is {@link wipeReplica}.
 *
 * ## Multi-valued membership indexes
 * JMAP emails belong to many mailboxes (`mailboxIds`) and carry many `keywords`; IndexedDB has no
 * compound-multiEntry index, so folder/keyword membership is indexed via two derived multiEntry
 * arrays whose values embed the account id — `amb` = `"<accountId>\0<mailboxId>"`, `akw` =
 * `"<accountId>\0<keyword>"` — kept in sync by {@link toEmailRow}. That keeps "emails in mailbox X
 * for account A" a single indexed range with no cross-account bleed. The *ordered* list itself
 * (respecting the server's collation) comes from {@link QueryCacheRow.ids}, not a local re-sort.
 *
 * ## Migration policy
 * The `version()` chain is append-only and never destructive: bump to the next integer and add a
 * new `.stores({...})` (with a `.upgrade()` for any data transform) — never rename a store or drop
 * data in place. A store listed again in a later version with a changed index set migrates its
 * indexes automatically; omit a store entirely only to delete it deliberately. Because the replica
 * is a rebuildable cache, a breaking change may alternatively bump the DB *name* and let the old
 * database be garbage-collected, but that is a last resort — prefer an additive version bump.
 */

import type {
  EmailAddress,
  EmailBodyPart,
  EmailBodyValue,
  EmailComparator,
  EmailFilter,
  Id,
  Mailbox,
  MailboxRights,
  Thread,
} from '@waxwing/jmap'
import Dexie, { type Table } from 'dexie'

/** The shared replica database name; mirrors the `waxwing-auth` convention (ADR-004/ADR-008). */
export const REPLICA_DB_NAME = 'waxwing-replica'

/**
 * Separates the account id from the value inside the derived membership index arrays. NUL (`\0`)
 * is safe: JMAP ids and keywords are restricted charsets that never contain a control character.
 */
const SCOPE_SEP = '\u0000'

/** Build an account-scoped composite index value (see the multi-valued membership note above). */
export function scopeKey(accountId: Id, value: string): string {
  return `${accountId}${SCOPE_SEP}${value}`
}

// ---------------------------------------------------------------------------------------------
// Row shapes — the stored records. JMAP objects are mirrored field-for-field; each row adds an
// `accountId` and, where an index needs it, derived helper fields. The index (envelope) tables
// stay lean: heavy bodies live in `emailBodies`, not `emails`.
// ---------------------------------------------------------------------------------------------

/** Registry of known accounts — the only table keyed by the bare account id (it *is* the scope). */
export interface AccountRecord {
  /** JMAP `session.primaryAccounts['urn:ietf:params:jmap:mail']`. */
  id: Id
  username: string
  name: string | null
  /** OAuth issuer / server origin, for the account switcher (FR-AUTH-07); null for Basic. */
  issuer: string | null
  /** The single V1 account; the first-added account until multi-account lands. */
  isPrimary: boolean
  addedAt: number
  lastSeenAt: number
}

/** RFC 8621 Mailbox mirror (folder tree — M1.5). */
export interface MailboxRow {
  accountId: Id
  id: Id
  name: string
  parentId: Id | null
  /** IANA role (`inbox`, `sent`, …), lower-cased; null for custom folders. */
  role: string | null
  sortOrder: number
  totalEmails: number
  unreadEmails: number
  totalThreads: number
  unreadThreads: number
  myRights: MailboxRights
  isSubscribed: boolean
}

/** RFC 8621 Thread mirror (conversation grouping — M1.6). */
export interface ThreadRow {
  accountId: Id
  id: Id
  /** Ordered oldest-first (RFC 8621 §3). */
  emailIds: Id[]
}

/** The subset of a JMAP `Email` the envelope/index row needs (a `/get` returns only requested props). */
export interface EmailEnvelopeInput {
  id: Id
  blobId: Id
  threadId: Id
  mailboxIds: Record<Id, true>
  keywords: Record<string, true>
  size: number
  receivedAt: string
  sentAt: string | null
  from: EmailAddress[] | null
  to: EmailAddress[] | null
  cc: EmailAddress[] | null
  replyTo: EmailAddress[] | null
  subject: string | null
  /** RFC 5322 threading headers (M2.3) — for reply/forward derivation. Non-indexed. */
  messageId: string[] | null
  inReplyTo: string[] | null
  references: string[] | null
  preview: string
  hasAttachment: boolean
}

/** Lean email envelope row for the virtualized list (M1.6, FR-LST-03); bodies live separately. */
export interface EmailRow extends EmailEnvelopeInput {
  accountId: Id
  /** Derived, account-scoped mailbox membership: `["<accountId>\0<mailboxId>", …]` (multiEntry). */
  amb: string[]
  /** Derived, account-scoped keyword membership: `["<accountId>\0<keyword>", …]` (multiEntry). */
  akw: string[]
}

/** Full body + structure for an opened message (M1.8, FR-OFF-02); LRU-evicted via `lastAccessedAt`. */
export interface EmailBodyRow {
  accountId: Id
  id: Id
  bodyValues: Record<string, EmailBodyValue>
  bodyStructure: EmailBodyPart
  textBody: EmailBodyPart[]
  htmlBody: EmailBodyPart[]
  attachments: EmailBodyPart[]
  hasAttachment: boolean
  fetchedAt: number
  lastAccessedAt: number
}

/** Metadata (and optionally cached bytes) for a blob fetched on demand; LRU-evicted. */
export interface BlobMetaRow {
  accountId: Id
  blobId: Id
  type: string | null
  size: number | null
  name: string | null
  /** Cached bytes when downloaded (attachments/inline images); null = metadata only. */
  data: Blob | null
  fetchedAt: number
  lastAccessedAt: number
}

/** Per account+objectType JMAP state string — the replica's "keyed by JMAP state strings" spine. */
export interface SyncStateRow {
  accountId: Id
  /** JMAP data type: `Mailbox` | `Thread` | `Email` | … */
  type: string
  state: string | null
  updatedAt: number
}

/** A watched `Email/query`: canonical key → the server-ordered id window + its queryState cursor. */
export interface QueryCacheRow {
  accountId: Id
  /** {@link canonicalQueryKey} of `{filter, sort, collapseThreads}`. */
  key: string
  /** Server-ordered ids (respecting the query's collation); the list renders from this order. */
  ids: Id[]
  queryState: string | null
  total: number | null
  /** Oldest id currently held — the backfill/"load more" window cursor (M1.3/M1.6). */
  upToId: Id | null
  filter: EmailFilter | null
  sort: EmailComparator[] | null
  collapseThreads: boolean
  lastUsedAt: number
}

export type OutboxStatus = 'pending' | 'inflight' | 'error' | 'done'

/**
 * An idempotent JMAP `set` intent (FR-OFF-03). M1.2 defines the row; the replay engine, the
 * optimistic apply/rollback and `ifInState` conflict handling are M1.3 (online) / M3.3 (offline).
 */
export interface OutboxRow {
  accountId: Id
  /** Client-generated intent/creation id (stable across retries). */
  id: Id
  /** `setKeywords` | `move` | `destroy` | `mailbox/set` | … (typed per action in M1.3). */
  type: string
  payload: unknown
  ifInState: string | null
  status: OutboxStatus
  attempts: number
  createdAt: number
  lastError: string | null
}

/** Local-only per-account preference (collapsed tree state, per-folder prefs, allowlists — FR-MBX-04). */
export interface LocalPrefRow {
  accountId: Id
  key: string
  value: unknown
}

/**
 * Recent-correspondent accumulation (M2.4, FR-CMP-05) — the recents autocomplete source. Harvested
 * from synced envelopes; `lastSeenAt` (max receivedAt ms) is monotonic so re-syncs stay idempotent
 * for recency, while the counts are approximate (may drift up on re-sync) — only relative rank matters.
 */
export interface AddressStatRow {
  accountId: Id
  /** Identity/key half — lowercased email. */
  emailLower: string
  /** Best display casing (most-recent sighting). */
  email: string
  /** Best-known display name. */
  name: string | null
  sentCount: number
  receivedCount: number
  lastSeenAt: number
}

// ---------------------------------------------------------------------------------------------
// The database.
// ---------------------------------------------------------------------------------------------

export class ReplicaDb extends Dexie {
  accounts!: Table<AccountRecord, Id>
  mailboxes!: Table<MailboxRow, [Id, Id]>
  threads!: Table<ThreadRow, [Id, Id]>
  emails!: Table<EmailRow, [Id, Id]>
  emailBodies!: Table<EmailBodyRow, [Id, Id]>
  blobsMeta!: Table<BlobMetaRow, [Id, Id]>
  syncState!: Table<SyncStateRow, [Id, string]>
  queryCache!: Table<QueryCacheRow, [Id, string]>
  outbox!: Table<OutboxRow, [Id, Id]>
  localPrefs!: Table<LocalPrefRow, [Id, string]>
  addressStats!: Table<AddressStatRow, [Id, string]>

  constructor(name: string = REPLICA_DB_NAME) {
    super(name)
    // v1 — see the migration policy in the module header before changing any line here.
    this.version(1).stores({
      accounts: 'id, addedAt',
      mailboxes: '[accountId+id], accountId, [accountId+role]',
      threads: '[accountId+id], accountId',
      emails: '[accountId+id], accountId, [accountId+threadId], [accountId+receivedAt], *amb, *akw',
      emailBodies: '[accountId+id], accountId, [accountId+lastAccessedAt]',
      blobsMeta: '[accountId+blobId], accountId, [accountId+lastAccessedAt]',
      syncState: '[accountId+type], accountId',
      queryCache: '[accountId+key], accountId, [accountId+lastUsedAt]',
      outbox: '[accountId+id], accountId, [accountId+createdAt], [accountId+status]',
      localPrefs: '[accountId+key], accountId',
    })
    // v2 (M2.4) — additive: the new addressStats store only. A brand-new store needs no `.upgrade()`
    // (no data transform); Dexie carries every unspecified store forward unchanged.
    this.version(2).stores({
      addressStats: '[accountId+emailLower], accountId, [accountId+lastSeenAt]',
    })
  }
}

/** Lazily-opened shared instance for the app and the M1.3 sync engine (tests construct their own). */
let sharedDb: ReplicaDb | undefined
export function getReplica(): ReplicaDb {
  if (!sharedDb) sharedDb = new ReplicaDb()
  return sharedDb
}

// ---------------------------------------------------------------------------------------------
// JMAP → row mappers.
// ---------------------------------------------------------------------------------------------

/** Map a JMAP email envelope to its stored row, computing the account-scoped membership indexes. */
export function toEmailRow(accountId: Id, email: EmailEnvelopeInput): EmailRow {
  const mailboxIds = email.mailboxIds ?? {}
  const keywords = email.keywords ?? {}
  return {
    ...email,
    accountId,
    mailboxIds,
    keywords,
    amb: Object.keys(mailboxIds).map((mailboxId) => scopeKey(accountId, mailboxId)),
    akw: Object.keys(keywords).map((keyword) => scopeKey(accountId, keyword)),
  }
}

/** Map a JMAP mailbox to its stored row. */
export function toMailboxRow(accountId: Id, mailbox: Mailbox): MailboxRow {
  return { ...mailbox, accountId }
}

/** Map a JMAP thread to its stored row. */
export function toThreadRow(accountId: Id, thread: Thread): ThreadRow {
  return { accountId, id: thread.id, emailIds: thread.emailIds }
}

// ---------------------------------------------------------------------------------------------
// Wipe / eviction (FR-AUTH-05, FR-AUTH-07).
// ---------------------------------------------------------------------------------------------

/**
 * Remove every row belonging to one account (FR-AUTH-07 per-account logout) without touching the
 * others — the shared-database analogue of ADR-004's per-account `deleteDatabase`.
 */
export async function clearAccount(db: ReplicaDb, accountId: Id): Promise<void> {
  await db.transaction('rw', db.tables, async () => {
    for (const table of db.tables) {
      if (table.name === 'accounts') continue
      await table.where('accountId').equals(accountId).delete()
    }
    await db.accounts.delete(accountId)
  })
}

/**
 * Destroy the entire replica (FR-AUTH-05 "Sign out & remove data"). The instance is closed
 * afterwards; callers reopen via {@link getReplica}/`new ReplicaDb`. The M1.3 sign-out path must
 * call this alongside the auth wipe once the engine populates the replica.
 */
export async function wipeReplica(db: ReplicaDb): Promise<void> {
  await db.delete()
  // Drop the cached shared handle if it was the one wiped, so getReplica() rebuilds a fresh one
  // instead of reusing a deleted instance.
  if (db === sharedDb) sharedDb = undefined
}
