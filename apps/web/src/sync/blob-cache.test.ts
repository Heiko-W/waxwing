import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getOrFetchBlob, MAX_CACHED_BLOB_BYTES } from './blob-cache'
import type { BlobMetaRow, ReplicaDb } from './db'
import { getStorageFullAt, resetStorageFull } from './storage'
import { freshDb } from './test-utils'

const ACC = 'acc'
const REF = { blobId: 'b1', type: 'image/png', name: 'shot.png' }

let db: ReplicaDb

/** A blob of exactly `size` bytes. */
function blobOf(size: number, fill = 7): Blob {
  return new Blob([new Uint8Array(size).fill(fill)], { type: REF.type })
}

beforeEach(() => {
  db = freshDb()
  resetStorageFull()
})

afterEach(async () => {
  resetStorageFull()
  await db.delete()
})

describe('getOrFetchBlob', () => {
  it('MISS: downloads, returns the bytes, and stores them with their size', async () => {
    const download = vi.fn(async () => blobOf(1024))

    const blob = await getOrFetchBlob(db, ACC, REF, download, 1000)

    expect(download).toHaveBeenCalledTimes(1)
    expect(blob.size).toBe(1024)
    const row = await db.blobsMeta.get([ACC, 'b1'])
    expect(row?.bytes).toBe(1024)
    expect(row?.data?.byteLength).toBe(1024)
    expect(row?.lastAccessedAt).toBe(1000)
  })

  it('HIT: serves the cached bytes without a download and stamps the LRU', async () => {
    const download = vi.fn(async () => blobOf(8, 3))
    await getOrFetchBlob(db, ACC, REF, download, 1000)

    const again = await getOrFetchBlob(db, ACC, REF, download, 5000)

    expect(download).toHaveBeenCalledTimes(1) // no second network round-trip
    expect(new Uint8Array(await again.arrayBuffer())).toEqual(new Uint8Array(8).fill(3))
    expect((await db.blobsMeta.get([ACC, 'b1']))?.lastAccessedAt).toBe(5000)
    // The bytes are stored as an ArrayBuffer and rehydrated into a Blob, so the MIME type is NOT
    // carried by the payload — it is re-applied from the row. Lose it and every cached image and PDF
    // preview silently breaks (an `<img>`/`<iframe>` on a typeless blob: URL renders nothing), while
    // the bytes themselves still compare equal and every other assertion here still passes.
    expect(again.type).toBe('image/png')
  })

  it('OVERSIZE: a huge attachment is returned but never cached (it would evict the whole mailbox)', async () => {
    const download = vi.fn(async () => blobOf(MAX_CACHED_BLOB_BYTES + 1))

    const blob = await getOrFetchBlob(db, ACC, REF, download, 1000)

    expect(blob.size).toBe(MAX_CACHED_BLOB_BYTES + 1)
    expect(await db.blobsMeta.get([ACC, 'b1'])).toBeUndefined()
  })

  it('a failed cache write NEVER fails the read', async () => {
    const put = vi.spyOn(db.blobsMeta, 'put').mockRejectedValue(new Error('disk on fire'))
    const download = vi.fn(async () => blobOf(64))

    const blob = await getOrFetchBlob(db, ACC, REF, download, 1000)

    expect(blob.size).toBe(64) // the user still sees the attachment
    expect(put).toHaveBeenCalled()
  })

  it('a quota failure recovers once, retries once, and reports "storage full" if it still fails', async () => {
    const quota = () => new DOMException('quota', 'QuotaExceededError')
    const put = vi.spyOn(db.blobsMeta, 'put').mockRejectedValue(quota())
    const recover = vi.fn(async () => undefined)
    const download = vi.fn(async () => blobOf(64))

    const blob = await getOrFetchBlob(db, ACC, REF, download, 4242, recover)

    expect(blob.size).toBe(64) // still returned
    expect(recover).toHaveBeenCalledTimes(1)
    expect(recover).toHaveBeenCalledWith(64) // it asked for exactly what it needed
    expect(put).toHaveBeenCalledTimes(2) // one attempt, one retry — no loop
    expect(getStorageFullAt()).toBe(4242) // and the user is told, once
  })

  it('recovers and then SUCCEEDS on the retry, without reporting anything to the user', async () => {
    let attempts = 0
    const original = db.blobsMeta.put.bind(db.blobsMeta)
    vi.spyOn(db.blobsMeta, 'put').mockImplementation(((row: BlobMetaRow) => {
      attempts += 1
      if (attempts === 1) return Promise.reject(new DOMException('quota', 'QuotaExceededError'))
      return original(row)
    }) as typeof db.blobsMeta.put)

    await getOrFetchBlob(
      db,
      ACC,
      REF,
      async () => blobOf(32),
      1000,
      async () => undefined,
    )

    expect(attempts).toBe(2)
    expect(getStorageFullAt()).toBe(0) // recovery worked — no toast
    vi.restoreAllMocks()
    expect((await db.blobsMeta.get([ACC, 'b1']))?.bytes).toBe(32)
  })
})
