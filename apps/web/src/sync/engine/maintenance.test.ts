/**
 * The maintenance pass against a real (fake-indexeddb) replica — hermetic: an injected `estimate`, an
 * injected `now`, no network. These are the tests that hold the M3.4 promises the planner alone cannot:
 * that the pass never touches the outbox or drafts, that a pinned folder survives, that a live search
 * window keeps its envelopes, and that a quota abort mid-pass leaves the DB consistent.
 */

import type { EmailBodyPart } from '@waxwing/jmap'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { collectCacheUsage } from '../cache-usage'
import {
  type DraftRow,
  ENVELOPE_BYTES_ESTIMATE,
  type OutboxRow,
  type QueryCacheRow,
  type ReplicaDb,
  scopeKey,
} from '../db'
import { putEmails, putMailboxes } from '../repo'
import type { EstimateFn } from '../storage'
import { email, freshDb, mailbox } from '../test-utils'
import { LOW_WATERMARK } from './eviction'
import {
  EVICT_CHUNK,
  type MaintenanceDeps,
  PIN_PREFETCH_PER_PASS,
  runMaintenance,
  withQuotaRecovery,
} from './maintenance'

const ACC = 'acc'
const MB = 1024 * 1024
const NOW = Date.UTC(2026, 6, 12)
const DAY = 86_400_000

const PART: EmailBodyPart = {
  partId: '1',
  blobId: null,
  size: 1,
  name: null,
  type: 'text/plain',
  charset: null,
  disposition: null,
  cid: null,
  language: null,
  location: null,
  subParts: null,
} as EmailBodyPart

let db: ReplicaDb

const noEstimate: EstimateFn = async () => null
const estimateOf =
  (usage: number, quota: number): EstimateFn =>
  async () => ({ usage, quota })

function deps(over: Partial<MaintenanceDeps> = {}): MaintenanceDeps {
  return {
    db,
    accountId: ACC,
    config: { cacheDays: 30, maxStorageMB: 50 },
    estimate: noEstimate,
    now: NOW,
    watchedKeys: new Set(),
    lastBodyFetchId: null,
    ...over,
  }
}

/** A body row with an EXACT stored size, so the watermark arithmetic in the assertions is exact. */
async function putBody(
  id: string,
  bytes: number,
  lastAccessedAt: number,
  blobIds: string[] = [],
): Promise<void> {
  await db.emailBodies.put({
    accountId: ACC,
    id,
    bodyValues: {},
    bodyStructure: PART,
    textBody: [],
    htmlBody: [],
    attachments: [],
    hasAttachment: false,
    fetchedAt: 0,
    lastAccessedAt,
    bytes,
    ablob: blobIds.map((blobId) => scopeKey(ACC, blobId)),
  })
}

async function putBlob(blobId: string, bytes: number, lastAccessedAt: number): Promise<void> {
  await db.blobsMeta.put({
    accountId: ACC,
    blobId,
    type: 'image/png',
    size: bytes,
    name: null,
    data: null,
    fetchedAt: 0,
    lastAccessedAt,
    bytes,
  })
}

function window(key: string, ids: string[], lastUsedAt: number): QueryCacheRow {
  return {
    accountId: ACC,
    key,
    ids,
    queryState: 'q',
    total: ids.length,
    upToId: ids.at(-1) ?? null,
    filter: null,
    sort: null,
    collapseThreads: false,
    lastUsedAt,
  }
}

const bodyIds = async (): Promise<string[]> =>
  (await db.emailBodies.where('accountId').equals(ACC).toArray())
    .map((row) => row.id)
    .sort((a, b) => a.localeCompare(b))

beforeEach(() => {
  db = freshDb()
})

afterEach(async () => {
  await db.delete()
})

