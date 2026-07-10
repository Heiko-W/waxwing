/**
 * Bulk message actions (M1.6, FR-LST-04, FR-ORG-01) — the seam from the list's selection to the
 * engine outbox. Each call dispatches ONE idempotent, client-id'd intent over the whole selected
 * id set (optimistic apply now, replay on the next sync). Mirrors {@link useFolderActions}; reads
 * the running engine lazily so a handler always sees the current one (safe no-op before it starts).
 * archive/junk/trash are just a `move` to that role mailbox — the caller resolves role → id.
 */

import type { Id } from '@waxwing/jmap'
import { useMemo } from 'react'
import { getActiveEngine, type OutboxIntent } from '../sync/engine'

export interface MessageActions {
  /** Mark read/unread (`$seen`). */
  setSeen(ids: Id[], seen: boolean): void
  /** Flag/unflag (`$flagged`). */
  setFlagged(ids: Id[], flagged: boolean): void
  /** Move out of `from` (null = keep other memberships) into `to` — archive/junk/trash/arbitrary. */
  move(ids: Id[], from: Id | null, to: Id): void
  /** Permanently destroy (Trash → purge). */
  destroy(ids: Id[]): void
}

function dispatch(intent: OutboxIntent): void {
  if (intent.kind === 'setKeywords' || intent.kind === 'move' || intent.kind === 'destroyEmails') {
    if (intent.emailIds.length === 0) return
  }
  void getActiveEngine()?.dispatch(intent, { id: crypto.randomUUID() })
}

export function useMessageActions(): MessageActions {
  return useMemo(
    () => ({
      setSeen: (ids, seen) =>
        dispatch({ kind: 'setKeywords', emailIds: ids, keyword: '$seen', value: seen }),
      setFlagged: (ids, flagged) =>
        dispatch({ kind: 'setKeywords', emailIds: ids, keyword: '$flagged', value: flagged }),
      move: (ids, from, to) => dispatch({ kind: 'move', emailIds: ids, from, to }),
      destroy: (ids) => dispatch({ kind: 'destroyEmails', emailIds: ids }),
    }),
    [],
  )
}
