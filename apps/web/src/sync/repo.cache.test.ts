/**
 * The M3.4 storage layer: the key-only cache reads, the `deleteEmails` cascade, and the v5 upgrade.
 *
 * The load-bearing claim under test is the KEY-ONLY zip: `bodyCacheEntries` reads an index cursor
 * twice — once for its keys, once for its primary keys — and pairs them BY POSITION. That is only
 * sound if both passes walk the index in the same order. If IndexedDB ever did otherwise, eviction
 * would delete the wrong messages, so it is asserted rather than assumed.
 */

import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BODY_OVERHEAD_BYTES,
  collectBodyBlobIds,
  type EmailBodyRow,
  estimateBodyBytes,
  ReplicaDb as Replica,
  type ReplicaDb,
  scopeKey,
} from './db'
import {
  blobCacheEntries,
  blobOwners,
  bodyCacheEntries,
  deleteEmails,
  envelopeCount,
  envelopeIdsBefore,
  PALETTE_RECENTS_KEY,
  putBlobMeta,
  putEmailBody,
  putEmails,
  touchBlob,
  updatePaletteRecents,
  updatePinnedMailboxes,
} from './repo'
import { email, freshDb } from './test-utils'

const ACC = 'acc'

const PART = {
  partId: '1',
  blobId: null,
  size: 1,
  type: 'text/plain',
  name: null,
  charset: null,
  disposition: null,
  cid: null,
  language: null,
  location: null,
  subParts: null,
} as unknown as EmailBodyRow['bodyStructure']

let db: ReplicaDb

function body(
  id: string,
  text: string,
  lastAccessedAt: number,
): Omit<EmailBodyRow, 'bytes' | 'ablob'> {
  return {
    accountId: ACC,
    id,
    bodyValues: { t: { value: text, isEncodingProblem: false, isTruncated: false } },
    bodyStructure: PART,
    textBody: [PART],
    htmlBody: [],
    attachments: [],
    hasAttachment: false,
    fetchedAt: 1,
    lastAccessedAt,
  }
}

beforeEach(() => {
  db = freshDb()
})

afterEach(async () => {
  await db.delete()
})

describe('size accounting', () => {
  it('estimateBodyBytes is deterministic: UTF-16 payload + a flat overhead', () => {
    expect(estimateBodyBytes({ bodyValues: {} })).toBe(BODY_OVERHEAD_BYTES)
    expect(
      estimateBodyBytes({
        bodyValues: { a: { value: 'abcde', isEncodingProblem: false, isTruncated: false } },
      }),
    ).toBe(10 + BODY_OVERHEAD_BYTES)
  })

  it('putEmailBody derives `bytes` and `ablob` — a caller cannot forget them', async () => {
    await putEmailBody(db, {
      ...body('e1', 'hello', 5),
      attachments: [
        { ...PART, blobId: 'blob-1' },
        { ...PART, blobId: 'blob-2' },
      ],
    })
    const row = await db.emailBodies.get([ACC, 'e1'])
    expect(row?.bytes).toBe(10 + BODY_OVERHEAD_BYTES)
    expect(row?.ablob).toEqual([scopeKey(ACC, 'blob-1'), scopeKey(ACC, 'blob-2')])
  })

  it('collectBodyBlobIds walks the whole part tree and dedupes', () => {
    const ids = collectBodyBlobIds({
      bodyStructure: { ...PART, blobId: 'root', subParts: [{ ...PART, blobId: 'inline' }] },
      textBody: [{ ...PART, blobId: 'root' }],
      htmlBody: [],
      attachments: [{ ...PART, blobId: 'file' }],
    } as unknown as EmailBodyRow)
    expect(ids).toEqual(['root', 'inline', 'file'])
  })
})

