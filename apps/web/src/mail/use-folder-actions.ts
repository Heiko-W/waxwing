/**
 * Folder management actions (M1.5, FR-MBX-02) — the seam from the tree UI to the sync engine's
 * outbox. Each call dispatches an idempotent, client-id'd `OutboxIntent` that is applied to the
 * replica optimistically and replayed against the server. Reads the running engine lazily via
 * {@link getActiveEngine} so an event handler always sees the current one (and is a safe no-op
 * before the engine has started or where it cannot run). Rights are enforced by the UI *before*
 * offering an action (per-mailbox `myRights`); this hook only dispatches.
 */

import { useMemo } from 'react'
import { getActiveEngine, type OutboxIntent } from '../sync/engine'

export interface FolderActions {
  createChild(parentId: string | null, name: string): void
  rename(id: string, name: string): void
  move(id: string, parentId: string | null): void
  remove(id: string): void
}

function newId(): string {
  return crypto.randomUUID()
}

function dispatch(intent: OutboxIntent): void {
  void getActiveEngine()?.dispatch(intent, { id: newId() })
}

export function useFolderActions(): FolderActions {
  return useMemo(
    () => ({
      createChild: (parentId, name) =>
        dispatch({ kind: 'createMailbox', creationId: newId(), props: { name, parentId } }),
      rename: (id, name) => dispatch({ kind: 'renameMailbox', id, name }),
      move: (id, parentId) => dispatch({ kind: 'moveMailbox', id, parentId }),
      remove: (id) => dispatch({ kind: 'deleteMailbox', id }),
    }),
    [],
  )
}
