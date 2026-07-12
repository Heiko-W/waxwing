/**
 * The cache-policy invariants (M3.4, FR-OFF-04) — asserted against the PURE planner, so each one is a
 * statement about the policy itself rather than about Dexie.
 */

import { describe, expect, it } from 'vitest'
import type { CacheItem } from '../repo'
import {
  chooseBudget,
  classifyBlobOrphans,
  type EvictionInputs,
  LOW_WATERMARK,
  MIN_BUDGET_BYTES,
  planEnvelopePrune,
  planEviction,
  planWindowReap,
  QUERY_WINDOW_TTL_MS,
} from './eviction'

const MB = 1024 * 1024
const NONE: ReadonlySet<string> = new Set()

function item(id: string, bytes: number, lastAccessedAt: number): CacheItem {
  return { id, bytes, lastAccessedAt }
}

function inputs(over: Partial<EvictionInputs> = {}): EvictionInputs {
  return {
    budgetBytes: 100 * MB,
    bodies: [],
    blobs: [],
    orphanBodyIds: NONE,
    orphanBlobIds: NONE,
    protectedEmailIds: NONE,
    protectedBlobIds: NONE,
    ...over,
  }
}

describe('planEviction', () => {
  it('does nothing under budget', () => {
    const plan = planEviction(
      inputs({ bodies: [item('b1', 1 * MB, 1)], blobs: [item('x1', 2 * MB, 1)] }),
    )
    expect(plan).toMatchObject({ bodyIds: [], blobIds: [], freedBytes: 0, reason: 'none' })
    expect(plan.usageAfter).toBe(3 * MB)
  })

  it('drops orphans even far under budget (they are garbage, not cache)', () => {
    const plan = planEviction(
      inputs({
        bodies: [item('live', 1 * MB, 9), item('dead', 1 * MB, 9)],
        blobs: [item('x-live', 1 * MB, 9), item('x-dead', 3 * MB, 9)],
        orphanBodyIds: new Set(['dead']),
        orphanBlobIds: new Set(['x-dead']),
      }),
    )
    expect(plan.bodyIds).toEqual(['dead'])
    expect(plan.blobIds).toEqual(['x-dead'])
    expect(plan.freedBytes).toBe(4 * MB)
    expect(plan.reason).toBe('orphans')
  })

  it('never drops an orphan that is still PROTECTED (a queued send’s attachment has no owner)', () => {
    // A blob uploaded for a draft attachment belongs to no cached message, so the owner check calls it
    // an orphan. It is not garbage: the queued send needs it. Protection outranks every other rule.
    const plan = planEviction(
      inputs({
        blobs: [item('draft-upload', 5 * MB, 1)],
        bodies: [item('gone', 1 * MB, 1)],
        orphanBlobIds: new Set(['draft-upload']),
        orphanBodyIds: new Set(['gone']),
        protectedBlobIds: new Set(['draft-upload']),
      }),
    )
    expect(plan.blobIds).toEqual([])
    expect(plan.bodyIds).toEqual(['gone'])
  })

  it('evicts blob bytes before message bodies at the same age', () => {
    const plan = planEviction(
      inputs({
        budgetBytes: 10 * MB, // target = 8 MB
        bodies: [item('b1', 4 * MB, 100)],
        blobs: [item('x1', 5 * MB, 100)],
      }),
    )
    // 9 MB used, 1 MB over the watermark: the attachment goes, the message text stays.
    expect(plan.blobIds).toEqual(['x1'])
    expect(plan.bodyIds).toEqual([])
    expect(plan.reason).toBe('budget')
  })

  it('evicts oldest-first within a category, breaking ties by the larger row', () => {
    const plan = planEviction(
      inputs({
        budgetBytes: 10 * MB,
        blobs: [
          item('new', 3 * MB, 300),
          item('old-small', 1 * MB, 100),
          item('old-big', 3 * MB, 100),
        ],
        bodies: [item('b', 5 * MB, 500)],
      }),
    )
    // 12 MB used, target 8 MB ⇒ free ≥ 4 MB: the two oldest blobs, largest of the tie first.
    expect(plan.blobIds).toEqual(['old-big', 'old-small'])
    expect(plan.bodyIds).toEqual([])
  })

  it('stops exactly at the low watermark — not at zero, and not one row further', () => {
    const bodies = Array.from({ length: 10 }, (_, index) => item(`b${index}`, 10 * MB, index))
    const plan = planEviction(inputs({ budgetBytes: 100 * MB, bodies }))
    // 100 MB used, target 80 MB ⇒ exactly two of the oldest bodies.
    expect(plan.bodyIds).toEqual(['b0', 'b1'])
    expect(plan.usageAfter).toBe(80 * MB)
    expect(plan.usageAfter).toBeLessThanOrEqual(100 * MB * LOW_WATERMARK)
  })

  it('never evicts a protected body or blob, even when it is the oldest and we are over budget', () => {
    const plan = planEviction(
      inputs({
        budgetBytes: 10 * MB,
        bodies: [item('pinned', 6 * MB, 1), item('cold', 4 * MB, 2)],
        blobs: [item('draft-attachment', 5 * MB, 1), item('x-cold', 5 * MB, 2)],
        protectedEmailIds: new Set(['pinned']),
        protectedBlobIds: new Set(['draft-attachment']),
      }),
    )
    expect(plan.bodyIds).not.toContain('pinned')
    expect(plan.blobIds).not.toContain('draft-attachment')
    expect(plan.blobIds).toEqual(['x-cold'])
    expect(plan.bodyIds).toEqual(['cold'])
  })

  it('makes a best-effort plan (no loop, no throw) when the budget is unreachable', () => {
    const protectedEmailIds = new Set(['b1', 'b2'])
    const plan = planEviction(
      inputs({
        budgetBytes: 1 * MB,
        bodies: [item('b1', 50 * MB, 1), item('b2', 50 * MB, 2)],
        protectedEmailIds,
      }),
    )
    expect(plan.bodyIds).toEqual([])
    expect(plan.usageAfter).toBe(100 * MB) // still over budget — and that is the honest answer
    expect(plan.reason).toBe('none')
  })

  it('frees `needBytes` BELOW the low watermark on the quota-recovery path', () => {
    const bodies = Array.from({ length: 10 }, (_, index) => item(`b${index}`, 10 * MB, index))
    const plan = planEviction(inputs({ budgetBytes: 100 * MB, bodies, needBytes: 15 * MB }))
    // target = 80 MB − 15 MB = 65 MB ⇒ four bodies (100 → 60), one more than the plain budget pass.
    expect(plan.bodyIds).toEqual(['b0', 'b1', 'b2', 'b3'])
    expect(plan.usageAfter).toBe(60 * MB)
    expect(plan.reason).toBe('need')
  })

  it('never plans an id the outbox or a draft still references (they are fed in as protected)', () => {
    // The maintenance pass protects every id an outbox intent / draft row points at; the planner's
    // contract is simply that a protected id can never appear in a plan.
    const outboxEmailIds = new Set(['queued-move', 'reply-source'])
    const draftBlobIds = new Set(['attachment-blob'])
    const plan = planEviction(
      inputs({
        budgetBytes: 1 * MB, // absurdly over budget: maximum pressure to evict
        bodies: [item('queued-move', 9 * MB, 1), item('reply-source', 9 * MB, 1)],
        blobs: [item('attachment-blob', 9 * MB, 1)],
        protectedEmailIds: outboxEmailIds,
        protectedBlobIds: draftBlobIds,
      }),
    )
    for (const id of plan.bodyIds) expect(outboxEmailIds.has(id)).toBe(false)
    for (const id of plan.blobIds) expect(draftBlobIds.has(id)).toBe(false)
    expect(plan.freedBytes).toBe(0)
  })

  it('is NOT driven by envelope bytes it cannot free — they must never empty the body cache', () => {
    // The envelope index is bounded by the PRUNE (stage 3), never by eviction: this loop cannot
    // delete an envelope. Seeding the usage with envelope bytes made the target unreachable, so the
    // loop walked both lists to completion — deleting every body and blob and STILL missing. On a
    // normal replica the envelopes dominate, so that was the common case, not a corner.
    const plan = planEviction(inputs({ budgetBytes: 10 * MB, bodies: [item('b1', 2 * MB, 1)] }))
    expect(plan.bodyIds).toEqual([])
    expect(plan.reason).toBe('none')
  })

  it('frees a BOUNDED share under origin pressure — never the whole cache', () => {
    // The browser is near its quota, so we shrink below our own budget. But a pressured pass must
    // still converge on a target it can REACH: it takes ~20 % of the evictable pool, leaving the rest.
    const bodies = Array.from({ length: 10 }, (_, i) => item(`b${i}`, 10 * MB, i))
    const plan = planEviction(inputs({ budgetBytes: 500 * MB, bodies, pressured: true }))
    expect(plan.bodyIds).toEqual(['b0', 'b1'])
    expect(plan.usageAfter).toBe(80 * MB)
  })

  it('stops shrinking a SMALL cache under pressure — 6 MB of mail is not what filled the origin', () => {
    const bodies = [item('b1', 3 * MB, 1), item('b2', 3 * MB, 2)]
    const plan = planEviction(inputs({ budgetBytes: 500 * MB, bodies, pressured: true }))
    expect(plan.bodyIds).toEqual([])
  })

  it('lets an urgent needBytes override the pressure floor — the user is waiting on that write', () => {
    const bodies = [item('b1', 3 * MB, 1), item('b2', 3 * MB, 2)]
    const plan = planEviction(
      inputs({ budgetBytes: 500 * MB, bodies, pressured: true, needBytes: 100 * MB }),
    )
    expect(plan.bodyIds).toEqual(['b1', 'b2'])
  })
})