describe('key-only cache reads', () => {
  it('zips the index keys with the primary keys in the SAME cursor order', async () => {
    // Deliberately adversarial: identical `lastAccessedAt` (so the tie-break is by primary key), and
    // ids inserted out of order.
    await putEmailBody(db, body('zeta', 'aaa', 5))
    await putEmailBody(db, body('alpha', 'bbbbbb', 5))
    await putEmailBody(db, body('mid', 'c', 1))

    const entries = await bodyCacheEntries(db, ACC)

    // Every (id → bytes) pair must be the one actually stored: a mis-zip would swap them silently.
    const stored = new Map(
      (await db.emailBodies.toArray()).map((row) => [row.id, row.bytes] as const),
    )
    expect(entries).toHaveLength(3)
    for (const entry of entries) expect(entry.bytes).toBe(stored.get(entry.id))
    expect(entries.map((entry) => entry.id).sort()).toEqual(['alpha', 'mid', 'zeta'])
    expect(entries.find((entry) => entry.id === 'mid')?.lastAccessedAt).toBe(1)
  })

  it('scopes every read to the account (no bleed from a second account)', async () => {
    await putEmailBody(db, body('mine', 'x', 1))
    await putEmailBody(db, { ...body('theirs', 'x', 1), accountId: 'other' })
    expect((await bodyCacheEntries(db, ACC)).map((entry) => entry.id)).toEqual(['mine'])
  })

  it('blobCacheEntries + touchBlob keep the LRU stamp on the index', async () => {
    await putBlobMeta(db, {
      accountId: ACC,
      blobId: 'b1',
      type: 'image/png',
      size: 10,
      name: null,
      data: new Uint8Array(500).buffer,
      fetchedAt: 1,
      lastAccessedAt: 1,
    })
    expect(await blobCacheEntries(db, ACC)).toEqual([{ id: 'b1', bytes: 500, lastAccessedAt: 1 }])

    await touchBlob(db, ACC, 'b1', 9000)
    expect(await blobCacheEntries(db, ACC)).toEqual([
      { id: 'b1', bytes: 500, lastAccessedAt: 9000 },
    ])
  })

  it('blobOwners maps a blob back to the bodies that reference it, without loading a row', async () => {
    await putEmailBody(db, { ...body('e1', 'x', 1), attachments: [{ ...PART, blobId: 'shared' }] })
    await putEmailBody(db, { ...body('e2', 'x', 1), attachments: [{ ...PART, blobId: 'shared' }] })
    await putEmailBody(db, { ...body('e3', 'x', 1), attachments: [{ ...PART, blobId: 'own' }] })

    const owners = await blobOwners(db, ACC)

    expect(owners.get('shared')?.sort()).toEqual(['e1', 'e2'])
    expect(owners.get('own')).toEqual(['e3'])
    expect(owners.get('unknown')).toBeUndefined()
  })

  it('envelopeCount / envelopeIdsBefore serve the horizon off an index', async () => {
    await putEmails(db, ACC, [
      email('old', { receivedAt: '2020-01-01T00:00:00Z' }),
      email('new', { receivedAt: '2030-01-01T00:00:00Z' }),
    ])
    expect(await envelopeCount(db, ACC)).toBe(2)
    expect(await envelopeIdsBefore(db, ACC, '2025-01-01T00:00:00Z')).toEqual(['old'])
  })
})

describe('deleteEmails cascade', () => {
  it('deletes the body with its envelope — a delta sync no longer orphans bodies forever', async () => {
    await putEmails(db, ACC, [email('e1'), email('e2')])
    await putEmailBody(db, body('e1', 'one', 1))
    await putEmailBody(db, body('e2', 'two', 1))

    await deleteEmails(db, ACC, ['e1'])

    expect(await db.emails.get([ACC, 'e1'])).toBeUndefined()
    expect(await db.emailBodies.get([ACC, 'e1'])).toBeUndefined() // the leak this fixes
    expect(await db.emailBodies.get([ACC, 'e2'])).toBeDefined()
  })

  it('is a no-op for an empty id list (no transaction, no throw)', async () => {
    await expect(deleteEmails(db, ACC, [])).resolves.toBeUndefined()
  })
})

describe('pinned mailboxes', () => {
  it('read-modify-writes the pin set so two tabs cannot clobber each other', async () => {
    await updatePinnedMailboxes(db, ACC, (current) => [...current, 'work'])
    await updatePinnedMailboxes(db, ACC, (current) => [...current, 'projects'])
    const row = await db.localPrefs.get([ACC, 'offline.pinnedMailboxes'])
    expect(row?.value).toEqual(['work', 'projects'])
  })
})

