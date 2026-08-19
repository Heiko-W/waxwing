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
 *
 * A purely ADDITIVE, NON-INDEXED, OPTIONAL row field needs **no** version bump: Dexie's schema
 * declares indexes, not value shapes, so a new field simply appears on rows written from now on and
 * reads as `undefined` on legacy rows (every reader must tolerate that). Precedent: `DraftRow.
 * errorKind` (M2.8) and `OutboxRow.undo`/`conflict`/`nextAttemptAt`/`refreshes` (M3.3) — all served
 * by the existing `[accountId+status]` / `[accountId+createdAt]` indexes. Bump the version only when
 * an INDEX changes or stored data must be transformed.
 *
 * An INDEXED field is NOT exempt from a version bump (precedent: `EmailBodyRow.bytes` /
 * `BlobMetaRow.bytes`, M3.4): IndexedDB omits a record that LACKS the index's key path from that
 * index ENTIRELY, so legacy rows would be silently invisible to every query served by it — here,
 * both cache metering and LRU eviction. Adding an index therefore always means "the stored data must
 * be transformed": bump the version and backfill the field in `.upgrade()`.
 *
 * **An `.upgrade()` callback must be TOTAL — it may never throw.** A throw inside `modify()` aborts
 * the upgrade transaction, so `db.open()` rejects; and since the version is fixed in the code, it
 * rejects again on every subsequent start. Nothing in the app rebuilds the replica when that happens,
 * so a single malformed legacy row would leave the user with an app that never loads again. Derive
 * defensively (a wrong byte estimate is a rounding error) and wrap each row transform in a try/catch.
 */

import type {
  AddressBook,
  ContactCard,
  ContactCardComparator,
  ContactCardFilter,
  EmailAddress,
  EmailBodyPart,
  EmailBodyValue,
  EmailComparator,
  EmailFilter,
  Id,
  Identity,
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
  /**
   * Header details for the reading pane's disclosure (M3.9, FR-RD-06). All three are OPTIONAL and
   * NON-INDEXED, so per the migration policy above they need **no** Dexie version bump: they appear
   * on rows written from now on and read as `undefined` on rows written before M3.9.
   */
  bcc?: EmailAddress[] | null
  sender?: EmailAddress[] | null
  /**
   * Every `Authentication-Results` value, in message order (`:asText:all`). `[0]` is the topmost —
   * the receiving MTA prepends its own, so it is the only one worth showing (RFC 8601 §5); see
   * `mail/auth-results.ts` for why the UI renders no verdict from it.
   *
   * The three states are load-bearing: `undefined` means EXACTLY "this row predates M3.9" (and
   * `fetchBody` re-fetches it), `[]` means "the message carries no such header".
   */
  authResults?: string[]
  /**
   * The `List-Unsubscribe` URLs (M5.3, FR-RD-09), already unbracketed by `:asURLs`.
   *
   * Same three-state contract as {@link authResults}, with one more distinction that matters:
   * `undefined` = row written before M5.3, `null` = the message carries no such header, `[]` = the
   * header was there but named no URL. Only `undefined` justifies a re-fetch.
   */
  listUnsubscribe?: string[] | null
  /** `List-Unsubscribe-Post`; its presence is what makes a one-click POST legitimate (RFC 8058). */
  listUnsubscribePost?: string | null
  fetchedAt: number
  lastAccessedAt: number
  /**
   * Approximate STORED size (M3.4) — {@link estimateBodyBytes}. Required and INDEXED: the cache
   * budget is a key-only sum over `[accountId+lastAccessedAt+bytes]`, so eviction never deserializes
   * a single body row. Written by {@link putEmailBody}, never by hand.
   */
  bytes: number
  /**
   * Derived, account-scoped blob membership: `["<accountId>\0<blobId>", …]` (multiEntry, M3.4) —
   * every blob this body references (attachments + inline `cid:` parts). It is the ONLY link from a
   * cached blob back to its owning message, and reading it through the index (keys + primaryKeys)
   * yields the blob→owner map WITHOUT loading heavy body or blob rows. Cache policy needs it twice:
   * a blob with no surviving owner is an ORPHAN, and a blob owned by a pinned message is PROTECTED.
   */
  ablob: string[]
}

