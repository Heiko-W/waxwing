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
import { type DraftSyncStatus, listDrafts, useReplicaOptional } from '../sync'
import { useComposerStore } from './composer-store'
import { deserializeDraft } from './draft-email'

/**
 * Does the SERVER already hold this row's content? Only then may crash-restore skip it.
 *
 * Written as an exhaustive switch, and that is the whole point of it being a function: the
 * predicate used to be an inline `=== 'synced' || === 'sending'`, so a fifth {@link DraftSyncStatus}
 * would silently have joined the "reopen it" side with nobody asked. With no `default` arm, adding
 * one stops the BUILD here (a code path that returns no `boolean`) until someone decides what it
 * means for a crash.
 *
 * The runtime fallback is the same decision, made the safe way round: a value outside the type — an
 * older tab reading a replica a newer build wrote — falls out of the switch as `undefined`, reads as
 * "the server does not have it", and the draft is reopened. A duplicate chip is a nuisance; an
 * unrestored draft is lost work.
 */
function serverHasTheContent(status: DraftSyncStatus): boolean {
  switch (status) {
    // Safe in the Drafts folder; reopened on demand from there instead.
    case 'synced':
      return true
    // In the send pipeline (M2.8): the outbox fires it, and a failure re-surfaces it as `error` on a
    // later load. Reopening it as an editable draft would offer to send it twice.
    case 'sending':
      return true
    // The text exists nowhere else — this is what crash-restore is FOR.
    case 'pending':
      return false
    // A rejected save still holds unsaved content; a rejected send is reopened by the notifier.
    case 'error':
      return false
  }
}

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
        if (serverHasTheContent(row.status)) continue
        openDraft({ ...deserializeDraft(row), mode: 'minimized' })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [replica])
}