describe('classifyBlobOrphans', () => {
  const blob = (id: string) => item(id, 1 * MB, 1)
  const classify = (
    owners: Record<string, string[]>,
    over: { orphanBodyIds?: Set<string>; protectedEmailIds?: Set<string> } = {},
  ) =>
    classifyBlobOrphans({
      blobs: Object.keys(owners).map(blob),
      owners: new Map(Object.entries(owners)),
      orphanBodyIds: over.orphanBodyIds ?? new Set(),
      protectedEmailIds: over.protectedEmailIds ?? new Set(),
    })

  it('is garbage only when every owner is itself an orphan', () => {
    const { orphanBlobIds } = classify(
      { 'x-dead': ['gone'], 'x-live': ['here'], 'x-mixed': ['gone', 'here'] },
      { orphanBodyIds: new Set(['gone']) },
    )
    expect([...orphanBlobIds]).toEqual(['x-dead'])
  })

  it('does NOT orphan a blob whose owner is simply absent from the caller’s body snapshot', () => {
    // THE regression. `owners` comes from the live `ablob` index, read several awaits after the body
    // snapshot; a body written in that gap (the user opened the message) is an owner the snapshot has
    // never heard of. The old rule — "orphan unless an owner is among the bodies I snapshotted" —
    // called that blob garbage, and orphans are deleted with NO budget check: the attachment of the
    // message on screen was thrown away. An owner that is not a known orphan is a LIVE owner.
    const { orphanBlobIds } = classify(
      { attachment: ['just-opened'] },
      { orphanBodyIds: new Set() },
    )
    expect([...orphanBlobIds]).toEqual([])
  })

  it('orphans a blob with no owner at all — but a draft’s upload is protected by blobId', () => {
    // A draft's uploaded attachment belongs to no cached message; it is protected by blobId in the
    // maintenance pass, and `planEviction` refuses to plan a protected id under any circumstance.
    const { orphanBlobIds } = classify({ 'draft-upload': [] })
    expect([...orphanBlobIds]).toEqual(['draft-upload'])
  })

  it('protects a blob owned by a protected message, and never also calls it an orphan', () => {
    const { orphanBlobIds, protectedBlobIds } = classify(
      { 'pinned-attachment': ['pinned'] },
      { protectedEmailIds: new Set(['pinned']), orphanBodyIds: new Set(['pinned']) },
    )
    expect([...protectedBlobIds]).toEqual(['pinned-attachment'])
    expect([...orphanBlobIds]).toEqual([])
  })
})

