/**
 * Bulk message actions (M1.6, FR-LST-04, FR-ORG-01) — the seam from the list's selection to the
 * engine outbox. Each call dispatches ONE idempotent, client-id'd intent over the whole selected
 * id set (optimistic apply now, replay on the next sync). Mirrors {@link useFolderActions}.
 * archive/junk/trash are just a `move` to that role mailbox — the caller resolves role → id.
 *
 * The engine is the one for `useReplica().accountId` — the account THIS subtree acts in (M4.4
 * Etappe 4) — and it is still resolved lazily inside each handler, so a handler always sees the
 * current engine (a safe no-op before it starts, or where none serves this account).
 *
 * What is captured is the ACCOUNT, not the engine, and that is the correctness point.
 * {@link useTriage}'s undo closure dispatches the INVERSE move up to five seconds later; toasts
 * survive `resetMailScopedStores`, which clears the list/reading/palette stores only. A handler that
 * asked "which account is active?" when Undo is CLICKED would send that inverse move to whatever
 * account the user had switched to in the meantime — the cross-account write, on the recovery path.
 * Re-resolving the engine FOR A CAPTURED ACCOUNT is safe and survives a fleet rebuild; re-resolving
 * the account is not.
 */

import type { Id } from '@waxwing/jmap'
import { useMemo } from 'react'
import { getEngineFor, type OutboxIntent, useAccountEngine } from '../sync/engine'
import { useReplicaOptional } from '../sync/react'

export interface MessageActions {
  /**
   * True when an engine serves this hook's account, i.e. a dispatch really is queued. `false` means
   * the caller must not claim the action happened — see {@link useTriage}, which gates its toast.
   */
  readonly available: boolean
  /** Mark read/unread (`$seen`). */
  setSeen(ids: Id[], seen: boolean): void
  /** Flag/unflag (`$flagged`). */
  setFlagged(ids: Id[], flagged: boolean): void
  /** Add/remove an arbitrary keyword (label assign/remove — M3.2). */
  setKeyword(ids: Id[], keyword: string, value: boolean): void
  /** Move out of `from` (null = keep other memberships) into `to` — archive/junk/trash/arbitrary. */
  move(ids: Id[], from: Id | null, to: Id): void
  /** Permanently destroy (Trash → purge). */
  destroy(ids: Id[]): void
}

function dispatch(accountId: Id | null, intent: OutboxIntent): void {
  if (intent.kind === 'setKeywords' || intent.kind === 'move' || intent.kind === 'destroyEmails') {
    if (intent.emailIds.length === 0) return
  }
  void getEngineFor(accountId)?.dispatch(intent, { id: crypto.randomUUID() })
}

export function useMessageActions(): MessageActions {
  const accountId = useReplicaOptional()?.accountId ?? null
  // Read reactively for `available` only — the handlers below resolve the engine themselves, lazily.
  const engine = useAccountEngine()
  return useMemo(
    () => ({
      available: engine !== null,
      setSeen: (ids, seen) =>
        dispatch(accountId, { kind: 'setKeywords', emailIds: ids, keyword: '$seen', value: seen }),
      setFlagged: (ids, flagged) =>
        dispatch(accountId, {
          kind: 'setKeywords',
          emailIds: ids,
          keyword: '$flagged',
          value: flagged,
        }),
      setKeyword: (ids, keyword, value) =>
        dispatch(accountId, { kind: 'setKeywords', emailIds: ids, keyword, value }),
      move: (ids, from, to) => dispatch(accountId, { kind: 'move', emailIds: ids, from, to }),
      destroy: (ids) => dispatch(accountId, { kind: 'destroyEmails', emailIds: ids }),
    }),
    [accountId, engine],
  )
}
