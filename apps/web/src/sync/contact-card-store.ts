/**
 * ONE contact-card subscription per account, app-wide (R-21) — the `mailbox-store.ts` arrangement
 * (B10, ADR-035) applied to the other full-table live query in this app.
 *
 * ## The defect
 *
 * `db.contactCards.where('accountId').equals(accountId).toArray()` is a whole-table read, and a
 * contact card carries its photo INLINE (`contact-photo.ts`, `PHOTO_MAX_BYTES = 64 KB` → ~85 KB of
 * base64). Three unrelated places opened one each: the contacts screen while it is mounted, the
 * sender card once per opening, and EVERY composer window — up to three at a time, each with its
 * own copy. Any transaction on `contactCards` (a delta carrying a card change, every optimistic
 * enqueue during an import) re-ran all of them, and each rerun deserialised the whole table again.
 * Measured on fake-indexeddb: 3 000 cards, 1 000 of them with an 85 KB photo (≈ 84 MB) → ~161 ms
 * per `toArray()`. Four subscriptions is four times that per write, on the main thread, on a phone.
 *
 * ## What this fixes and what it does not
 *
 * It removes the MULTIPLICATION: one query per account instead of one per consumer, so a write
 * costs a single read no matter how many surfaces are open. It does not make that one read cheaper
 * — the photos are still in the row. Getting them out means a `media` side table and a schema
 * migration; that is a separate, riskier change (this database's `.upgrade()` chain is one-way, and
 * an upgrade that aborts leaves `db.open()` rejecting forever), and it is recorded as still open in
 * `docs/reviews/2026-09-01-code-review.md` under R-21 rather than done here by halves.
 *
 * Keyed by the db OBJECT (a `WeakMap`), not by its name, for the reason `mailbox-store.ts` gives:
 * the suite builds a fresh `ReplicaDb` per test and a name key would hand the next one a
 * subscription to a deleted database.
 */

import type { Id } from '@waxwing/jmap'
import { liveQuery, type Subscription } from 'dexie'
import { useCallback, useSyncExternalStore } from 'react'
import type { ContactCardRow, ReplicaDb } from './db'
import { contactCardsForAccount } from './repo'

interface Entry {
  /** `undefined` until the first query resolves — the "not yet known" every caller already handles. */
  snapshot: ContactCardRow[] | undefined
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
  entry.subscription = liveQuery(() => contactCardsForAccount(db, accountId)).subscribe({
    next: (rows) => {
      entry.snapshot = rows
      for (const listener of [...entry.listeners]) listener()
    },
    // A failed query leaves the last snapshot standing rather than blanking every contact surface
    // in the app; Dexie retries on the next `storagemutated`.
    error: () => {},
  })
}

/**
 * The account's contact cards (individuals AND groups), from the ONE subscription. `undefined`
 * until it first resolves.
 *
 * `db` and `accountId` are parameters rather than context reads so the hook itself is
 * provider-independent, and `null` is a real argument: `useContactCards` (`react.tsx`) is called
 * from surfaces that render before the session restores and from a composer unit-tested without a
 * `ReplicaProvider`. A hook may not be called conditionally, so "there is no replica" is answered
 * HERE — no subscription, and the same `undefined` a query in flight gives.
 */
export function useSharedContactCards(
  db: ReplicaDb | null,
  accountId: Id | null,
): ContactCardRow[] | undefined {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (db === null || accountId === null) return () => {}
      const entry = entryFor(db, accountId)
      entry.listeners.add(onChange)
      if (entry.subscription === null) subscribeTo(db, accountId, entry)
      return () => {
        entry.listeners.delete(onChange)
        if (entry.listeners.size > 0) return
        // Last one out: drop the subscription AND the snapshot, so a closed database is not held
        // alive by a stale row array and a remount re-queries.
        entry.subscription?.unsubscribe()
        entry.subscription = null
        entry.snapshot = undefined
      }
    },
    [db, accountId],
  )
  const getSnapshot = useCallback(
    () => (db === null || accountId === null ? undefined : entryFor(db, accountId).snapshot),
    [db, accountId],
  )
  // Server snapshot: this app does not server-render, and `undefined` is the honest answer for a
  // subscription that has not run.
  return useSyncExternalStore(subscribe, getSnapshot, () => undefined)
}
