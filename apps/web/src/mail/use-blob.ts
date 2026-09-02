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

import { BlobTooLargeError, DEFAULT_MAX_DOWNLOAD_BYTES, type Id } from '@waxwing/jmap'
import { useCallback } from 'react'
import { useSession } from '../app/session/context'
import { type BlobRef, getOrFetchBlob, useReplicaOptional } from '../sync'
import { useAccountEngine } from '../sync/engine'
import { classifySourceError, type MessageSourceError } from './use-message-source'

/** Fetches a blob's bytes: replica cache first, then the authenticated download. `null` = no client. */
export type BlobFetcher = (ref: BlobRef) => Promise<Blob | null>

/**
 * Slack over the size the envelope declared, before a download is refused (W-11's remaining half,
 * R-11).
 *
 * `EmailBodyPart.size` is the decoded octet count, so in principle it is exact — but it is a number
 * the SERVER wrote about its own bytes, and a client that turns a small disagreement into "this
 * attachment cannot be opened" has traded a rare denial-of-service for a common false refusal.
 * Doubling it plus a megabyte leaves room for a server that reports the encoded size, or rounds, or
 * is simply a little wrong, while still bounding an ENDLESS stream to twice what it promised —
 * which is the shape the ceiling exists for.
 */
const SIZE_TOLERANCE_FACTOR = 2
const SIZE_TOLERANCE_FLOOR_BYTES = 1024 * 1024

/**
 * The ceiling for one download, from the size the envelope declared. `undefined` — the package's own
 * 256 MB backstop — when there is no declared size to derive one from.
 *
 * Never ABOVE the backstop: a part that claims 400 MB does not get to raise the ceiling by claiming
 * it. `downloadBlob` checks `content-length` before reading a byte and counts as it reads, so both
 * a declared and an undeclared overrun are refused.
 */
export function downloadCeiling(size: number | undefined): number | undefined {
  if (size === undefined || !Number.isFinite(size) || size <= 0) return undefined
  return Math.min(
    size * SIZE_TOLERANCE_FACTOR + SIZE_TOLERANCE_FLOOR_BYTES,
    DEFAULT_MAX_DOWNLOAD_BYTES,
  )
}

/**
 * What a failed blob download can be told apart into, for a surface that has to SAY something.
 *
 * `MessageSourceDialog` and `NestedMessageView` already classify their downloads this way; the
 * attachment strip did not classify at all, because it did not catch at all. `tooLarge` is the
 * fourth case those two never had to name: it only became reachable once callers started passing a
 * ceiling derived from the envelope's own `size` (W-11's remaining half).
 */
export type BlobError = MessageSourceError | 'tooLarge'

export function classifyBlobError(error: unknown): BlobError {
  if (error instanceof BlobTooLargeError) return 'tooLarge'
  return classifySourceError(error)
}

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
        const maxBytes = downloadCeiling(target.size)
        const bytes = await client.download(
          accountId,
          target.blobId,
          target.type,
          target.name ?? 'attachment',
          maxBytes === undefined ? {} : { maxBytes },
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