describe('chooseBudget', () => {
  it('caps the configured budget at a safe share of the browser quota', () => {
    expect(chooseBudget(512, { usage: 0, quota: 100 * MB })).toBe(80 * MB)
  })

  it('uses the configured budget when the browser reports no quota', () => {
    expect(chooseBudget(512, null)).toBe(512 * MB)
    expect(chooseBudget(0, null)).toBe(MIN_BUDGET_BYTES)
  })

  it('lets the QUOTA cap win over the floor — a floor above the quota disables eviction entirely', () => {
    // Flooring a 10 MB-quota origin up to the 50 MB minimum would hand us a budget five times the
    // space we are allowed to use: budget-driven eviction could then never fire, and only the
    // pressure path — which by definition engages at 90 % of a quota we already blew past — would be
    // left. `clampMaxStorageMB` keeps the CONFIGURED value at or above the floor; the quota is a hard
    // ceiling, not a preference.
    expect(chooseBudget(512, { usage: 0, quota: 10 * MB })).toBe(8 * MB)
  })
})

describe('planEnvelopePrune', () => {
  it('NEVER prunes a candidate that a surviving queryCache window still lists', () => {
    // The invariant: an id in a live window must stay in the replica, or MessageList renders a
    // permanent skeleton row that no sync can ever fill.
    const searchWindowIds = ['e2', 'e4']
    const pruned = planEnvelopePrune({
      candidateIds: ['e1', 'e2', 'e3', 'e4'],
      referencedIds: new Set(searchWindowIds),
    })
    expect(pruned).toEqual(['e1', 'e3'])
    for (const id of searchWindowIds) expect(pruned).not.toContain(id)
  })

  it('prunes nothing when everything below the horizon is still referenced', () => {
    expect(planEnvelopePrune({ candidateIds: ['e1'], referencedIds: new Set(['e1']) })).toEqual([])
  })
})

describe('planWindowReap', () => {
  const NOW = 10 * QUERY_WINDOW_TTL_MS

  it('reaps an unwatched, stale window', () => {
    const rows = [{ key: 'stale', lastUsedAt: NOW - QUERY_WINDOW_TTL_MS - 1 }]
    expect(planWindowReap(rows, new Set(), NOW)).toEqual(['stale'])
  })

  it('never reaps a currently-watched key, however old it is', () => {
    const rows = [{ key: 'open-search', lastUsedAt: 0 }]
    expect(planWindowReap(rows, new Set(['open-search']), NOW)).toEqual([])
  })

  it('never reaps an unwatched but still-fresh window', () => {
    const rows = [{ key: 'yesterday', lastUsedAt: NOW - 1000 }]
    expect(planWindowReap(rows, new Set(), NOW)).toEqual([])
  })
})
