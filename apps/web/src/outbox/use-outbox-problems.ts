/**
 * The dead-letter queue as a React source (M3.3, made account-complete by B32). Live-queries the
 * `error` outbox rows (so it is correct across tabs and reloads — the queue is in the replica, not in
 * memory) and binds the three engine actions the user can take on one: retry it, discard it, or
 * discard them all.
 *
 * ACROSS EVERY ACCOUNT, and that placement is deliberate. A dead letter is a record of the USER'S OWN
 * action, wherever it was aimed, so the surface listing them is device-global rather than scoped to
 * the account the action happened to hit — which is also why it stays mounted ABOVE
 * `ActiveAccountScope` (the composer must keep the user's own identity; see that module's header).
 * Since M4.4 stage 4 a triage action can be aimed at a delegated account and be refused there — and
 * a per-account read simply never saw it. That was B32's sharp end: a write that vanished.
 *
 * Two things follow from listing rows the acting account did not produce, and both are load-bearing:
 *
 *  - **Retry and discard resolve the engine of the ROW's account**, never the context's. Closing over
 *    one account id is what made B33 a silent no-op; generalised to N accounts it would be that bug
 *    again, one level up.
 *  - **`folderNames` is per account.** `describeConflict` offers "Keep in {{folder}}" by naming the
 *    row's source mailbox, and JMAP mailbox ids are per-account and short — one flat map would
 *    confidently name the WRONG folder for a shared account's row. `ready` is likewise per
 *    contributing account, because a toast built from half-loaded names permanently degrades to a
 *    plain "OK" (the dedup never re-fires).
 */

import type { Id } from '@waxwing/jmap'
import { useCallback, useMemo } from 'react'
import { secondaryMailAccounts } from '../app/session/accounts'
import { useSessionOptional } from '../app/session/context'
import {
  failedOutboxForAccounts,
  mailboxesForAccount,
  type OutboxRow,
  useReplica,
  useReplicaQuery,
} from '../sync'
import { getEngineFor } from '../sync/engine'

export interface OutboxProblems {
  /** Dead letters, oldest first, from every account. Empty (never `undefined`) while loading. */
  readonly rows: readonly OutboxRow[]
  /**
   * Mailbox names per account: `accountId → (mailboxId → name)`, for the "Keep in {{folder}}" offer.
   * Nested because mailbox ids collide across accounts — see this module's header.
   */
  readonly folderNames: ReadonlyMap<Id, ReadonlyMap<Id, string>>
  /**
   * True once the mailbox names of every CONTRIBUTING account have loaded. A one-shot surface (the
   * toast) MUST wait for this: names are empty both while they load and when a folder is genuinely
   * gone, and {@link describeConflict} degrades to a plain "OK" when it cannot name the folder — so
   * toasting too early would permanently downgrade a "Keep in Inbox" offer (the dedup never
   * re-fires). Re-rendering surfaces (the problems dialog) can ignore it — they simply re-render.
   */
  readonly ready: boolean
  /** How many accounts contributed a row — the surface names accounts only when this is > 1. */
  readonly accountCount: number
  retry: (id: Id) => Promise<void>
  discard: (id: Id) => Promise<void>
  discardAll: () => Promise<void>
}

export function useOutboxProblems(): OutboxProblems {
  const { accountId } = useReplica()
  const connected = useSessionOptional()

  /**
   * Every account that could hold a dead letter: the user's own plus every delegated one. Taken from
   * the SESSION rather than the replica's `accounts` registry, because the fleet only registers
   * accounts once something is shared — so on the single-account path the registry is deliberately
   * empty and would yield nothing.
   */
  const accountIds = useMemo<readonly Id[]>(() => {
    if (connected === null) return [accountId]
    return [connected.accountId, ...secondaryMailAccounts(connected).map((account) => account.id)]
  }, [connected, accountId])
  const accountKey = accountIds.join(',')

  const rows = useReplicaQuery(({ db }) => failedOutboxForAccounts(db, accountIds), [accountKey])

  // Mailbox names for every account that HAS a row, not for every account: on the single-account path
  // this is one query for the primary, exactly as before.
  const contributing = useMemo(() => [...new Set((rows ?? []).map((row) => row.accountId))], [rows])
  const contributingKey = contributing.join(',')
  const nameEntries = useReplicaQuery(
    async ({ db }) =>
      await Promise.all(
        contributing.map(
          async (id) =>
            [
              id,
              new Map((await mailboxesForAccount(db, id)).map((box) => [box.id, box.name])),
            ] as const,
        ),
      ),
    [contributingKey],
  )

  const folderNames = useMemo<ReadonlyMap<Id, ReadonlyMap<Id, string>>>(
    () => new Map(nameEntries ?? []),
    [nameEntries],
  )

  // Resolve the engine of the ROW's account — see the header. A row whose account has no running
  // engine cannot be acted on at all, which is the honest outcome: refuse rather than act elsewhere.
  const engineForRow = useCallback(
    (id: Id) => {
      const row = (rows ?? []).find((candidate) => candidate.id === id)
      return row === undefined ? null : getEngineFor(row.accountId)
    },
    [rows],
  )

  const retry = useCallback(
    async (id: Id) => {
      await engineForRow(id)?.retryFailed(id)
    },
    [engineForRow],
  )
  const discard = useCallback(
    async (id: Id) => {
      await engineForRow(id)?.discardFailed(id)
    },
    [engineForRow],
  )
  const discardAll = useCallback(async () => {
    // Every contributing account's engine, not just the acting one: "discard all" over a list that
    // shows N accounts must clear the list the user is looking at.
    await Promise.all(
      [...new Set((rows ?? []).map((row) => row.accountId))].map(
        async (id) => await getEngineFor(id)?.discardAllFailed(),
      ),
    )
  }, [rows])

  return {
    rows: rows ?? [],
    folderNames,
    ready: nameEntries !== undefined && nameEntries.length === contributing.length,
    accountCount: contributing.length,
    retry,
    discard,
    discardAll,
  }
}
