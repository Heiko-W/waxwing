/**
 * The reader's blob source (M3.4): one hook that both attachment call sites — the attachment strip and
 * the inline-image bridge — go through, so a blob is downloaded from the server at most once and then
 * served from the replica (FR-OFF-02 "attachments on demand", FR-OFF-04 LRU).
 *
 * Downloads stay on the authenticated JMAP endpoint (SP.4: never a bare `<img src=downloadUrl>`), and
 * the caller keeps its object-URL create/revoke lifecycle exactly as it was (hardened in M2.7/ADR-009)
 * — this hook only replaces "where the bytes come from".
 *
 * Without a {@link ReplicaProvider} (component tests that render the reading pane in isolation) it
 * degrades to a plain download: caching is an optimization, never a precondition for rendering.
 */

import type { Id } from '@waxwing/jmap'
import { useCallback } from 'react'
import { useSession } from '../app/session/context'
import { type BlobRef, getOrFetchBlob, useReplicaOptional } from '../sync'
import { useAccountEngine } from '../sync/engine'

/** Fetches a blob's bytes: replica cache first, then the authenticated download. `null` = no client. */
export type BlobFetcher = (ref: BlobRef) => Promise<Blob | null>

export function useBlobFetcher(accountId: Id): BlobFetcher {
  const { getClient } = useSession()
  const replica = useReplicaOptional()
  // Named explicitly, because the account arrives as a prop rather than through the provider (M4.4
  // Etappe 4). The engine is only used to make room on a full disk, and `runMaintenance` evicts ITS
  // account's rows only: on the primary, a large shared-mailbox attachment would evict the primary's
  // cache and then hit `QuotaExceededError` again while the shared account's megabytes sit untouched.
  const engine = useAccountEngine(accountId)

  return useCallback(
    async (ref: BlobRef): Promise<Blob | null> => {
      const client = getClient()
      if (client === null) return null
      const download = async (target: BlobRef): Promise<Blob> => {
        const bytes = await client.download(
          accountId,
          target.blobId,
          target.type,
          target.name ?? 'attachment',
        )
        return new Blob([new Uint8Array(bytes)], { type: target.type })
      }
      if (replica === null) return download(ref)
      return getOrFetchBlob(replica.db, accountId, ref, download, Date.now(), (needBytes) =>
        engine === null ? Promise.resolve(null) : engine.runMaintenance({ force: true, needBytes }),
      )
    },
    [accountId, getClient, replica, engine],
  )
}