/** Metadata (and optionally cached bytes) for a blob fetched on demand; LRU-evicted. */
export interface BlobMetaRow {
  accountId: Id
  blobId: Id
  type: string | null
  /** The JMAP-reported part size (metadata only, nullable) — NOT the stored byte count. */
  size: number | null
  name: string | null
  /**
   * Cached bytes when downloaded (attachments/inline images); null = metadata only. Stored as an
   * `ArrayBuffer`, not a `Blob`: both are structured-cloneable, but ArrayBuffer round-trips through
   * every IndexedDB implementation (including the `structuredClone` used by fake-indexeddb under
   * jsdom, which silently flattens a DOM `Blob` to `{}`), and the media type is already on the row.
   * {@link BlobCache} rehydrates a `Blob` from these bytes + {@link type} at the call site.
   */
  data: ArrayBuffer | null
  fetchedAt: number
  lastAccessedAt: number
  /** Stored size (M3.4) — {@link estimateBlobBytes}. Required and INDEXED (see {@link EmailBodyRow.bytes}). */
  bytes: number
}

// ---------------------------------------------------------------------------------------------
// Cache accounting (M3.4, FR-OFF-04). Deterministic, pure size estimates — the eviction budget is
// OUR OWN sum of these, never `navigator.storage.estimate()` (which is coarse, padded and
// origin-wide). They only have to be stable and roughly proportional; they are not a byte oracle.
// ---------------------------------------------------------------------------------------------

/** Flat per-body overhead: keys, structure, part metadata, IndexedDB record overhead. */
export const BODY_OVERHEAD_BYTES = 2048

/** Flat cost of a metadata-only blob row (no cached bytes). */
export const BLOB_META_OVERHEAD_BYTES = 256

/** Per-envelope constant for the UI/budget estimate — envelopes are counted, never weighed. */
export const ENVELOPE_BYTES_ESTIMATE = 1_200

/**
 * Approximate stored size of a body row: UTF-16 payload + a flat structural overhead.
 *
 * It must NEVER throw. It runs inside the v5 `.upgrade()` over rows written by older builds (and by
 * servers that omit things they should not), and a `TypeError` raised in a `modify()` callback aborts
 * the upgrade transaction — which makes `db.open()` reject on this start AND on every start after it.
 * The replica is a rebuildable cache, but nothing rebuilds it: the user's mail app would simply never
 * load again. A wrong byte estimate costs a slightly-off eviction; a throw costs the whole app.
 */
export function estimateBodyBytes(
  row: Pick<
    EmailBodyRow,
    'bodyValues' | 'bcc' | 'sender' | 'authResults' | 'listUnsubscribe' | 'listUnsubscribePost'
  >,
): number {
  let payload = 0
  for (const value of Object.values(row.bodyValues ?? {})) {
    if (typeof value?.value === 'string') payload += value.value.length * 2
  }
  // M3.9's header details. Same never-throws discipline as above: an `Array.isArray` gate rather than
  // `?? []`, because spreading/iterating whatever a malformed row actually holds is what would throw.
  for (const address of [
    ...(Array.isArray(row.bcc) ? row.bcc : []),
    ...(Array.isArray(row.sender) ? row.sender : []),
  ]) {
    payload += ((address?.name?.length ?? 0) + (address?.email?.length ?? 0)) * 2
  }
  for (const value of Array.isArray(row.authResults) ? row.authResults : []) {
    if (typeof value === 'string') payload += value.length * 2
  }
  // M5.3's unsubscribe headers, under the same never-throws discipline.
  for (const value of Array.isArray(row.listUnsubscribe) ? row.listUnsubscribe : []) {
    if (typeof value === 'string') payload += value.length * 2
  }
  if (typeof row.listUnsubscribePost === 'string') payload += row.listUnsubscribePost.length * 2
  return payload + BODY_OVERHEAD_BYTES
}

