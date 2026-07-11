/**
 * Crash-restore (M2.6, FR-CMP-03). On mount, reopens every UNSYNCED local draft (a `pending`/`error`
 * row that never reached the Drafts folder) as a MINIMIZED chip, so a refresh/crash never loses
 * un-uploaded work. Synced drafts live in the Drafts mailbox and are reopened on demand instead.
 * Idempotent: {@link ComposerActions.openDraft} focuses an already-open draft rather than duplicating.
 *
 * Mounted once inside the connected shell (inside {@link ReplicaProvider}); runs when the replica
 * becomes available.
 */

import { useEffect } from 'react'
import { listDrafts, useReplicaOptional } from '../sync'
import { useComposerStore } from './composer-store'
import { deserializeDraft } from './draft-email'

export function useDraftRestore(): void {
  const replica = useReplicaOptional()
  useEffect(() => {
    if (replica === null) return
    let cancelled = false
    void (async () => {
      const rows = await listDrafts(replica.db, replica.accountId)
      if (cancelled) return
      const openDraft = useComposerStore.getState().openDraft
      for (const row of rows) {
        if (row.status === 'synced') continue
        openDraft({ ...deserializeDraft(row), mode: 'minimized' })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [replica])
}
