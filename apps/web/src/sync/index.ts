/**
 * `sync/` — the local-first replica (M1.2) and, from M1.3, the sync engine and outbox.
 *
 * M1.2 surface: the Dexie schema + row types (`db`), the canonical query-key serialization
 * (`query-key`), the account-scoped repository (`repo`), and the React liveQuery binding
 * (`react`). The sync engine (delta fetch, push integration, outbox replay) lands in M1.3.
 */

export {
  type BlobDownload,
  type BlobRef,
  getOrFetchBlob,
  MAX_CACHED_BLOB_BYTES,
} from './blob-cache'
export {
  type CacheCategory,
  type CacheUsage,
  collectCacheUsage,
} from './cache-usage'
export {
  type AccountRecord,
  type AddressBookRow,
  type AddressStatRow,
  BLOB_META_OVERHEAD_BYTES,
  type BlobMetaRow,
  BODY_OVERHEAD_BYTES,
  type ConflictCode,
  type ContactCardRow,
  type ContactQueryCacheRow,
  clearAccount,
  collectBodyBlobIds,
  type DraftAttachmentLike,
  type DraftRow,
  type DraftSyncStatus,
  type EmailBodyRow,
  type EmailEnvelopeInput,
  type EmailRow,
  ENVELOPE_BYTES_ESTIMATE,
  estimateBlobBytes,
  estimateBodyBytes,
  getReplica,
  type IdentityRow,
  type LocalPrefRow,
  type MailboxRow,
  type OutboxConflict,
  type OutboxRow,
  type OutboxStatus,
  type OutboxUndo,
  type QueryCacheRow,
  REPLICA_DB_NAME,
  ReplicaDb,
  type SerializedDraft,
  type SyncStateRow,
  scopeKey,
  type ThreadRow,
  toAddressBookRow,
  toContactCardRow,
  toEmailRow,
  toIdentityRow,
  toMailboxRow,
  toThreadRow,
  wipeReplica,
} from './db'
export { canonicalContactQueryKey, canonicalQueryKey, type QuerySpec } from './query-key'
export {
  getActiveReplica,
  type ReplicaContextValue,
  ReplicaProvider,
  type ReplicaProviderProps,
  useAddressBooks,
  useContactCard,
  useContactWindow,
  useEmail,
  useEmailBody,
  useEmailWindow,
  useIdentities,
  useLocalPref,
  useLocalPrefOptional,
  useMailbox,
  useMailboxByRole,
  useMailboxes,
  useMailboxesFor,
  useQueryWindow,
  useReplica,
  useReplicaOptional,
  useReplicaQuery,
  useThread,
} from './react'
export * from './repo'
export {
  browserEstimate,
  type EstimateFn,
  getStorageFullAt,
  isPersisted,
  isQuotaExceeded,
  reportStorageFull,
  requestPersistence,
  resetStorageFull,
  type StorageEstimateLike,
  subscribeStorageFull,
} from './storage'
