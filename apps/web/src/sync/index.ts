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
  type EmailBodyRow,
  type EmailEnvelopeInput,
  type EmailRow,
  getReplica,
  type LocalPrefRow,
  type MailboxRow,
  type OutboxRow,
  type OutboxStatus,
  type QueryCacheRow,
  REPLICA_DB_NAME,
  ReplicaDb,
  type SyncStateRow,
  scopeKey,
  type ThreadRow,
  toEmailRow,
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