// The palette's recents (M3.8). Same contract as the pin set and the label registry — Invariant 8:
// a `localPrefs` write is a transactional read-modify-write, never a blind `setPref`.
describe('updatePaletteRecents', () => {
  const recents = () => db.localPrefs.get([ACC, PALETTE_RECENTS_KEY]).then((row) => row?.value)

  it('is a read-modify-write: the second call sees the first call’s result', async () => {
    await updatePaletteRecents(db, ACC, (current) => ['action:triage.archive', ...current])
    await updatePaletteRecents(db, ACC, (current) => ['folder:inbox', ...current])
    expect(await recents()).toEqual(['folder:inbox', 'action:triage.archive'])
  })

  // THE reason this is a transaction: two tabs (or two quick runs) must not lose each other's write.
  // A blind `put` reads both lists before either commits, and the loser's id vanishes.
  it('two INTERLEAVED updates keep both writes (the sibling-tab clobber)', async () => {
    await Promise.all([
      updatePaletteRecents(db, ACC, (current) => ['action:a', ...current]),
      updatePaletteRecents(db, ACC, (current) => ['action:b', ...current]),
    ])
    expect(new Set((await recents()) as string[])).toEqual(new Set(['action:a', 'action:b']))
  })

  it('is account-scoped', async () => {
    await updatePaletteRecents(db, ACC, () => ['action:a'])
    await updatePaletteRecents(db, 'other', () => ['action:b'])
    expect(await recents()).toEqual(['action:a'])
    expect((await db.localPrefs.get(['other', PALETTE_RECENTS_KEY]))?.value).toEqual(['action:b'])
  })

  it('tolerates a garbage stored value (starts from an empty list)', async () => {
    await db.localPrefs.put({ accountId: ACC, key: PALETTE_RECENTS_KEY, value: 'not-an-array' })
    await updatePaletteRecents(db, ACC, (current) => [...current, 'action:a'])
    expect(await recents()).toEqual(['action:a'])
  })
})

describe('v5 migration', () => {
  it('backfills `bytes` and `ablob` on legacy rows (an unindexed row is INVISIBLE to eviction)', async () => {
    const name = `legacy-${Date.now()}`
    // A v4-era database: emailBodies/blobsMeta without the size indexes and without `bytes`.
    const legacy = new Dexie(name)
    legacy.version(4).stores({
      accounts: 'id, addedAt',
      mailboxes: '[accountId+id], accountId, [accountId+role]',
      threads: '[accountId+id], accountId',
      emails: '[accountId+id], accountId, [accountId+threadId], [accountId+receivedAt], *amb, *akw',
      emailBodies: '[accountId+id], accountId, [accountId+lastAccessedAt]',
      blobsMeta: '[accountId+blobId], accountId, [accountId+lastAccessedAt]',
      syncState: '[accountId+type], accountId',
      queryCache: '[accountId+key], accountId, [accountId+lastUsedAt]',
      outbox: '[accountId+id], accountId, [accountId+createdAt], [accountId+status]',
      localPrefs: '[accountId+key], accountId',
      addressStats: '[accountId+emailLower], accountId, [accountId+lastSeenAt]',
      identities: '[accountId+id], accountId',
      drafts: '[accountId+localId], accountId, [accountId+serverEmailId], [accountId+updatedAt]',
    })
    await legacy.open()
    await legacy.table('emailBodies').put({
      ...body('legacy', 'hello', 42),
      attachments: [{ ...PART, blobId: 'legacy-blob' }],
    })
    await legacy.table('blobsMeta').put({
      accountId: ACC,
      blobId: 'legacy-blob',
      type: 'image/png',
      size: 99,
      name: null,
      data: null,
      fetchedAt: 1,
      lastAccessedAt: 7,
    })
    legacy.close()

    // Reopening under the current schema must MIGRATE the rows — not silently drop them from the new
    // indexes, which is exactly what an un-backfilled indexed field would do.
    const upgraded = new Replica(name)
    try {
      const entries = await bodyCacheEntries(upgraded, ACC)
      expect(entries).toEqual([
        { id: 'legacy', bytes: 10 + BODY_OVERHEAD_BYTES, lastAccessedAt: 42 },
      ])
      expect((await blobOwners(upgraded, ACC)).get('legacy-blob')).toEqual(['legacy'])
      const blobs = await blobCacheEntries(upgraded, ACC)
      expect(blobs).toHaveLength(1) // metadata-only row: costed at the flat overhead, still visible
      expect(blobs[0]?.id).toBe('legacy-blob')
    } finally {
      await upgraded.delete()
    }
  })
})
