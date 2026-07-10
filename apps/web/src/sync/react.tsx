/**
 * React binding for the replica (M1.2): an account-context provider plus `useLiveQuery` wrappers.
 * The UI never reads the network — it subscribes to the replica here, and Dexie's liveQuery
 * re-renders the component whenever the underlying rows change (including from another tab). The
 * provider fixes the current `accountId` so every hook is account-scoped without threading it.
 *
 * M1.2 ships the binding and its hooks tested in isolation; the M1.3 sync engine mounts
 * {@link ReplicaProvider} inside the connected shell (accountId from the JMAP session).
 */

import type { Id } from '@waxwing/jmap'
import { useLiveQuery } from 'dexie-react-hooks'
import { createContext, type ReactNode, useContext, useMemo } from 'react'
import { getReplica, type MailboxRow, type QueryCacheRow, type ReplicaDb } from './db'
import { emailsByIds, mailboxByRole, mailboxesForAccount } from './repo'

interface ReplicaContextValue {
  readonly db: ReplicaDb
  readonly accountId: Id
}

const ReplicaContext = createContext<ReplicaContextValue | null>(null)

export interface ReplicaProviderProps {
  readonly accountId: Id
  /** Injectable for tests; defaults to the shared app database. */
  readonly db?: ReplicaDb
  readonly children: ReactNode
}

export function ReplicaProvider({ accountId, db, children }: ReplicaProviderProps): ReactNode {
  const value = useMemo<ReplicaContextValue>(
    () => ({ db: db ?? getReplica(), accountId }),
    [db, accountId],
  )
  return <ReplicaContext.Provider value={value}>{children}</ReplicaContext.Provider>
}

/** The active replica + account. Throws if used outside a {@link ReplicaProvider}. */
export function useReplica(): ReplicaContextValue {
  const context = useContext(ReplicaContext)
  if (context === null) throw new Error('useReplica must be used within a ReplicaProvider')
  return context
}

/**
 * `undefined` while the first query resolves, then the value; re-runs on any matching write.
 * A thin typed alias over dexie-react-hooks so callers don't import it directly.
 */
export function useReplicaQuery<T>(
  querier: (context: ReplicaContextValue) => Promise<T>,
  extraDeps: readonly unknown[] = [],
): T | undefined {
  const context = useReplica()
  return useLiveQuery(() => querier(context), [context.db, context.accountId, ...extraDeps])
}

/** The folder tree source: all mailboxes for the account, ordered (M1.5). */
export function useMailboxes(): MailboxRow[] | undefined {
  return useReplicaQuery(({ db, accountId }) => mailboxesForAccount(db, accountId))
}

/** A single mailbox (live counts/rights). */
export function useMailbox(id: Id): MailboxRow | undefined {
  return useReplicaQuery(({ db, accountId }) => db.mailboxes.get([accountId, id]), [id])
}

/** A role mailbox (`inbox`, …) — e.g. the default folder to open. */
export function useMailboxByRole(role: string): MailboxRow | undefined {
  return useReplicaQuery(({ db, accountId }) => mailboxByRole(db, accountId, role), [role])
}

/** The cached window for a watched query key (M1.6 list; key from `canonicalQueryKey`). */
export function useQueryWindow(key: string): QueryCacheRow | undefined {
  return useReplicaQuery(({ db, accountId }) => db.queryCache.get([accountId, key]), [key])
}

/** Hydrate the list rows for an ordered id window (order preserved; `undefined` = not yet synced). */
export function useEmailWindow(ids: Id[]) {
  return useReplicaQuery(({ db, accountId }) => emailsByIds(db, accountId, ids), [ids.join(',')])
}

/** A single email envelope row (live). */
export function useEmail(id: Id) {
  return useReplicaQuery(({ db, accountId }) => db.emails.get([accountId, id]), [id])
}

/** A local preference value (FR-MBX-04), typed by the caller. */
export function useLocalPref<T>(key: string): T | undefined {
  const row = useReplicaQuery(({ db, accountId }) => db.localPrefs.get([accountId, key]), [key])
  return row?.value as T | undefined
}
