/**
 * Folder management actions (M1.5, FR-MBX-02) — the seam from the tree UI to the sync engine's
 * outbox. Each call dispatches an idempotent, client-id'd `OutboxIntent` that is applied to the
 * replica optimistically and replayed against the server. Rights are enforced by the UI *before*
 * offering an action (per-mailbox `myRights`); this hook only dispatches.
 *
 * The engine is the one for `useReplica().accountId` — the account THIS tree belongs to (M4.4
 * Etappe 4) — resolved lazily inside each handler, so an event handler always sees the current one
 * (a safe no-op before the engine has started or where it cannot run).
 *
 * A single "active engine" cannot serve this file: the tree is rendered once PER ACCOUNT
 * (`AccountTrees.tsx`), so a shared account's tree the user is not currently in is still on screen
 * and still clickable. Before Etappe 4 a rename/delete from one reached the PRIMARY engine carrying
 * the shared account's short mailbox id — which almost always names a different, existing primary
 * folder.
 */

import type { Id } from '@waxwing/jmap'
import { useMemo } from 'react'
import { getEngineFor, type OutboxIntent } from '../sync/engine'
import { useReplicaOptional } from '../sync/react'

export interface FolderActions {
  createChild(parentId: string | null, name: string): void
  rename(id: string, name: string): void
  move(id: string, parentId: string | null): void
  remove(id: string): void
}

function newId(): string {
  return crypto.randomUUID()
}

function dispatch(accountId: Id | null, intent: OutboxIntent): void {
  void getEngineFor(accountId)?.dispatch(intent, { id: newId() })
}

export function useFolderActions(): FolderActions {
  const accountId = useReplicaOptional()?.accountId ?? null
  return useMemo(
    () => ({
      createChild: (parentId, name) =>
        dispatch(accountId, {
          kind: 'createMailbox',
          creationId: newId(),
          props: { name, parentId },
        }),
      rename: (id, name) => dispatch(accountId, { kind: 'renameMailbox', id, name }),
      move: (id, parentId) => dispatch(accountId, { kind: 'moveMailbox', id, parentId }),
      remove: (id) => dispatch(accountId, { kind: 'deleteMailbox', id }),
    }),
    [accountId],
  )
}
