/**
 * `sync/` — the local-first replica (M1.2) and, from M1.3, the sync engine and outbox.
 *
 * M1.2 surface: the Dexie schema + row types (`db`), the canonical query-key serialization
 * (`query-key`), the account-scoped repository (`repo`), and the React liveQuery binding
 * (`react`). The sync engine (delta fetch, push integration, outbox replay) lands in M1.3.
 */

export {
  type AccountRecord,
  type AddressStatRow,
  type BlobMetaRow,
  clearAccount,
  type DraftAttachmentLike,
  type DraftRow,
  type DraftSyncStatus,
  type EmailBodyRow,
  type EmailEnvelopeInput,
  type EmailRow,
  getReplica,
  type IdentityRow,
  type LocalPrefRow,
  type MailboxRow,
  type OutboxRow,
  type OutboxStatus,
  type QueryCacheRow,
  REPLICA_DB_NAME,
  ReplicaDb,
  type SerializedDraft,
  type SyncStateRow,
  scopeKey,
  type ThreadRow,
  toEmailRow,
  toIdentityRow,
  toMailboxRow,
  toThreadRow,
  wipeReplica,
} from './db'
export { canonicalQueryKey, type QuerySpec } from './query-key'
export {
  ReplicaProvider,
  type ReplicaProviderProps,
  useEmail,
  useEmailBody,
  useEmailWindow,
  useIdentities,
  useLocalPref,
  useMailbox,
  useMailboxByRole,
  useMailboxes,
  useQueryWindow,
  useReplica,
  useReplicaOptional,
  useReplicaQuery,
  useThread,
} from './react'
export * from './repo'