/**
 * Blob row size: cached bytes when present, else the metadata overhead. Never throws either — and note
 * that a row written by an older build could hold a `Blob` (which has `size`, not `byteLength`) rather
 * than the `ArrayBuffer` stored today. Reading `byteLength` off a `Blob` yields `undefined`, and an
 * `undefined` `bytes` drops the record from the `[accountId+lastAccessedAt+bytes]` index ENTIRELY —
 * invisible to metering and to eviction, i.e. the exact failure this migration exists to prevent.
 */
export function estimateBlobBytes(row: Pick<BlobMetaRow, 'data' | 'size'>): number {
  const data: unknown = row.data
  if (data instanceof ArrayBuffer) return data.byteLength
  if (typeof Blob !== 'undefined' && data instanceof Blob) return data.size
  if (typeof row.size === 'number' && Number.isFinite(row.size)) {
    return row.size + BLOB_META_OVERHEAD_BYTES
  }
  return BLOB_META_OVERHEAD_BYTES
}

/** Every blobId a body references (attachments + inline `cid:` parts), deduped — see `ablob`. */
export function collectBodyBlobIds(
  row: Pick<EmailBodyRow, 'bodyStructure' | 'textBody' | 'htmlBody' | 'attachments'>,
): Id[] {
  const out = new Set<Id>()
  const visit = (part: EmailBodyPart | undefined): void => {
    if (!part) return
    if (part.blobId !== null && part.blobId !== undefined) out.add(part.blobId)
    for (const sub of part.subParts ?? []) visit(sub)
  }
  visit(row.bodyStructure)
  for (const part of row.textBody ?? []) visit(part)
  for (const part of row.htmlBody ?? []) visit(part)
  for (const part of row.attachments ?? []) visit(part)
  return [...out]
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
 * Stable conflict codes (M3.3, FR-OFF-03) — a CODE, never prose: the row is persisted, so a stored
 * user-visible string would defeat i18n (it would freeze the language at write time). The UI maps a
 * code (plus the intent kind) to a translation key in `outbox/describe-conflict.ts`.
 */
export type ConflictCode =
  | 'messageGone'
  | 'folderGone'
  | 'folderNotEmpty'
  /** A ContactCard `update` was rejected `notFound` — the card was deleted elsewhere while we edited it (M4.2). */
  | 'contactGone'
  | 'forbidden'
  | 'quota'
  | 'tooLarge'
  | 'invalid'
  | 'stateConflict'
  | 'sendRejected'
  | 'sendInterrupted'
  | 'serverRejected'

/**
 * The PERSISTED undo of an outbox intent's optimistic apply (M3.3). Data, not a closure: an
 * in-memory rollback dies with the tab that dispatched it, so a reload — or a rejection replayed by
 * the LEADER for an action a FOLLOWER dispatched — could never roll the replica back (ADR-009 debt).
 * Stored on the row, it travels with the intent. Non-null on an `error` row ⇒ the rollback is still
 * OWED and every replay pass retries it.
 *
 * Payloads stay tiny: a destroy re-fetches the (still-existing, because the destroy was REJECTED)
 * envelopes from the server rather than storing them, which also self-corrects a PARTIAL rejection.
 *
 * `prunedKeys` is the same idea one level up: an optimistic move/destroy/keyword-change also prunes the
 * message out of the cached list windows it left ({@link QueryCacheRow.ids} — what the list renders), and
 * the rollback has to put it back. The KEYS are recorded (data, not a closure) rather than the ids and
 * their positions: the window is in the SERVER's collation, so re-inserting at the old index would be a
 * guess. Marking the window for a full re-query is both correct and free — a rollback only happens when
 * the server answered, i.e. we are online.
 * OPTIONAL: an undo persisted by a build before M3.8 pruned nothing, and `undefined` reads as "none".
 *
 * `insertedKeys` (M3.10) is its mirror image, and it exists because the arrival half stopped being
 * void-only: a move now SPLICES the message into a destination window whenever that placement is
 * locally computable (`engine/outbox.ts`, gap B2 — otherwise a message moved into a visible window
 * offline never appeared, so Undo read as broken). Those windows genuinely hold an id we invented, so
 * a rejection has to take it back OUT — voiding alone would leave a phantom row rendering until the
 * re-query lands. The keys record WINDOWS, not which id went into which, so the rollback intersects
 * them with the ids actually being undone (a partial rejection undoes a subset). A destination window
 * we could NOT place into is still not recorded: nothing was edited there, so its re-query returns the
 * truth whatever the server answered.
 */
export type OutboxUndo =
  | { readonly kind: 'none' }
  /** `setKeywords` + the `sendEmail` source flag: `had` = the ids that ALREADY carried the keyword. */
  | {
      readonly kind: 'keywords'
      readonly keyword: string
      readonly had: Id[]
      /**
       * The {@link QueryCacheRow.key}s whose window this apply pruned the ids out of (M3.10).
       * OPTIONAL and absent on `sendEmail`'s source-flag undo, which prunes nothing, as well as on
       * any undo persisted before M3.10 — every reader takes it as "none".
       */
      readonly prunedKeys?: string[]
    }
  /** `move`: `hadTo` = ids ALREADY in `to` (do not strip); `hadFrom` = ids that were in `from`. */
  | {
      readonly kind: 'mailboxIds'
      readonly from: Id | null
      readonly to: Id
      readonly hadTo: Id[]
      readonly hadFrom: Id[]
      /** The {@link QueryCacheRow.key}s whose window this apply pruned the ids out of. */
      readonly prunedKeys?: string[]
      /**
       * The {@link QueryCacheRow.key}s whose window this apply SPLICED the ids into (M3.10). OPTIONAL
       * and absent on every undo persisted before M3.10, which read as "nothing was inserted".
       */
      readonly insertedKeys?: string[]
    }
  /** `destroyEmails`: re-fetch the rejected ids from the server (they still exist there). */
  | { readonly kind: 'refetchEmails'; readonly prunedKeys?: string[] }
  | { readonly kind: 'mailbox'; readonly id: Id; readonly prior: MailboxRow | null }
  /**
   * A ContactCard create/update/delete (M4.2). `prior` is the pre-mutation row (null for a create) —
   * the full stored row, so a rollback is exact regardless of how the optimistic patch was applied.
   * The mirror of the `mailbox` variant for the contact-card object.
   */
  | { readonly kind: 'contactCard'; readonly id: Id; readonly prior: ContactCardRow | null }
  /** An AddressBook create (M4.2) — `prior` is always null this stage (no book update/delete yet). */
  | { readonly kind: 'addressBook'; readonly id: Id; readonly prior: AddressBookRow | null }

/** Why an outbox row is `error` (M3.3). Drives the conflict notice + the problems dialog. */
export interface OutboxConflict {
  readonly code: ConflictCode
  /** The raw JMAP `SetError` / method-error `type` (details line + telemetry). */
  readonly errorType: string | null
  /** The server's `description`, verbatim — secondary detail only, NEVER the title. */
  readonly detail: string | null
  /** The objects that ACTUALLY failed (a subset of the intent's ids / its creation id). */
  readonly ids: string[]
  readonly at: number
}

/**
 * An idempotent JMAP `set` intent (FR-OFF-03). M1.2 defines the row; M1.3 added online replay;
 * M3.3 added durable undo, backoff and conflict classification (never silent data loss).
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
  /** Epoch ms before which replay must NOT fire (M2.8 undo-send grace); `null` = replay immediately. */
  notBefore: number | null
  /**
   * Backoff gate (M3.3): epoch ms before which a RETRY may not fire. Orthogonal to {@link notBefore}
   * (the undo-send grace) — overloading that one would make a twice-failed send look "undoable".
   */
  nextAttemptAt?: number | null
  /** The persisted undo. Non-null ⇒ a rollback is still OWED; nulled the moment it is applied. */
  undo?: OutboxUndo | null
  /** Set together with `status: 'error'` (M3.3). */
  conflict?: OutboxConflict | null
  /** Bounded `stateMismatch` auto-refresh count (M3.3); persisted so the bound survives a reload. */
  refreshes?: number
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

/** A forwarded/draft attachment carried by blob reference — a structural mirror of the composer's
 *  `DraftAttachment` (kept inline to avoid a compose→sync import cycle). */
export interface DraftAttachmentLike {
  blobId: string
  name: string | null
  type: string
  size: number
  cid: string | null
}

/** The persistable subset of a composer `DraftWindow` (UI-only mode/dirty/focus are excluded). */
export interface SerializedDraft {
  to: EmailAddress[]
  cc: EmailAddress[]
  bcc: EmailAddress[]
  subject: string
  body: string
  inReplyTo: string[] | null
  references: string[] | null
  fromIdentityId: string | null
  fromIdentityHint: string | null
  attachments: DraftAttachmentLike[]
  /** Reply/forward source id + the keyword to set on it after send (M2.8); `null` for a new draft. */
  sourceEmailId: Id | null
  sourceFlag: '$answered' | '$forwarded' | null
}

export type DraftSyncStatus = 'pending' | 'synced' | 'sending' | 'error'

/**
 * Crash-safe local edit-state for one draft (M2.6, FR-CMP-03) — NOT a JMAP envelope cache.
 * `localId` is the composer `DraftWindow.id`; `serverEmailId` is the Drafts-mailbox `Email` id once
 * the create lands (a draft content change is create-new + destroy-old — RFC 8621 §4.6). The durable
 * `put` of this row (no server round-trip) is the crash-safety guarantee.
 */
export interface DraftRow {
  accountId: Id
  localId: string
  serverEmailId: Id | null
  status: DraftSyncStatus
  content: SerializedDraft
  createdAt: number
  updatedAt: number
  lastError: string | null
  /**
   * Which pipeline stamped a `status:'error'` (M2.8) — a failed `send` is surfaced live to the user
   * (toast + reopen), a failed autosave `save` is not. Absent on non-error rows; written by both
   * stamp functions alongside `status:'error'`, so it is always correct whenever `status==='error'`.
   */
  errorKind?: 'save' | 'send'
}

// ---------------------------------------------------------------------------------------------
// The database.
// ---------------------------------------------------------------------------------------------

/** RFC 8621 §6 Identity mirror (M2.5) — the From selector + per-identity signatures / reply-to. */
export interface IdentityRow extends Identity {
  accountId: Id
}

// ---------------------------------------------------------------------------------------------
// Contacts (M4.2, RFC 9610) — the AddressBook tree + the ContactCard replica, mirrored on the
// Mailbox/Email pattern. An account has few address books (fetched whole, no `/query`); cards can
// be many, so their windowed list renders from an ordered id window in `contactQueryCache`.
// ---------------------------------------------------------------------------------------------

/** RFC 9610 §2 AddressBook mirror — the contact-source tree (analogue of {@link MailboxRow}). */
export interface AddressBookRow extends AddressBook {
  accountId: Id
}

/**
 * RFC 9610 §3 ContactCard mirror. Holds the FULL JSContact `Card` (RFC 9553) plus the JMAP object
 * layer (`id`, `addressBookIds`) losslessly — every unmapped property and the `vCardProps` bag ride
 * through untouched — so a later edit/export round-trips (see `@waxwing/jmap` `ContactCard`).
 *
 * A card belongs to many address books (`addressBookIds`), the same many-valued membership problem
 * the email row solves with `amb`: IndexedDB has no compound-multiEntry index, so book membership is
 * carried in a derived, account-scoped multiEntry array — `abk` = `"<accountId>\0<bookId>"` — kept in
 * sync by {@link toContactCardRow}. That makes "cards in book X for account A" one indexed range with
 * no cross-account bleed. The ORDERED list still comes from {@link ContactQueryCacheRow.ids}.
 */
export interface ContactCardRow extends ContactCard {
  accountId: Id
  /** Derived, account-scoped address-book membership: `["<accountId>\0<bookId>", …]` (multiEntry). */
  abk: string[]
}

/**
 * A watched `ContactCard/query`: canonical key → the server-ordered id window + its queryState cursor
 * (the analogue of {@link QueryCacheRow}). A SEPARATE store rather than a reused `queryCache` row: the
 * contact filter/sort are contact-typed (`ContactCardFilter`/`ContactCardComparator`) and there is no
 * `collapseThreads`, so folding them into the strongly-typed, Email-shaped {@link QueryCacheRow} would
 * force type-lying casts and a meaningless required field. A dedicated store keeps both paths honest.
 */
export interface ContactQueryCacheRow {
  accountId: Id
  /** {@link canonicalContactQueryKey} of `{filter, sort}`. */
  key: string
  /** Server-ordered ids (respecting the query's collation); the list renders from this order. */
  ids: Id[]
  queryState: string | null
  total: number | null
  /** Oldest id currently held — the backfill/"load more" window cursor. */
  upToId: Id | null
  filter: ContactCardFilter | null
  sort: ContactCardComparator[] | null
  lastUsedAt: number
}

export class ReplicaDb extends Dexie {
  accounts!: Table<AccountRecord, Id>
  mailboxes!: Table<MailboxRow, [Id, Id]>
  identities!: Table<IdentityRow, [Id, Id]>
  threads!: Table<ThreadRow, [Id, Id]>
  emails!: Table<EmailRow, [Id, Id]>
  emailBodies!: Table<EmailBodyRow, [Id, Id]>
  blobsMeta!: Table<BlobMetaRow, [Id, Id]>
  syncState!: Table<SyncStateRow, [Id, string]>
  queryCache!: Table<QueryCacheRow, [Id, string]>
  outbox!: Table<OutboxRow, [Id, Id]>
  localPrefs!: Table<LocalPrefRow, [Id, string]>
  addressStats!: Table<AddressStatRow, [Id, string]>
  drafts!: Table<DraftRow, [Id, string]>
  addressBooks!: Table<AddressBookRow, [Id, Id]>
  contactCards!: Table<ContactCardRow, [Id, Id]>
  contactQueryCache!: Table<ContactQueryCacheRow, [Id, string]>

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
    // v3 (M2.5) — additive: the identities store only (account-global From identities + signatures).
    this.version(3).stores({
      identities: '[accountId+id], accountId',
    })
    // v4 (M2.6) — additive: the crash-safe local drafts store only.
    this.version(4).stores({
      drafts: '[accountId+localId], accountId, [accountId+serverEmailId], [accountId+updatedAt]',
    })
    // v5 (M3.4) — size-carrying LRU indexes for cache eviction + metering, and the blob→owner link.
    // NOT exempt from a bump: the new fields are INDEXED, and a record missing an index's key path is
    // dropped from that index entirely — legacy rows would be invisible to metering AND eviction. So
    // the stored rows are transformed (see the migration-policy note in the module header).
    this.version(5)
      .stores({
        emailBodies:
          '[accountId+id], accountId, [accountId+lastAccessedAt], [accountId+lastAccessedAt+bytes], *ablob',
        blobsMeta:
          '[accountId+blobId], accountId, [accountId+lastAccessedAt], [accountId+lastAccessedAt+bytes]',
      })
      // Belt AND braces: the estimators above never throw, and each row transform is ALSO wrapped, so
      // one malformed legacy row can never abort the upgrade transaction. An aborted upgrade means
      // `db.open()` rejects forever after — the app would not start again — and a cache row that gets
      // a fallback size is a rounding error by comparison.
      .upgrade(async (tx) => {
        await tx
          .table<EmailBodyRow>('emailBodies')
          .toCollection()
          .modify((row) => {
            try {
              row.bytes = estimateBodyBytes(row)
              row.ablob = collectBodyBlobIds(row).map((blobId) => scopeKey(row.accountId, blobId))
            } catch {
              row.bytes = BODY_OVERHEAD_BYTES
              row.ablob = []
            }
          })
        await tx
          .table<BlobMetaRow>('blobsMeta')
          .toCollection()
          .modify((row) => {
            try {
              row.bytes = estimateBlobBytes(row)
            } catch {
              row.bytes = BLOB_META_OVERHEAD_BYTES
            }
          })
      })
    // v6 (M4.2) — additive: the contacts replica (AddressBook tree + ContactCard cards + their watched
    // query windows). Three brand-new stores, so no `.upgrade()` (no data transform); Dexie carries
    // every unspecified store forward unchanged. `contactCards` carries the derived `abk` multiEntry
    // index for account-scoped book membership, mirroring `emails`' `amb`.
    this.version(6).stores({
      // No index on `isSubscribed`: a boolean is not a valid IndexedDB key, so an index on it would
      // silently drop every row. Address books are few and assembled/sorted in memory (see
      // `addressBooksForAccount`), the same as the folder tree.
      addressBooks: '[accountId+id], accountId',
      contactCards: '[accountId+id], accountId, *abk',
      contactQueryCache: '[accountId+key], accountId, [accountId+lastUsedAt]',
    })
  }
}

