/**
 * Folder-cleanup actions (M3.2) — the seam from the folder UI to the engine's chunked destroy. Reads
 * the running engine lazily via {@link getActiveEngine} so a handler always sees the current one (and
 * is a safe no-op before it starts). {@link daysAgoIso} is pure (UTC-midnight, matching the
 * search-query date math) so the "older than N days" boundary is deterministic and unit-testable.
 */

import type { Id } from '@waxwing/jmap'
import { useMemo } from 'react'
import { getActiveEngine } from '../../sync/engine'

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
  return useMemo(
    () => ({
      emptyMailbox: (mailboxId) => getActiveEngine()?.emptyMailbox(mailboxId),
      deleteOlderThan: (mailboxId, days) =>
        getActiveEngine()?.deleteOlderThan(mailboxId, daysAgoIso(days, Date.now())),
      trashOlderThan: (mailboxId, toMailboxId, days) =>
        getActiveEngine()?.trashOlderThan(mailboxId, toMailboxId, daysAgoIso(days, Date.now())),
    }),
    [],
  )
}
