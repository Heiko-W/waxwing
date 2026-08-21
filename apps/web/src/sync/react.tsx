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
import { createContext, type ReactNode, useContext, useEffect, useMemo } from 'react'
import {
  type AddressBookRow,
  type CalendarEventRow,
  type CalendarRow,
  type ContactCardRow,
  type FileNodeRow,
  type FileTreeState,
  getReplica,
  type IdentityRow,
  type LocalPrefRow,
  type MailboxRow,
  type QueryCacheRow,
  type ReplicaDb,
} from './db'
import {
  addressBooksForAccount,
  calendarEventsByIds,
  calendarsForAccount,
  contactCardsByIds,
  emailsByIds,
  fileNodesForAccount,
  fileNodesForParent,
  getCalendarQueryCache,
  getContactQueryCache,
  getFileTreeState,
  identitiesForAccount,
  mailboxByRole,
  mailboxesForAccount,
} from './repo'

export interface ReplicaContextValue {
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

// ---------------------------------------------------------------------------------------------
// The live replica, reachable from OUTSIDE the provider's subtree (M3.10).
//
// React context only flows DOWN, and two things that must reach the replica sit ABOVE the provider
// rather than below it: the PWA update prompt (`pwa/use-update-prompt.ts`), mounted above the auth
// gate so a first-time visitor still precaches the shell, and any future out-of-React teardown path.
// `useReplicaOptional()` returns `null` for them however correct their intent — which is exactly how
// M3.5's "open drafts are saved first" promise came to be wired to a no-op flush for five milestones.
//
// A module-level accessor is the same shape the engine (`setActiveEngine`) and the storage-full
// signal (`storage.ts`) already use for live sync state, and it is deliberately NOT reactive: the one
// caller reads it once, inside an event handler, at the moment the user accepts a reload.
//
// ONLY THE OUTERMOST PROVIDER CLAIMS IT (M4.4 Etappe 4). Since Etappe 3 the providers NEST: the shell
// re-scopes the mail panes to the acting account, and the sidebar gives every account's tree its own.
// On an account switch only the INNER provider's effect re-runs, so an unconditional claim would
// leave `activeReplica` pointing at the SHARED account permanently — the outer primary provider's
// effect does not re-run to restore it. `flushActiveDraft` (`compose/use-draft-sync.ts`), which is
// M3.5's "open drafts are saved first" promise, would then `putDraft` into `drafts[sharedAccountId]`
// while `useDraftSync` reads `drafts[primaryAccountId]`: the exact data loss M3.10 fixed, reintroduced
// by nesting. `getActiveReplica()` means THE APP's replica, and only the outermost provider is that —
// a nested provider is a SCOPE, not the app.
// ---------------------------------------------------------------------------------------------

let activeReplica: ReplicaContextValue | null = null

/**
 * The mounted {@link ReplicaProvider}'s replica, or `null` before sign-in and after sign-out.
 *
 * `null` is a NORMAL answer, not an error: on the sign-in screen there is no account, no database
 * handle and — since the composer lives inside the shell — nothing that could need flushing. Callers
 * treat it as "nothing to do" rather than as a failure.
 */
export function getActiveReplica(): ReplicaContextValue | null {
  return activeReplica
}

export function ReplicaProvider({ accountId, db, children }: ReplicaProviderProps): ReactNode {
  const parent = useContext(ReplicaContext)
  const value = useMemo<ReplicaContextValue>(
    () => ({ db: db ?? getReplica(), accountId }),
    [db, accountId],
  )
  useEffect(() => {
    // Nested providers are scopes, not the app — see the block above.
    if (parent !== null) return
    activeReplica = value
    return () => {
      // Only clear it if it is still OURS. React can mount a replacement tree before unmounting the
      // old one (a route swap, StrictMode's double-invoke), and an unconditional `= null` here would
      // let the departing provider blank its own successor's entry.
      if (activeReplica === value) activeReplica = null
    }
  }, [value, parent])
  return <ReplicaContext.Provider value={value}>{children}</ReplicaContext.Provider>
}

/** The active replica + account. Throws if used outside a {@link ReplicaProvider}. */
export function useReplica(): ReplicaContextValue {
  const context = useContext(ReplicaContext)
  if (context === null) throw new Error('useReplica must be used within a ReplicaProvider')
  return context
}

/** Like {@link useReplica} but returns `null` outside a provider — for optional consumers/tests. */
export function useReplicaOptional(): ReplicaContextValue | null {
  return useContext(ReplicaContext)
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

/**
 * Mailboxes for an account the caller names explicitly, because it sits ABOVE that account's
 * provider (M4.4 Etappe 4) — `useSearch` runs in `MailScreen`'s body, outside the account scope it
 * feeds. Same query as {@link useMailboxes}; it just does not take the account from context.
 */
export function useMailboxesFor(accountId: Id): MailboxRow[] | undefined {
  const { db } = useReplica()
  return useLiveQuery(() => mailboxesForAccount(db, accountId), [db, accountId])
}

/** The From-selector source: all send identities for the account (M2.5). */
export function useIdentities(): IdentityRow[] | undefined {
  return useReplicaQuery(({ db, accountId }) => identitiesForAccount(db, accountId))
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

/** A message's full body row (live; M1.8). `undefined` until the engine's `fetchBody` populates it. */
export function useEmailBody(id: Id) {
  return useReplicaQuery(({ db, accountId }) => db.emailBodies.get([accountId, id]), [id])
}

/** A thread row (live; ordered `emailIds` for the conversation view, M1.8). */
export function useThread(id: Id) {
  return useReplicaQuery(({ db, accountId }) => db.threads.get([accountId, id]), [id])
}

// ── Contacts (M4.2) ───────────────────────────────────────────────────────────────────────────

/** The contact-source tree: all address books for the account, ordered (M4.2). */
export function useAddressBooks(): AddressBookRow[] | undefined {
  return useReplicaQuery(({ db, accountId }) => addressBooksForAccount(db, accountId))
}

/**
 * A virtualizable window over a watched contact query (M4.2; key from `canonicalContactQueryKey`):
 * the cards for the query's cached id window, in server order (`undefined` = not yet synced). Combines
 * the window-row lookup and the card hydration in one live query — the contacts analogue of
 * `useEmailWindow`, taking the query KEY (a contact card is fetched whole, so there is no separate
 * envelope/body split to hydrate).
 */
export function useContactWindow(key: string): (ContactCardRow | undefined)[] | undefined {
  return useReplicaQuery(
    async ({ db, accountId }) => {
      const row = await getContactQueryCache(db, accountId, key)
      if (row === undefined) return []
      return contactCardsByIds(db, accountId, row.ids)
    },
    [key],
  )
}

/** A single contact card row (live; M4.2). `undefined` until the engine syncs it into the replica. */
export function useContactCard(id: Id) {
  return useReplicaQuery(({ db, accountId }) => db.contactCards.get([accountId, id]), [id])
}

/**
 * The same lookup, able to say "there is no such contact".
 *
 * {@link useContactCard} returns `undefined` for BOTH "the query has not resolved" and "the row is
 * not there", so a deep link to a deleted contact showed a spinner forever — the reader was told
 * to wait for something that was never coming. Wrapping the row in an object moves the two apart:
 * the wrapper itself is `undefined` while the query is in flight, and `{ card: undefined }` once
 * it has answered. The mail side has carried this distinction since M1.8 (`useEnsureEnvelopes`'s
 * `settled`); this is the contacts equivalent.
 */
export function useContactCardResolved(id: Id): {
  settled: boolean
  card: ContactCardRow | undefined
} {
  const result = useReplicaQuery(
    async ({ db, accountId }) => ({ card: await db.contactCards.get([accountId, id]) }),
    [id],
  )
  return { settled: result !== undefined, card: result?.card }
}

// ── Calendar (K-8) ────────────────────────────────────────────────────────────────────────────

/**
 * The calendar list for the account, in draw order (K-8) — the analogue of {@link useAddressBooks}.
 *
 * OPTIONAL over the provider, for the reason {@link useMailboxOptional} documents: `SyncEngineHost`
 * renders its children WITHOUT a provider for as long as the session takes to restore, and the
 * calendar screen is one of those children. A throwing hook there is a white page on every reload.
 */
export function useCalendars(): CalendarRow[] | undefined {
  const context = useReplicaOptional()
  return useLiveQuery<CalendarRow[] | undefined>(
    async () =>
      context === null ? undefined : await calendarsForAccount(context.db, context.accountId),
    [context?.db, context?.accountId],
  )
}

/** What one materialized calendar window holds, or `undefined` while the query resolves. */
export interface CalendarWindow {
  /** The expanded occurrences the grid draws, in server order; `undefined` per id not yet stored. */
  readonly occurrences: (CalendarEventRow | undefined)[]
  /** The stored objects behind them — the identity half; see {@link CalendarQueryCacheRow}. */
  readonly objects: (CalendarEventRow | undefined)[]
  /** When the window was last read from the server; `0` = never (nothing has arrived yet). */
  readonly syncedAt: number
  /** `true` when the window has never been materialized — "nothing yet", not "no events". */
  readonly empty: boolean
}

/**
 * A watched calendar window, read from the replica alone (K-8; key from `watchCalendarQuery`).
 *
 * THREE answers, and conflating any two of them produces a visible bug:
 *  - `undefined` — the live query has not resolved, or there is no window to read (no provider, no
 *    key yet). Nothing is known: show a spinner.
 *  - `null` — the query answered and there is NO ROW. The engine has been asked for this window and
 *    has not finished; a first visit is here for as long as the request takes. Also a spinner —
 *    reading it as "empty" is what would flash "could not be loaded" over every first load.
 *  - a window — the row exists. `syncedAt === 0` then means the engine TRIED and failed (it writes
 *    that placeholder itself), which is the state the offline notice belongs to.
 */
export function useCalendarWindow(key: string): CalendarWindow | null | undefined {
  const context = useReplicaOptional()
  return useLiveQuery<CalendarWindow | null | undefined>(async () => {
    // Same provider-optional reasoning as {@link useCalendars} — and `''` is the "watch nothing"
    // key the caller passes before the calendar list has arrived.
    if (context === null || key === '') return undefined
    const { db, accountId } = context
    const row = await getCalendarQueryCache(db, accountId, key)
    if (row === undefined) return null
    return {
      occurrences: await calendarEventsByIds(db, accountId, row.ids),
      objects: await calendarEventsByIds(db, accountId, row.objectIds),
      syncedAt: row.syncedAt,
      empty: row.syncedAt === 0,
    }
  }, [context?.db, context?.accountId, key])
}

// ── Files (D-4) ───────────────────────────────────────────────────────────────────────────────

/**
 * One level of the file tree from the replica — the children of `parentId`, the roots for `null`.
 *
 * `undefined` while the query is in flight; an EMPTY array is a real answer. Unsorted: the order
 * the reader sees is `file-sort.ts`'s job, applied to whatever came back.
 *
 * Provider-optional for the same reason {@link useCalendars} is — `SyncEngineHost` renders its
 * children without a provider until the session restores, and the Files screen is one of them.
 */
export function useFileNodes(parentId: Id | null): FileNodeRow[] | undefined {
  const context = useReplicaOptional()
  return useLiveQuery<FileNodeRow[] | undefined>(
    async () =>
      context === null
        ? undefined
        : await fileNodesForParent(context.db, context.accountId, parentId),
    [context?.db, context?.accountId, parentId],
  )
}

/**
 * Every node in the account (D-4) — what an account-wide search reads.
 *
 * `enabled` is a parameter rather than a conditional hook call, and it earns its place: the whole
 * tree is needed only while a search is running, and reading it on every render of a folder listing
 * would be work nobody asked for. Disabled, it answers `[]` without touching the database.
 */
export function useAllFileNodes(enabled: boolean): FileNodeRow[] | undefined {
  const context = useReplicaOptional()
  return useLiveQuery<FileNodeRow[] | undefined>(async () => {
    if (!enabled) return []
    return context === null ? undefined : await fileNodesForAccount(context.db, context.accountId)
  }, [context?.db, context?.accountId, enabled])
}

/** When the file tree was last walked, and whether that walk saw all of it (D-4). */
export function useFileTreeState(): FileTreeState | undefined {
  const context = useReplicaOptional()
  return useLiveQuery<FileTreeState | undefined>(
    async () =>
      context === null ? undefined : await getFileTreeState(context.db, context.accountId),
    [context?.db, context?.accountId],
  )
}

/** A local preference value (FR-MBX-04), typed by the caller. */
export function useLocalPref<T>(key: string): T | undefined {
  const row = useReplicaQuery(({ db, accountId }) => db.localPrefs.get([accountId, key]), [key])
  return row?.value as T | undefined
}

/**
 * Like {@link useMailbox}, but yields `undefined` OUTSIDE a `ReplicaProvider` instead of throwing.
 *
 * `AppShell` needs this and cannot use the throwing form: `SyncEngineHost` returns its children
 * WITHOUT a provider while `connected` is null, which happens on every reload for as long as the
 * session takes to restore. A shell-level hook that assumes the provider therefore crashes the app
 * during exactly that window — it did, and the symptom was a reload landing back on the sign-in
 * screen with "Something went wrong".
 */
export function useMailboxOptional(id: Id | undefined): MailboxRow | undefined {
  const context = useReplicaOptional()
  return useLiveQuery<MailboxRow | undefined>(
    async () =>
      context === null || id === undefined
        ? undefined
        : await context.db.mailboxes.get([context.accountId, id]),
    [context?.db, context?.accountId, id],
  )
}

/**
 * Like {@link useMailboxByRole}, but yields `undefined` outside a `ReplicaProvider` instead of
 * throwing — for the same reason {@link useMailboxOptional} exists: `AppShell` mounts hooks while
 * `SyncEngineHost` is still rendering its children without a provider.
 */
export function useMailboxByRoleOptional(role: string): MailboxRow | undefined {
  const context = useReplicaOptional()
  return useLiveQuery<MailboxRow | undefined>(
    async () =>
      context === null ? undefined : await mailboxByRole(context.db, context.accountId, role),
    [context?.db, context?.accountId, role],
  )
}

/**
 * Like {@link useLocalPref}, but yields `undefined` OUTSIDE a `ReplicaProvider` instead of throwing
 * (M3.7).
 *
 * The composer and the reading pane are unit-tested without a replica — they inject a fake uploader
 * and a fake port instead — so reaching for the throwing hook there would break some twenty existing
 * tests and, worse, make a settings-backed default a reason for a pane to crash. `undefined` means
 * "no stored preference", which is exactly what the caller's fallback already handles.
 */
export function useLocalPrefOptional<T>(key: string): T | undefined {
  const context = useReplicaOptional()
  const row = useLiveQuery<LocalPrefRow | undefined>(
    async () =>
      context === null ? undefined : await context.db.localPrefs.get([context.accountId, key]),
    [context?.db, context?.accountId, key],
  )
  return row?.value as T | undefined
}
