/**
 * Write-through blob cache (M3.4, FR-OFF-02 "attachments on demand", FR-OFF-04 "LRU eviction of
 * bodies/attachments"). Until now every attachment open and every inline image re-downloaded its blob
 * from the server — so an attachment could not be re-opened offline, and FR-OFF-04's "evict
 * attachments" had nothing to evict.
 *
 * The contract is deliberately lopsided: a cache HIT is authoritative (stamped and returned, no
 * network), and a cache MISS or a failed cache WRITE is invisible — the bytes are always returned.
 * A read must never fail because we could not store its result.
 */

import type { Id } from '@waxwing/jmap'
import type { ReplicaDb } from './db'
import { getBlobMeta, putBlobMeta, touchBlob } from './repo'
import { isQuotaExceeded, reportStorageFull } from './storage'

/**
 * Blobs larger than this are streamed to the user but never stored: a 45 MB attachment would evict
 * hundreds of message bodies to cache one file the reader most likely opens once.
 */
export const MAX_CACHED_BLOB_BYTES = 10 * 1024 * 1024

/** The identity of a blob to fetch — an attachment part or an inline `cid:` image. */
export interface BlobRef {
  readonly blobId: Id
  readonly type: string
  readonly name: string | null
}

/** Downloads a blob's bytes (the authenticated JMAP `download` endpoint). */
export type BlobDownload = (ref: BlobRef) => Promise<Blob>

/**
 * Cached blob bytes: HIT → stamp `lastAccessedAt` (LRU) and return; MISS → download, store when it is
 * small enough, and return. `recover` (optional) gets ONE chance to free `needBytes` if the store hits
 * the quota; a second failure is reported as "storage full" and swallowed — the caller still gets its
 * bytes.
 */
export async function getOrFetchBlob(
  db: ReplicaDb,
  accountId: Id,
  ref: BlobRef,
  download: BlobDownload,
  now: number,
  recover?: (needBytes: number) => Promise<unknown>,
): Promise<Blob> {
  try {
    const cached = await getBlobMeta(db, accountId, ref.blobId)
    if (cached?.data != null) {
      await touchBlob(db, accountId, ref.blobId, now)
      return new Blob([cached.data], { type: cached.type ?? ref.type })
    }
  } catch {
    // A broken/closed cache must not stop the reader from seeing the attachment.
  }

  const blob = await download(ref)
  if (blob.size <= MAX_CACHED_BLOB_BYTES) {
    await store(db, accountId, ref, blob, now, recover)
  }
  return blob
}

/** Persist the bytes. BEST-EFFORT by construction: every failure path still leaves the read intact. */
async function store(
  db: ReplicaDb,
  accountId: Id,
  ref: BlobRef,
  blob: Blob,
  now: number,
  recover?: (needBytes: number) => Promise<unknown>,
): Promise<void> {
  const data = await blob.arrayBuffer()
  const write = () =>
    putBlobMeta(db, {
      accountId,
      blobId: ref.blobId,
      type: ref.type,
      size: blob.size,
      name: ref.name,
      data,
      fetchedAt: now,
      lastAccessedAt: now,
    })
  try {
    await write()
  } catch (error) {
    // Anything but a quota failure (a closed database, a serialization error) is a cache bug, not a
    // user-facing condition: stay silent, the read already succeeded.
    if (!isQuotaExceeded(error)) return
    if (recover === undefined) {
      reportStorageFull(now)
      return
    }
    try {
      await recover(blob.size)
      await write()
    } catch {
      // Recovery could not free enough: tell the user ONCE that mail is no longer cached, and move on.
      reportStorageFull(now)
    }
  }
}
