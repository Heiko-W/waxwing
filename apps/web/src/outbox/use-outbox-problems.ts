/**
 * The dead-letter queue as a React source (M3.3). Live-queries the `error` outbox rows (so it is
 * correct across tabs and reloads — the queue is in the replica, not in memory) and binds the three
 * engine actions the user can take on one: retry it, discard it, or discard them all.
 */

import type { Id } from '@waxwing/jmap'
import { useCallback, useMemo } from 'react'
import {
  failedOutbox,
  type MailboxRow,
  type OutboxRow,
  useMailboxes,
  useReplica,
  useReplicaQuery,
} from '../sync'
import { getEngineFor } from '../sync/engine'

export interface OutboxProblems {
  /** Dead letters, oldest first. Empty (never `undefined`) while the first query resolves. */
  readonly rows: readonly OutboxRow[]
  /** Mailbox id → name, for the "Keep in {{folder}}" offer on an undone move. */
  readonly folderNames: ReadonlyMap<Id, string>
  /**
   * True once the mailbox names have loaded. A one-shot surface (the toast) MUST wait for this:
   * `folderNames` is empty both while it loads and when a folder is genuinely gone, and
   * {@link describeConflict} degrades to a plain "OK" when it cannot name the folder — so toasting
   * too early would permanently downgrade a "Keep in Inbox" offer to "OK" (the dedup never re-fires).
   * Re-rendering surfaces (the problems dialog) can ignore this — they simply re-render.
   */
  readonly ready: boolean
  retry: (id: Id) => Promise<void>
  discard: (id: Id) => Promise<void>
  discardAll: () => Promise<void>
}

function nameMap(mailboxes: MailboxRow[] | undefined): ReadonlyMap<Id, string> {
  return new Map((mailboxes ?? []).map((mailbox) => [mailbox.id, mailbox.name]))
}

export function useOutboxProblems(): OutboxProblems {
  // Read and write must name the SAME account (M4.4 Etappe 4, B33). The rows come from
  // `failedOutbox(db, accountId)` while `retryFailed`/`discardFailed`/`discardAllFailed` key on the
  // engine's own account — so the moment a shared-account dead letter can exist, Retry/Discard on one
  // would be a silent no-op and Discard-all would clear only the primary's. Unchanged today: both
  // consumers mount above the acting-account scope, so this resolves to the primary either way.
  //
  // The remaining half is B32: a shared account's dead letters are still not LISTED anywhere, because
  // these surfaces sit outside the scope and shared engines have a discarding status sink.
  const { accountId } = useReplica()
  const rows = useReplicaQuery(({ db, accountId: id }) => failedOutbox(db, id))
  const mailboxes = useMailboxes()

  const retry = useCallback(
    async (id: Id) => {
      await getEngineFor(accountId)?.retryFailed(id)
    },
    [accountId],
  )
  const discard = useCallback(
    async (id: Id) => {
      await getEngineFor(accountId)?.discardFailed(id)
    },
    [accountId],
  )
  const discardAll = useCallback(async () => {
    await getEngineFor(accountId)?.discardAllFailed()
  }, [accountId])

  const folderNames = useMemo(() => nameMap(mailboxes), [mailboxes])

  return {
    rows: rows ?? [],
    folderNames,
    ready: mailboxes !== undefined,
    retry,
    discard,
    discardAll,
  }
}
