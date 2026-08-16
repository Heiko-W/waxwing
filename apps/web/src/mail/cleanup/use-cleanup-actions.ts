/**
 * Folder-cleanup actions (M3.2) — the seam from the folder UI to the engine's chunked destroy.
 * {@link daysAgoIso} is pure (UTC-midnight, matching the search-query date math) so the "older than N
 * days" boundary is deterministic and unit-testable.
 *
 * The engine is the one for `useReplica().accountId` — the account THIS tree belongs to (M4.4
 * Etappe 4) — resolved lazily inside each handler, so a handler always sees the current one and is a
 * safe no-op before it starts.
 *
 * This is the highest-severity of the dispatch sites, because it is the one that destroys without a
 * per-message step: `emptyMailbox` pages `Email/query` against ITS engine's account, so run on the
 * primary with a shared account's short mailbox id it permanently destroys the contents of a
 * DIFFERENT account's folder. The `undefined`-on-no-engine contract is unchanged, and it is now also
 * the affordance for an account with no running engine — the desired failure mode: refuse, and let
 * the UI report a cleanup that could not start.
 */

import type { Id } from '@waxwing/jmap'
import { useMemo } from 'react'
import { getEngineFor } from '../../sync/engine'
import { useReplicaOptional } from '../../sync/react'

const DAY_MS = 86_400_000

/** UTC-midnight ISO of the day `days` days before `now` (the exclusive `before` bound). */
export function daysAgoIso(days: number, now: number): string {
  const target = now - days * DAY_MS
  return new Date(Math.floor(target / DAY_MS) * DAY_MS).toISOString()
}

export interface CleanupActions {
  /** Empty a mailbox (destroy all messages). `undefined` when no engine is active. */
  emptyMailbox(mailboxId: Id): Promise<{ scheduled: number }> | undefined
  /** PERMANENTLY destroy messages older than `days` in a mailbox (Trash/Junk cleanup). */
  deleteOlderThan(mailboxId: Id, days: number): Promise<{ scheduled: number }> | undefined
  /** MOVE messages older than `days` from a mailbox to `toMailboxId` (recoverable — normal folders). */
  trashOlderThan(
    mailboxId: Id,
    toMailboxId: Id,
    days: number,
  ): Promise<{ scheduled: number }> | undefined
}

export function useCleanupActions(): CleanupActions {
  const accountId = useReplicaOptional()?.accountId ?? null
  return useMemo(
    () => ({
      emptyMailbox: (mailboxId) => getEngineFor(accountId)?.emptyMailbox(mailboxId),
      deleteOlderThan: (mailboxId, days) =>
        getEngineFor(accountId)?.deleteOlderThan(mailboxId, daysAgoIso(days, Date.now())),
      trashOlderThan: (mailboxId, toMailboxId, days) =>
        getEngineFor(accountId)?.trashOlderThan(
          mailboxId,
          toMailboxId,
          daysAgoIso(days, Date.now()),
        ),
    }),
    [accountId],
  )
}
