/**
 * ONE mailbox subscription per account, app-wide (B10, ADR-035).
 *
 * ## The defect
 *
 * Every `useMailboxes()` / `useMailboxByRole()` call site used to open its OWN Dexie `liveQuery`.
 * There were 29 of them, at least three in the triage path alone (`MessageList`,
 * `useShortcutContext`, `useTriage`), and independent subscriptions resolve on independent ticks —
 * so for one `storagemutated` → re-query → render cycle two components could hold DIFFERENT mailbox
 * lists and act on them. Proven directly rather than argued: with the reveal layer already
 * re-rendered without Archive, `e` still dispatched `{kind:'move', to:'archive'}` into the mailbox
 * that had just been deleted.
 *
 * The window is small (single-digit ms) and it fails visibly — the move lands in the outbox, the
 * server rejects it against a destroyed mailbox, `use-outbox-problems.ts` surfaces the dead letter.
 * But it is not shortcut-specific, so fixing it in any one layer would have been theatre, and the
 * row that tracked it said so: the airtight fix is one shared subscription, which is this file.
 *
 * ## The shape
 *
 * A module-level store per `(db, accountId)`, in the `useSyncExternalStore` shape this app already
 * uses for `theme.ts`, `layout.ts` and `offline-prefs.ts` — not a React context. Context would have
 * to be mounted somewhere, and the consumers are not all under one provider: the folder rail scopes
 * a provider per account (M4.4 Etappe 4), `useSearch` runs ABOVE the account scope it feeds, and a
 * context high enough to cover them all would re-render the whole shell on every mailbox write.
 *
 * Keyed by the db OBJECT (a `WeakMap`), not by its name: the test suite builds a fresh `ReplicaDb`
 * per test and a name key would hand test N+1 the entry test N left behind, subscribed to a deleted
 * database. The subscription is torn down when the last consumer unmounts, so nothing survives a
 * test either way.
 *
 * ## What this does NOT promise
 *
 * That two components render the same list in the same COMMIT — React decides that. What it
 * guarantees is that they read one snapshot from one query: there is no longer a second
 * subscription that can be a tick behind, which is the thing that produced the wrong move.
 */

import type { Id } from '@waxwing/jmap'
import { liveQuery, type Subscription } from 'dexie'
import { useCallback, useSyncExternalStore } from 'react'
import type { MailboxRow, ReplicaDb } from './db'
import { mailboxesForAccount } from './repo'

interface Entry {
  /** `undefined` until the first query resolves — the same "not yet known" every caller already handles. */
  snapshot: MailboxRow[] | undefined
  readonly listeners: Set<() => void>
  subscription: Subscription | null
}

const byDb = new WeakMap<ReplicaDb, Map<Id, Entry>>()

function entryFor(db: ReplicaDb, accountId: Id): Entry {
  let forDb = byDb.get(db)
  if (forDb === undefined) {
    forDb = new Map()
    byDb.set(db, forDb)
  }
  let entry = forDb.get(accountId)
  if (entry === undefined) {
    entry = { snapshot: undefined, listeners: new Set(), subscription: null }
    forDb.set(accountId, entry)
  }
  return entry
}

function subscribeTo(db: ReplicaDb, accountId: Id, entry: Entry): void {
  entry.subscription = liveQuery(() => mailboxesForAccount(db, accountId)).subscribe({
    next: (rows) => {
      entry.snapshot = rows
      for (const listener of [...entry.listeners]) listener()
    },
    // A failed query leaves the last snapshot standing rather than blanking every folder tree in
    // the app. Dexie retries on the next `storagemutated`; a transient failure (a version upgrade
    // mid-flight) must not empty the UI.
    error: () => {},
  })
}

/**
 * The account's mailboxes, from the ONE subscription. `undefined` until it first resolves.
 *
 * `db` and `accountId` are parameters rather than context reads because two callers sit outside the
 * account scope they ask about (`useMailboxesFor`, and `useSearch` above the provider). The hooks in
 * `react.tsx` are the context-reading wrappers.
 */
export function useSharedMailboxes(db: ReplicaDb, accountId: Id): MailboxRow[] | undefined {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const entry = entryFor(db, accountId)
      entry.listeners.add(onChange)
      if (entry.subscription === null) subscribeTo(db, accountId, entry)
      return () => {
        entry.listeners.delete(onChange)
        if (entry.listeners.size > 0) return
        // Last one out. Drop the subscription AND the snapshot: a remount re-queries, which is what
        // an unmounted-then-remounted tree should do anyway, and it keeps a closed database from
        // being held alive by a stale row array.
        entry.subscription?.unsubscribe()
        entry.subscription = null
        entry.snapshot = undefined
      }
    },
    [db, accountId],
  )
  const getSnapshot = useCallback(() => entryFor(db, accountId).snapshot, [db, accountId])
  // Server snapshot: this app does not server-render, and `undefined` is the honest answer for a
  // subscription that has not run.
  return useSyncExternalStore(subscribe, getSnapshot, () => undefined)
}
