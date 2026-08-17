import { describe, expect, it } from 'vitest'
import {
  type ChunkLimits,
  FALLBACK_LIMITS,
  JmapError,
  planRequest,
  reassembleResponses,
  sanitizeLimits,
} from './index'
import { at } from './test-support'
import type { Invocation } from './types/core'

const USING = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail']

/** Generous limits with selected fields overridden per test. */
function limits(overrides: Partial<ChunkLimits> = {}): ChunkLimits {
  return {
    maxObjectsInGet: 1000,
    maxObjectsInSet: 1000,
    maxCallsInRequest: 1000,
    maxSizeRequest: 10_000_000,
    ...overrides,
  }
}

function ids(n: number, prefix = 'e'): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`)
}

/** Flattens the physical requests into one list of invocations. */
function flat(requests: Invocation[][]): Invocation[] {
  return requests.flat()
}

describe('planRequest — /get id chunking (maxObjectsInGet)', () => {
  it('does not split when ids length equals the limit (boundary)', () => {
    const calls: Invocation[] = [['Email/get', { accountId: 'a', ids: ids(2) }, 'c0']]
    const plan = planRequest(calls, USING, limits({ maxObjectsInGet: 2 }))
    expect(at(plan.logical, 0).kind).toBe('single')
    expect(flat(plan.requests)).toHaveLength(1)
    expect(at(flat(plan.requests), 0)[1]).toMatchObject({ ids: ['e0', 'e1'] })
  })

  it('splits an over-limit /get into ceil(n/limit) calls and preserves slices', () => {
    const calls: Invocation[] = [
      ['Email/get', { accountId: 'a', properties: ['id'], ids: ids(5) }, 'c0'],
    ]
    const plan = planRequest(calls, USING, limits({ maxObjectsInGet: 2 }))

    const physical = flat(plan.requests)
    expect(physical).toHaveLength(3)
    expect(at(physical, 0)).toEqual([
      'Email/get',
      { accountId: 'a', properties: ['id'], ids: ['e0', 'e1'] },
      'c0',
    ])
    expect(at(physical, 1)).toEqual([
      'Email/get',
      { accountId: 'a', properties: ['id'], ids: ['e2', 'e3'] },
      'c0~1',
    ])
    expect(at(physical, 2)).toEqual([
      'Email/get',
      { accountId: 'a', properties: ['id'], ids: ['e4'] },
      'c0~2',
    ])
    expect(at(plan.logical, 0)).toMatchObject({ kind: 'get', chunkIds: ['c0', 'c0~1', 'c0~2'] })
  })

  it('spreads the independent /get chunks across HTTP requests under maxCallsInRequest', () => {
    const calls: Invocation[] = [['Email/get', { accountId: 'a', ids: ids(5) }, 'c0']]
    const plan = planRequest(calls, USING, limits({ maxObjectsInGet: 2, maxCallsInRequest: 2 }))
    // 3 chunks, 2 per request → [2, 1]. Chunks are independent, so this is allowed.
    expect(plan.requests.map((r) => r.length)).toEqual([2, 1])
    expect(flat(plan.requests).map((c) => c[2])).toEqual(['c0', 'c0~1', 'c0~2'])
  })

  it('re-assembles chunked /get responses into one, concatenating list + notFound', () => {
    const calls: Invocation[] = [['Email/get', { accountId: 'a', ids: ids(5) }, 'c0']]
    const plan = planRequest(calls, USING, limits({ maxObjectsInGet: 2 }))
    const physical: Invocation[] = [
      [
        'Email/get',
        { accountId: 'a', state: 's', list: [{ id: 'e0' }, { id: 'e1' }], notFound: [] },
        'c0',
      ],
      [
        'Email/get',
        { accountId: 'a', state: 's', list: [{ id: 'e2' }, { id: 'e3' }], notFound: [] },
        'c0~1',
      ],
      [
        'Email/get',
        { accountId: 'a', state: 's', list: [{ id: 'e4' }], notFound: ['gone'] },
        'c0~2',
      ],
    ]
    const merged = reassembleResponses(plan, physical)
    expect(merged).toEqual([
      [
        'Email/get',
        {
          accountId: 'a',
          state: 's',
          list: [{ id: 'e0' }, { id: 'e1' }, { id: 'e2' }, { id: 'e3' }, { id: 'e4' }],
          notFound: ['gone'],
        },
        'c0',
      ],
    ])
  })
})

describe('planRequest — call-count chunking (maxCallsInRequest)', () => {
  it('splits independent calls across HTTP requests, preserving order', () => {
    const calls: Invocation[] = ids(5, 'c').map((id) => ['Core/echo', { n: id }, id] as Invocation)
    const plan = planRequest(calls, USING, limits({ maxCallsInRequest: 2 }))
    expect(plan.requests.map((r) => r.length)).toEqual([2, 2, 1])
    expect(flat(plan.requests).map((c) => c[2])).toEqual(['c0', 'c1', 'c2', 'c3', 'c4'])
  })
})

describe('planRequest — size chunking (maxSizeRequest)', () => {
  it('splits when two calls together exceed maxSizeRequest but each fits alone', () => {
    const big = 'x'.repeat(200)
    const calls: Invocation[] = [
      ['Core/echo', { blob: big }, 'c0'],
      ['Core/echo', { blob: big }, 'c1'],
    ]
    // One call (~ >200 bytes) fits; two together (>400) do not.
    const plan = planRequest(calls, USING, limits({ maxSizeRequest: 400, maxCallsInRequest: 10 }))
    expect(plan.requests).toHaveLength(2)
    expect(at(plan.requests, 0)).toHaveLength(1)
    expect(at(plan.requests, 1)).toHaveLength(1)
  })

  it('throws (does not silently over-size) when a single split /get chunk still exceeds maxSizeRequest', () => {
    // Documented limitation: a /get is only ever id-split down to maxObjectsInGet, never
    // re-split to satisfy maxSizeRequest — an oversized single chunk throws instead.
    const big = 'z'.repeat(500)
    const calls: Invocation[] = [
      ['Email/get', { accountId: 'a', ids: [`${big}0`, `${big}1`] }, 'c0'],
    ]
    expect(() =>
      planRequest(calls, USING, limits({ maxObjectsInGet: 1, maxSizeRequest: 200 })),
    ).toThrow(JmapError)
  })

  it('accounts for a seed createdIds map in the size estimate', () => {
    // Two calls that fit within maxSizeRequest on their own, but a large createdIds envelope
    // pushes the combined request over the limit → they are split into two requests.
    const calls: Invocation[] = [
      ['Core/echo', { n: 0 }, 'c0'],
      ['Core/echo', { n: 1 }, 'c1'],
    ]
    const createdIds = Object.fromEntries(ids(20, 'seed').map((k) => [k, 'x'.repeat(20)]))
    // Byte size of the request envelope the client would actually POST.
    const size = (mc: Invocation[], cid?: Record<string, string>): number =>
      new TextEncoder().encode(
        JSON.stringify(
          cid
            ? { using: USING, methodCalls: mc, createdIds: cid }
            : { using: USING, methodCalls: mc },
        ),
      ).length
    // A budget that fits both calls together WITHOUT the seed, but not WITH it.
    const maxSizeRequest = size(calls, createdIds) - 1

    const withoutSeed = planRequest(calls, USING, limits({ maxSizeRequest }))
    const withSeed = planRequest(calls, USING, limits({ maxSizeRequest }), createdIds)
    expect(withoutSeed.requests).toHaveLength(1)
    expect(withSeed.requests).toHaveLength(2)
  })
})

describe('planRequest — back-reference grouping', () => {
  it('keeps a query→get pair in one request while unrelated calls spill over', () => {
    const query: Invocation = ['Email/query', { accountId: 'a' }, 'q']
    const get: Invocation = [
      'Email/get',
      { accountId: 'a', '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' } },
      'g',
    ]
    const calls: Invocation[] = [query, get, ['Core/echo', {}, 'e0'], ['Core/echo', {}, 'e1']]
    const plan = planRequest(calls, USING, limits({ maxCallsInRequest: 2 }))

    // The dependency group (2 calls) fills request 0; the two echoes share request 1.
    expect(at(plan.requests, 0).map((c) => c[2])).toEqual(['q', 'g'])
    expect(at(plan.requests, 1).map((c) => c[2])).toEqual(['e0', 'e1'])
    // The back-reference survives untouched.
    expect(at(at(plan.requests, 0), 1)[1]).toMatchObject({
      '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' },
    })
  })

  it('never id-splits a /get that is referenced by another call', () => {
    const get: Invocation = ['Email/get', { accountId: 'a', ids: ids(5) }, 'src']
    const dependent: Invocation = [
      'Email/set',
      {
        accountId: 'a',
        update: {
          x: { keywords: { '#ref': { resultOf: 'src', name: 'Email/get', path: '/list/0/id' } } },
        },
      },
      'dep',
    ]
    const plan = planRequest([get, dependent], USING, limits({ maxObjectsInGet: 2 }))
    expect(at(plan.logical, 0).kind).toBe('single')
    expect(at(plan.requests, 0).map((c) => c[2])).toEqual(['src', 'dep'])
  })

  it('glues a creation-id object-KEY reference (mailboxIds: { "#box": true }) to its creator', () => {
    // The canonical "create a mailbox, file a new email into it" pattern: the reference lives
    // in an object KEY, not a value. Both /set calls MUST land in one physical request.
    const box: Invocation = [
      'Mailbox/set',
      { accountId: 'a', create: { box: { name: 'New' } } },
      'm',
    ]
    const email: Invocation = [
      'Email/set',
      { accountId: 'a', create: { d1: { mailboxIds: { '#box': true }, subject: 'hi' } } },
      'e',
    ]
    // Echoes bracket the pair; with maxCallsInRequest 2, only gluing keeps m+e together while
    // the plain-order packing (m,e independent) would place them in separate requests.
    const calls: Invocation[] = [['Core/echo', {}, 'x0'], box, email, ['Core/echo', {}, 'x1']]
    const plan = planRequest(calls, USING, limits({ maxCallsInRequest: 2 }))
    expect(plan.requests.map((r) => r.map((c) => c[2]))).toEqual([['x0'], ['m', 'e'], ['x1']])
    expect(at(plan.logical, 1).kind).toBe('single')
    expect(at(plan.logical, 2).kind).toBe('single')
  })

  it('glues a creation-id string-VALUE reference (#draft) to its creating /set', () => {
    const draft: Invocation = [
      'Email/set',
      { accountId: 'a', create: { draft: { subject: 'x' } } },
      'm',
    ]
    const submit: Invocation = [
      'EmailSubmission/set',
      { accountId: 'a', create: { s: { emailId: '#draft', identityId: 'id1' } } },
      'e',
    ]
    const calls: Invocation[] = [['Core/echo', {}, 'x0'], draft, submit, ['Core/echo', {}, 'x1']]
    const plan = planRequest(calls, USING, limits({ maxCallsInRequest: 2 }))
    expect(plan.requests.map((r) => r.map((c) => c[2]))).toEqual([['x0'], ['m', 'e'], ['x1']])
  })

  it('throws when a single dependency group cannot fit maxCallsInRequest', () => {
    const query: Invocation = ['Email/query', { accountId: 'a' }, 'q']
    const get: Invocation = [
      'Email/get',
      { accountId: 'a', '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' } },
      'g',
    ]
    expect(() => planRequest([query, get], USING, limits({ maxCallsInRequest: 1 }))).toThrow(
      JmapError,
    )
  })
})

describe('planRequest — /set chunking (maxObjectsInSet)', () => {
  it('splits create/update/destroy across chunks and merges the results', () => {
    const create = Object.fromEntries(ids(3, 'n').map((k) => [k, { subject: k }]))
    const calls: Invocation[] = [
      ['Email/set', { accountId: 'a', create, destroy: ['d0', 'd1'] }, 's0'],
    ]
    const plan = planRequest(calls, USING, limits({ maxObjectsInSet: 2 }))

    // 3 creates + 2 destroys = 5 objects → ceil(5/2) = 3 chunks.
    expect(flat(plan.requests)).toHaveLength(3)
    expect(at(plan.logical, 0).kind).toBe('set')

    const physical: Invocation[] = [
      [
        'Email/set',
        {
          accountId: 'a',
          oldState: '1',
          newState: '2',
          created: { n0: { id: 'x0' }, n1: { id: 'x1' } },
          destroyed: null,
        },
        's0',
      ],
      [
        'Email/set',
        {
          accountId: 'a',
          oldState: '2',
          newState: '3',
          created: { n2: { id: 'x2' } },
          destroyed: null,
        },
        's0~1',
      ],
      [
        'Email/set',
        { accountId: 'a', oldState: '3', newState: '4', created: null, destroyed: ['d0', 'd1'] },
        's0~2',
      ],
    ]
    const merged = reassembleResponses(plan, physical)
    expect(merged).toHaveLength(1)
    const args = at(merged, 0)[1] as Record<string, unknown>
    expect(args.oldState).toBe('1')
    expect(args.newState).toBe('4')
    expect(args.created).toEqual({ n0: { id: 'x0' }, n1: { id: 'x1' }, n2: { id: 'x2' } })
    expect(args.destroyed).toEqual(['d0', 'd1'])
  })

  it('refuses to split a /set guarded by ifInState (would break the state guard)', () => {
    const create = Object.fromEntries(ids(3, 'n').map((k) => [k, {}]))
    const calls: Invocation[] = [['Email/set', { accountId: 'a', ifInState: 'abc', create }, 's0']]
    expect(() => planRequest(calls, USING, limits({ maxObjectsInSet: 2 }))).toThrow(JmapError)
  })

  it('never object-splits a /set that references its own creation ids (intra-set ref)', () => {
    // Parent + child created together; child.parentId = '#parent' resolves only within one
    // create, so the over-limit set is kept whole rather than split apart.
    const create = {
      parent: { name: 'Parent', parentId: null },
      child: { name: 'Child', parentId: '#parent' },
      other: { name: 'Other', parentId: null },
    }
    const calls: Invocation[] = [['Mailbox/set', { accountId: 'a', create }, 's0']]
    const plan = planRequest(calls, USING, limits({ maxObjectsInSet: 2 }))
    expect(at(plan.logical, 0).kind).toBe('single')
    expect(flat(plan.requests)).toHaveLength(1)
    expect(at(flat(plan.requests), 0)).toEqual(['Mailbox/set', { accountId: 'a', create }, 's0'])
  })

  it('merges updated / notCreated / notUpdated across chunks (oldState=first, newState=last)', () => {
    const create = Object.fromEntries(ids(2, 'n').map((k) => [k, { subject: k }]))
    const update = { u0: { subject: 'U0' }, u1: { subject: 'U1' } }
    const calls: Invocation[] = [['Email/set', { accountId: 'a', create, update }, 's0']]
    const plan = planRequest(calls, USING, limits({ maxObjectsInSet: 2 }))
    // 2 creates + 2 updates = 4 → 2 chunks (creates in chunk 0, updates in chunk 1).
    expect(flat(plan.requests)).toHaveLength(2)

    const physical: Invocation[] = [
      [
        'Email/set',
        {
          accountId: 'a',
          oldState: '1',
          newState: '2',
          created: { n0: { id: 'x0' }, n1: { id: 'x1' } },
          notCreated: { nbad: { type: 'invalidProperties', description: null } },
        },
        's0',
      ],
      [
        'Email/set',
        {
          accountId: 'a',
          oldState: '2',
          newState: '3',
          updated: { u0: null },
          notUpdated: { u1: { type: 'notFound', description: null } },
        },
        's0~1',
      ],
    ]
    const merged = reassembleResponses(plan, physical)
    const args = at(merged, 0)[1] as Record<string, unknown>
    expect(args.oldState).toBe('1')
    expect(args.newState).toBe('3')
    expect(args.created).toEqual({ n0: { id: 'x0' }, n1: { id: 'x1' } })
    expect(args.updated).toEqual({ u0: null })
    expect(args.notCreated).toEqual({ nbad: { type: 'invalidProperties', description: null } })
    expect(args.notUpdated).toEqual({ u1: { type: 'notFound', description: null } })
  })
})

describe('reassembleResponses — split /set partial failure (non-atomic)', () => {
  it('keeps succeeded creates and folds a failed chunk into notCreated (no data loss)', () => {
    const create = Object.fromEntries(ids(4, 'n').map((k) => [k, { subject: k }]))
    const calls: Invocation[] = [['Email/set', { accountId: 'a', create }, 's0']]
    const plan = planRequest(calls, USING, limits({ maxObjectsInSet: 2 }))
    expect(flat(plan.requests)).toHaveLength(2)

    // chunk 0 (n0,n1) succeeds; chunk 1 (n2,n3) fails at the method level.
    const physical: Invocation[] = [
      [
        'Email/set',
        {
          accountId: 'a',
          oldState: '1',
          newState: '2',
          created: { n0: { id: 'x0' }, n1: { id: 'x1' } },
        },
        's0',
      ],
      ['error', { type: 'serverFail', description: 'boom' }, 's0~1'],
    ]
    const merged = reassembleResponses(plan, physical)

    // NOT collapsed to a method error — the real server-side creations survive…
    expect(at(merged, 0)[0]).toBe('Email/set')
    const args = at(merged, 0)[1] as Record<string, unknown>
    expect(args.created).toEqual({ n0: { id: 'x0' }, n1: { id: 'x1' } })
    // …and the failed chunk's objects become per-object SetErrors so retries never duplicate.
    expect(args.notCreated).toEqual({
      n2: { type: 'serverFail', description: 'boom' },
      n3: { type: 'serverFail', description: 'boom' },
    })
    expect(args.oldState).toBe('1')
    expect(args.newState).toBe('2')
  })

  it('surfaces a method-level error only when EVERY chunk of a split /set fails', () => {
    const create = Object.fromEntries(ids(4, 'n').map((k) => [k, {}]))
    const calls: Invocation[] = [['Email/set', { accountId: 'a', create }, 's0']]
    const plan = planRequest(calls, USING, limits({ maxObjectsInSet: 2 }))
    const physical: Invocation[] = [
      ['error', { type: 'serverFail', description: 'a' }, 's0'],
      ['error', { type: 'serverFail', description: 'b' }, 's0~1'],
    ]
    const merged = reassembleResponses(plan, physical)
    expect(at(merged, 0)).toEqual(['error', { type: 'serverFail', description: 'a' }, 's0'])
  })
})

describe('reassembleResponses — errors', () => {
  it('surfaces a method-level error on any chunk as the logical response', () => {
    const calls: Invocation[] = [['Email/get', { accountId: 'a', ids: ids(4) }, 'c0']]
    const plan = planRequest(calls, USING, limits({ maxObjectsInGet: 2 }))
    const physical: Invocation[] = [
      [
        'Email/get',
        { accountId: 'a', state: 's', list: [{ id: 'e0' }, { id: 'e1' }], notFound: [] },
        'c0',
      ],
      ['error', { type: 'serverFail', description: 'boom' }, 'c0~1'],
    ]
    const merged = reassembleResponses(plan, physical)
    expect(at(merged, 0)).toEqual(['error', { type: 'serverFail', description: 'boom' }, 'c0'])
  })
})

describe('planRequest — unusable session limits (F4)', () => {
  // A limit that is not an integer > 0 cannot be honoured by anything here, and one of them used
  // to be fatal: with maxObjectsInSet: 0 the splitter's `i += max` never advanced, so the first
  // write of a session (mark-as-read, move, send) allocated chunk objects until the tab was
  // OOM-killed — read-only use looked fine, so the server was reachable right up to that point.
  const destroyer: Invocation[] = [['Email/set', { accountId: 'a', destroy: ['x', 'y'] }, 'c0']]

  it('does not hang or split on maxObjectsInSet 0 / -1 — it falls back', () => {
    for (const max of [0, -1]) {
      const plan = planRequest(destroyer, USING, limits({ maxObjectsInSet: max }))
      // FALLBACK_LIMITS.maxObjectsInSet (128) > 2 objects ⇒ one unsplit call.
      expect(at(plan.logical, 0).kind, String(max)).toBe('single')
      expect(flat(plan.requests), String(max)).toHaveLength(1)
    }
  })

  it('splits a /set normally once the advertised limit is usable again', () => {
    // Pins that the fallback is a fallback and not a bypass: a real limit of 1 still splits.
    const plan = planRequest(destroyer, USING, limits({ maxObjectsInSet: 1 }))
    expect(at(plan.logical, 0).kind).toBe('set')
    expect(flat(plan.requests)).toHaveLength(2)
  })

  it('falls back for every non-integer / non-positive limit, and keeps the usable ones', () => {
    expect(
      sanitizeLimits({
        maxObjectsInGet: 0,
        maxObjectsInSet: -1,
        maxCallsInRequest: Number.NaN,
        maxSizeRequest: 1.5,
      }),
    ).toEqual(FALLBACK_LIMITS)
    expect(
      sanitizeLimits({
        maxObjectsInGet: Number.POSITIVE_INFINITY,
        maxObjectsInSet: undefined,
        maxCallsInRequest: 4,
        maxSizeRequest: 2_000,
      }),
    ).toEqual({ ...FALLBACK_LIMITS, maxCallsInRequest: 4, maxSizeRequest: 2_000 })
  })

  it('chunks a /get at the fallback when maxObjectsInGet is 0 rather than not at all', () => {
    // The /get path already refused to divide by a non-positive limit, but by silently not
    // chunking at all — a 200-id get then went out whole and the server answered requestTooLarge.
    const plan = planRequest(
      [['Email/get', { accountId: 'a', ids: ids(200) }, 'c0']],
      USING,
      limits({ maxObjectsInGet: 0 }),
    )
    expect(at(plan.logical, 0).kind).toBe('get')
    expect(flat(plan.requests)).toHaveLength(2) // ceil(200 / 128)
  })
})

describe('reassembleResponses — oversized server arrays (F22)', () => {
  it('merges /get chunks whose lists exceed the spread-argument limit', () => {
    // Same hazard as in JmapClient.call: `list.push(...args.list)` passes one argument per element
    // and overflows the call stack somewhere above ~125k. The list sizes here are the server's
    // claim, not ours — a chunk may answer with far more than it was asked for.
    const plan = planRequest(
      [['Email/get', { accountId: 'a', ids: ids(4) }, 'c0']],
      USING,
      limits({ maxObjectsInGet: 2 }),
    )
    const big = (n: number, from: number) => Array.from({ length: n }, (_, i) => ({ id: from + i }))
    const merged = reassembleResponses(plan, [
      ['Email/get', { accountId: 'a', state: 's', list: big(150_000, 0), notFound: [] }, 'c0'],
      ['Email/get', { accountId: 'a', state: 's', list: big(1, 150_000), notFound: [] }, 'c0~1'],
    ])
    const args = at(merged, 0)[1] as { list: unknown[] }
    expect(args.list).toHaveLength(150_001)
  })
})