/** Lazily-opened shared instance for the app and the M1.3 sync engine (tests construct their own). */
let sharedDb: ReplicaDb | undefined

/**
 * The name the shared replica opens under. `undefined` = the durable default.
 *
 * Set once, before the first `getReplica()`, by the public-computer path (`sync/ephemeral.ts`).
 * It is module state rather than a `getReplica(name)` argument because the replica has a dozen
 * call sites that must all agree on WHICH database they are talking to — a parameter would let one
 * of them quietly open the durable one and write a public-computer session's mail into it.
 */
let replicaName: string | undefined

/**
 * Point the shared replica at `name` (FR-AUTH-09). Throws if a replica is already open: switching
 * databases underneath a running engine would leave half a session in each.
 */
export function setReplicaName(name: string | undefined): void {
  if (sharedDb !== undefined) {
    throw new Error('setReplicaName must be called before the replica is opened')
  }
  replicaName = name
}

/** The database name currently in force — the ephemeral sweep needs to know what to keep. */
export function currentReplicaName(): string {
  return replicaName ?? REPLICA_DB_NAME
}

export function getReplica(): ReplicaDb {
  if (!sharedDb) sharedDb = new ReplicaDb(replicaName)
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

/** Map a JMAP identity to its stored row (M2.5). */
export function toIdentityRow(accountId: Id, identity: Identity): IdentityRow {
  return { ...identity, accountId }
}

/** Map a JMAP AddressBook to its stored row (M4.2). */
export function toAddressBookRow(accountId: Id, book: AddressBook): AddressBookRow {
  return { ...book, accountId }
}

/** Map a JMAP ContactCard to its stored row (M4.2), computing the account-scoped book-membership index. */
export function toContactCardRow(accountId: Id, card: ContactCard): ContactCardRow {
  const addressBookIds = card.addressBookIds ?? {}
  return {
    ...card,
    accountId,
    addressBookIds,
    abk: Object.keys(addressBookIds).map((bookId) => scopeKey(accountId, bookId)),
  }
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

/**
 * Drop the shared handle and the chosen name, so the NEXT `getReplica()` opens the durable default
 * again (FR-AUTH-09).
 *
 * Sign-out has to do this, and the omission bit both ways. A public-computer session left
 * `replicaName` pointing at its throwaway database, so the next ORDINARY sign-in in the same page
 * load wrote into a database the following startup sweep then deleted. And because `sharedDb`
 * survived a plain sign-out, `setReplicaName` threw for the next public-computer sign-in — the mode
 * became unavailable for the rest of the page load, reported only as a generic connection error.
 */
export function resetReplica(): void {
  sharedDb = undefined
  replicaName = undefined
}

/** Test seam: forget the shared handle AND the name, so a suite can start from the default. */
export function resetReplicaForTests(): void {
  resetReplica()
}