describe('runMaintenance — eviction', () => {
  it('evicts to the low watermark under a small budget, oldest first — and not one row further', async () => {
    // 50 MB budget ⇒ target 40 MB. Six 10 MB bodies = 60 MB of EVICTABLE bytes, so exactly two go.
    // (The six envelopes are ~7 KB and are deliberately NOT in this arithmetic: eviction cannot free
    // an envelope, and counting them used to tip the target just out of reach — costing a THIRD body
    // to chase a few kilobytes the loop was never able to release.)
    await putEmails(
      db,
      ACC,
      ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'].map((id) => email(id)),
    )
    for (const [index, id] of ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'].entries()) {
      await putBody(id, 10 * MB, index + 1)
    }

    const result = await runMaintenance(deps())

    expect(result.evicted.reason).toBe('budget')
    expect(await bodyIds()).toEqual(['b3', 'b4', 'b5', 'b6'])
    expect(result.evicted.usageAfter).toBe(40 * MB)
    expect(result.evicted.usageAfter).toBeLessThanOrEqual(50 * MB * LOW_WATERMARK)
  })

  it('frees a BOUNDED share under ORIGIN pressure — and leaves the rest of the cache intact', async () => {
    // 100 MB of bodies against a 512 MB budget: no budget pressure at all. But the ORIGIN is at 99 %
    // of its quota, so the browser is about to evict this origin wholesale — a pass must still free
    // space. It must free a share it can actually REACH, and no more.
    const ids = Array.from({ length: 10 }, (_, index) => `b${index}`)
    await putEmails(
      db,
      ACC,
      ids.map((id) => email(id)),
    )
    for (const [index, id] of ids.entries()) await putBody(id, 10 * MB, index + 1)
    const roomy = { cacheDays: 30, maxStorageMB: 512 }

    const calm = await runMaintenance(
      deps({ config: roomy, estimate: estimateOf(10 * MB, 1000 * MB) }),
    )
    expect(calm.evicted.bodyIds).toEqual([]) // under budget, no pressure ⇒ nothing happens

    const pressured = await runMaintenance(
      deps({ config: roomy, estimate: estimateOf(990 * MB, 1000 * MB) }),
    )
    // EXACT survivors, not a count: a total wipe also satisfies "it evicted something", and a total
    // wipe is precisely what the old planner did here — it seeded the usage with envelope bytes it
    // could never free, so the loop drained both lists and still missed the target.
    expect(pressured.evicted.bodyIds).toEqual(['b0', 'b1'])
    expect(await bodyIds()).toEqual(['b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'b9'])
  })

  it('does NOT keep shrinking a SMALL cache under pressure — 5 MB of mail did not fill the origin', async () => {
    const ids = ['b1', 'b2', 'b3', 'b4', 'b5']
    await putEmails(
      db,
      ACC,
      ids.map((id) => email(id)),
    )
    for (const [index, id] of ids.entries()) await putBody(id, 1 * MB, index + 1)

    const pressured = await runMaintenance(
      deps({
        config: { cacheDays: 30, maxStorageMB: 512 },
        estimate: estimateOf(990 * MB, 1000 * MB),
      }),
    )
    // Deleting these 5 MB would cost the user their offline mail and would not move the origin's
    // 990 MB needle at all. Under budget and below the floor ⇒ leave it alone.
    expect(pressured.evicted.bodyIds).toEqual([])
    expect(await bodyIds()).toEqual(ids)
  })

  it('drops bodies and blobs whose envelope is gone (the delta-sync orphan leak)', async () => {
    await putEmails(db, ACC, [email('alive')])
    await putBody('alive', 1 * MB, 5, ['blob-alive'])
    await putBody('deleted', 1 * MB, 5, ['blob-dead']) // its envelope was destroyed by a delta sync
    await putBlob('blob-alive', 1 * MB, 5)
    await putBlob('blob-dead', 1 * MB, 5)

    const result = await runMaintenance(deps())

    expect(result.evicted.reason).toBe('orphans')
    expect(await bodyIds()).toEqual(['alive'])
    expect(await db.blobsMeta.get([ACC, 'blob-dead'])).toBeUndefined()
    expect(await db.blobsMeta.get([ACC, 'blob-alive'])).toBeDefined()
  })

  it('keeps a blob whose owning body exists but was not in the pass’s snapshot', async () => {
    // The stale-snapshot race, end to end: the owner map is read from the LIVE index, so a body cached
    // after the snapshot is an owner that the snapshot does not know. Orphans are deleted with no
    // budget check, so treating "not in my snapshot" as "garbage" threw away the attachment of the
    // message the user had just opened. (The rule itself is pinned down in eviction.test.ts.)
    await putEmails(db, ACC, [email('m')])
    await putBody('m', 1 * MB, 9, ['attachment'])
    await putBlob('attachment', 1 * MB, 5)

    const result = await runMaintenance(deps())

    expect(result.evicted.blobIds).toEqual([])
    expect(await db.blobsMeta.get([ACC, 'attachment'])).toBeDefined()
  })

  it('keeps a pinned folder’s bodies and blobs while evicting every other body', async () => {
    await putMailboxes(db, ACC, [mailbox('keep'), mailbox('inbox', { role: 'inbox' })])
    await db.localPrefs.put({ accountId: ACC, key: 'offline.pinnedMailboxes', value: ['keep'] })
    await putEmails(db, ACC, [
      email('pinned', { mailboxIds: { keep: true } }),
      email('cold1'),
      email('cold2'),
      email('cold3'),
      email('cold4'),
      email('cold5'),
    ])
    // The pinned body is the OLDEST and the LARGEST — the first thing a pure LRU pass would drop.
    await putBody('pinned', 20 * MB, 1, ['pinned-blob'])
    await putBlob('pinned-blob', 5 * MB, 1)
    for (const [index, id] of ['cold1', 'cold2', 'cold3', 'cold4', 'cold5'].entries()) {
      await putBody(id, 10 * MB, 10 + index)
    }

    await runMaintenance(deps())

    expect(await db.emailBodies.get([ACC, 'pinned'])).toBeDefined()
    expect(await db.blobsMeta.get([ACC, 'pinned-blob'])).toBeDefined()
    expect(await db.emailBodies.get([ACC, 'cold1'])).toBeUndefined()
  })

  it('PREFETCHES the bodies a pinned folder is missing — bounded, and never past the watermark', async () => {
    await putMailboxes(db, ACC, [mailbox('keep')])
    await db.localPrefs.put({ accountId: ACC, key: 'offline.pinnedMailboxes', value: ['keep'] })
    await putEmails(db, ACC, [
      email('p1', { mailboxIds: { keep: true } }),
      email('p2', { mailboxIds: { keep: true } }),
      email('elsewhere'), // not in the pinned folder — never prefetched
    ])
    await putBody('p1', 1024, 5) // already cached: not re-fetched

    const fetched: string[] = []
    const result = await runMaintenance(
      deps({
        fetchBody: async (id) => {
          fetched.push(id)
          await putBody(id, 1024, 9)
        },
      }),
    )

    expect(fetched).toEqual(['p2'])
    expect(result.prefetchedBodies).toBe(1)
  })

  it('caps the prefetch at PIN_PREFETCH_PER_PASS and resumes on the next pass', async () => {
    // A pin on a big folder must not turn one maintenance pass into a thousand-request download storm.
    // The cap is what makes the prefetch bounded AND resumable; nothing tested it, because the other
    // prefetch test seeds two messages and could never reach a limit of a hundred.
    await putMailboxes(db, ACC, [mailbox('keep')])
    await db.localPrefs.put({ accountId: ACC, key: 'offline.pinnedMailboxes', value: ['keep'] })
    const ids = Array.from({ length: PIN_PREFETCH_PER_PASS + 20 }, (_, index) => `p${index}`)
    await putEmails(
      db,
      ACC,
      ids.map((id) => email(id, { mailboxIds: { keep: true } })),
    )

    const fetchBody = vi.fn(async (id: string) => {
      await putBody(id, 1024, 9)
    })
    const first = await runMaintenance(deps({ fetchBody }))
    expect(first.prefetchedBodies).toBe(PIN_PREFETCH_PER_PASS)

    const second = await runMaintenance(deps({ fetchBody }))
    expect(second.prefetchedBodies).toBe(20) // the remainder, not a re-fetch of the first hundred
    expect(fetchBody).toHaveBeenCalledTimes(PIN_PREFETCH_PER_PASS + 20)
  })

  it('skips PAST a message that always fails instead of letting it block the folder forever', async () => {
    await putMailboxes(db, ACC, [mailbox('keep')])
    await db.localPrefs.put({ accountId: ACC, key: 'offline.pinnedMailboxes', value: ['keep'] })
    await putEmails(db, ACC, [
      email('p1', { mailboxIds: { keep: true } }), // destroyed server-side, envelope lingering
      email('p2', { mailboxIds: { keep: true } }),
      email('p3', { mailboxIds: { keep: true } }),
    ])

    const fetched: string[] = []
    const result = await runMaintenance(
      deps({
        fetchBody: async (id) => {
          if (id === 'p1') throw new Error('gone')
          fetched.push(id)
          await putBody(id, 1024, 9)
        },
      }),
    )

    // The old loop returned on the FIRST failure, so one unreachable message starved every id behind
    // it — on every pass, forever: the folder could never finish topping up.
    expect(fetched).toEqual(['p2', 'p3'])
    expect(result.prefetchedBodies).toBe(2)
  })

  it('stops prefetching when the engine is stopping (sign-out must not wait on the network)', async () => {
    await putMailboxes(db, ACC, [mailbox('keep')])
    await db.localPrefs.put({ accountId: ACC, key: 'offline.pinnedMailboxes', value: ['keep'] })
    await putEmails(
      db,
      ACC,
      ['p1', 'p2', 'p3'].map((id) => email(id, { mailboxIds: { keep: true } })),
    )

    const controller = new AbortController()
    const fetched: string[] = []
    const result = await runMaintenance(
      deps({
        signal: controller.signal,
        fetchBody: async (id) => {
          fetched.push(id)
          controller.abort() // the user signed out mid-prefetch
          await putBody(id, 1024, 9)
        },
      }),
    )

    expect(fetched).toEqual(['p1'])
    expect(result.prefetchedBodies).toBe(1)
  })

  it('does not prefetch at all when the cache is already at the low watermark', async () => {
    await putMailboxes(db, ACC, [mailbox('keep')])
    await db.localPrefs.put({ accountId: ACC, key: 'offline.pinnedMailboxes', value: ['keep'] })
    await putEmails(db, ACC, [
      email('p1', { mailboxIds: { keep: true } }),
      email('p2', { mailboxIds: { keep: true } }),
    ])
    // A pinned folder is exempt from eviction, so a 45 MB pinned body sits above the 40 MB watermark:
    // a pin is a strong preference, never a licence to fill the disk.
    await putBody('p1', 45 * MB, 1)

    const fetched: string[] = []
    const result = await runMaintenance(
      deps({
        fetchBody: async (id) => {
          fetched.push(id)
        },
      }),
    )

    expect(fetched).toEqual([])
    expect(result.prefetchedBodies).toBe(0)
  })

  it('never evicts what the outbox or a draft still needs — and never touches those rows', async () => {
    await putEmails(db, ACC, [
      email('queued'),
      email('dead-letter'),
      email('draft-source'),
      email('cold'),
    ])
    for (const id of ['queued', 'dead-letter', 'draft-source', 'cold'])
      await putBody(id, 20 * MB, 1)
    await putBlob('draft-blob', 20 * MB, 1)

    const pending: OutboxRow = {
      accountId: ACC,
      id: 'o1',
      type: 'move',
      payload: { kind: 'move', emailIds: ['queued'], from: 'inbox', to: 'archive' },
      ifInState: null,
      status: 'pending',
      attempts: 0,
      createdAt: 1,
      lastError: null,
      notBefore: null,
    }
    // A DEAD LETTER still owes a rollback that may re-fetch its emails: its ids are protected too.
    const failed: OutboxRow = {
      ...pending,
      id: 'o2',
      type: 'setKeywords',
      payload: { kind: 'setKeywords', emailIds: ['dead-letter'], keyword: '$seen', value: true },
      status: 'error',
    }
    await db.outbox.bulkPut([pending, failed])

    const draft: DraftRow = {
      accountId: ACC,
      localId: 'd1',
      serverEmailId: null,
      status: 'pending',
      content: {
        to: [],
        cc: [],
        bcc: [],
        subject: '',
        body: '',
        inReplyTo: null,
        references: null,
        fromIdentityId: null,
        fromIdentityHint: null,
        attachments: [
          { blobId: 'draft-blob', name: 'x.pdf', type: 'application/pdf', size: 1, cid: null },
        ],
        sourceEmailId: 'draft-source',
        sourceFlag: null,
      },
      createdAt: 1,
      updatedAt: 1,
      lastError: null,
    }
    await db.drafts.put(draft)

    const result = await runMaintenance(deps())

    // Way over budget (80 MB of bodies + 20 MB of blobs vs a 40 MB target) — yet only the one row
    // nothing references may go.
    expect(result.evicted.bodyIds).toEqual(['cold'])
    expect(result.evicted.blobIds).toEqual([])
    expect(await db.emailBodies.get([ACC, 'queued'])).toBeDefined()
    expect(await db.emailBodies.get([ACC, 'dead-letter'])).toBeDefined()
    expect(await db.emailBodies.get([ACC, 'draft-source'])).toBeDefined()
    expect(await db.blobsMeta.get([ACC, 'draft-blob'])).toBeDefined()
    // And the queue itself is untouched by any stage, for any reason.
    expect(await db.outbox.count()).toBe(2)
    expect(await db.drafts.count()).toBe(1)
  })

  it('never evicts the message the reading pane has open', async () => {
    await putEmails(db, ACC, [email('open'), email('cold')])
    await putBody('open', 40 * MB, 1) // oldest AND biggest
    await putBody('cold', 40 * MB, 2)

    await runMaintenance(deps({ lastBodyFetchId: 'open' }))

    expect(await db.emailBodies.get([ACC, 'open'])).toBeDefined()
    expect(await db.emailBodies.get([ACC, 'cold'])).toBeUndefined()
  })
})

describe('runMaintenance — pruning', () => {
  const OLD = new Date(NOW - 60 * DAY).toISOString()
  const RECENT = new Date(NOW - 1 * DAY).toISOString()

  it('prunes aged-out envelopes that nothing references, and keeps the ones a live search lists', async () => {
    await putEmails(db, ACC, [
      email('old-unreferenced', { receivedAt: OLD, threadId: 't1' }),
      email('old-in-search', { receivedAt: OLD, threadId: 't2' }),
      email('recent', { receivedAt: RECENT, threadId: 't3' }),
    ])
    // An OPEN search window (still watched) lists one of the aged-out ids: pruning it would leave the
    // list rendering a skeleton row forever.
    await db.queryCache.put(window('search', ['old-in-search'], NOW))

    const result = await runMaintenance(deps({ watchedKeys: new Set(['search']) }))

    expect(result.prunedEnvelopes).toBe(1)
    expect(await db.emails.get([ACC, 'old-unreferenced'])).toBeUndefined()
    expect(await db.emails.get([ACC, 'old-in-search'])).toBeDefined()
    expect(await db.emails.get([ACC, 'recent'])).toBeDefined()
  })

  it('keeps an aged-out envelope inside the cacheDays + grace window', async () => {
    // 30 days of horizon + a 7-day grace: a 33-day-old message is still safe.
    await putEmails(db, ACC, [
      email('grace', { receivedAt: new Date(NOW - 33 * DAY).toISOString() }),
    ])
    const result = await runMaintenance(deps())
    expect(result.prunedEnvelopes).toBe(0)
    expect(await db.emails.get([ACC, 'grace'])).toBeDefined()
  })

  it('prunes a thread only once every one of its members is gone', async () => {
    await putEmails(db, ACC, [
      email('m1', { receivedAt: OLD, threadId: 'whole' }),
      email('m2', { receivedAt: OLD, threadId: 'whole' }),
      email('m3', { receivedAt: OLD, threadId: 'partial' }),
      email('m4', { receivedAt: RECENT, threadId: 'partial' }),
    ])
    await db.threads.bulkPut([
      { accountId: ACC, id: 'whole', emailIds: ['m1', 'm2'] },
      { accountId: ACC, id: 'partial', emailIds: ['m3', 'm4'] },
    ])

    await runMaintenance(deps())

    expect(await db.threads.get([ACC, 'whole'])).toBeUndefined()
    // `partial` still has a recent member — and that member's THREAD keeps its sibling alive, so the
    // conversation view can never lose a message out from under it.
    expect(await db.threads.get([ACC, 'partial'])).toBeDefined()
    expect(await db.emails.get([ACC, 'm3'])).toBeDefined()
  })

  it('reaps an unwatched, stale query window but never a watched one', async () => {
    await db.queryCache.bulkPut([
      window('stale', [], NOW - 3 * DAY),
      window('open', [], NOW - 3 * DAY),
      window('fresh', [], NOW - 1000),
    ])

    const result = await runMaintenance(deps({ watchedKeys: new Set(['open']) }))

    expect(result.reapedWindows).toBe(1)
    expect(await db.queryCache.get([ACC, 'stale'])).toBeUndefined()
    expect(await db.queryCache.get([ACC, 'open'])).toBeDefined()
    expect(await db.queryCache.get([ACC, 'fresh'])).toBeDefined()
  })
})

describe('runMaintenance — resilience', () => {
  it('survives a QuotaExceededError mid-pass: partial results, no throw, freed bytes committed', async () => {
    const count = EVICT_CHUNK + 50
    for (let index = 0; index < count; index += 1) {
      await putBody(`orphan-${index}`, 1024, index) // no envelopes at all ⇒ every body is an orphan
    }
    // The SECOND delete chunk aborts for want of space (exactly what a full disk does mid-eviction).
    const original = db.emailBodies.bulkDelete.bind(db.emailBodies)
    let calls = 0
    const bulkDelete = vi.fn(async (keys: unknown) => {
      calls += 1
      if (calls === 2) throw new DOMException('quota', 'QuotaExceededError')
      return original(keys as never)
    })
    db.emailBodies.bulkDelete = bulkDelete as unknown as typeof db.emailBodies.bulkDelete

    const result = await runMaintenance(deps()) // must NOT throw

    expect(result.evicted.bodyIds).toHaveLength(EVICT_CHUNK) // only the committed chunk is reported
    expect(await db.emailBodies.count()).toBe(50) // the first chunk really is gone
    db.emailBodies.bulkDelete = original
  })
})

describe('withQuotaRecovery', () => {
  it('recovers once and retries once', async () => {
    let attempt = 0
    const recover = vi.fn(async () => undefined)
    const result = await withQuotaRecovery(
      async () => {
        attempt += 1
        if (attempt === 1) throw new DOMException('quota', 'QuotaExceededError')
        return 'written'
      },
      recover,
      4096,
    )
    expect(result).toBe('written')
    expect(recover).toHaveBeenCalledTimes(1)
    expect(recover).toHaveBeenCalledWith(4096)
    expect(attempt).toBe(2)
  })

  it('propagates a SECOND quota failure instead of looping forever', async () => {
    const recover = vi.fn(async () => undefined)
    const write = vi.fn(async () => {
      throw new DOMException('quota', 'QuotaExceededError')
    })
    await expect(withQuotaRecovery(write, recover, 1)).rejects.toThrow()
    expect(write).toHaveBeenCalledTimes(2) // once, then exactly one retry
    expect(recover).toHaveBeenCalledTimes(1)
  })

  it('never recovers from an unrelated error', async () => {
    const recover = vi.fn(async () => undefined)
    await expect(
      withQuotaRecovery(
        async () => {
          throw new TypeError('unrelated')
        },
        recover,
        1,
      ),
    ).rejects.toThrow(TypeError)
    expect(recover).not.toHaveBeenCalled()
  })
})

describe('collectCacheUsage', () => {
  it('reports exactly what is stored — the number eviction acts on IS the number the UI shows', async () => {
    await putEmails(db, ACC, [email('e1'), email('e2')])
    await putBody('e1', 3000, 1)
    await putBody('e2', 5000, 2)
    await putBlob('x1', 7000, 3)

    const usage = await collectCacheUsage(db, ACC, estimateOf(100_000, 1_000_000))

    expect(usage.bodies).toEqual({ bytes: 8000, count: 2 })
    expect(usage.blobs).toEqual({ bytes: 7000, count: 1 })
    expect(usage.envelopes).toEqual({ bytes: 2 * ENVELOPE_BYTES_ESTIMATE, count: 2 })
    expect(usage.accountedBytes).toBe(8000 + 7000 + 2 * ENVELOPE_BYTES_ESTIMATE)
    expect(usage.otherBytes).toBe(100_000 - usage.accountedBytes)
  })

  it('reports no `otherBytes` at all when the browser gives no estimate (never a made-up number)', async () => {
    const usage = await collectCacheUsage(db, ACC, noEstimate)
    expect(usage.estimate).toBeNull()
    expect(usage.otherBytes).toBeNull()
  })
})
