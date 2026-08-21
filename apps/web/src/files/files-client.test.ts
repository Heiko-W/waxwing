/**
 * The JMAP seam for file storage (M5.7, FR-FILE-01) — the request SHAPES, not the round trip.
 *
 * These tests exist because of one measured failure and the class of failure behind it. Stalwart
 * 0.16 answers `FileNode/query` with `filter: { parentId: null }` — the draft's own way of saying
 * "the roots" — with `invalidArguments: "invalid type: null, expected a borrowed string"`, and it
 * then rejects the **entire** request with HTTP 400 `notRequest`. One optional argument sent as
 * `null` instead of being omitted therefore took out the whole Files screen: no listing, no empty
 * state, no download, no rename, no delete, no share, while uploads kept landing on the server
 * unseen.
 *
 * So the invariant under test is not "the root listing works" but the shape that makes it work
 * anywhere: **an optional request argument we do not have a value for is absent from the request,
 * never present-and-null.** `fakeClient` refuses a null filter exactly as the server does — by
 * failing the whole request — so a regression fails here rather than in a browser.
 *
 * The 2026-08-21 additions (B-6, D-1, D-3) are checked against the same fake, and two of them are
 * about the SECOND thing this server does that no type can express: `maxObjectsInGet` is 500, and a
 * listing longer than that used to end there in silence.
 */

import type { FileNode, Invocation, JmapClient, Principal } from '@waxwing/jmap'
import { MethodResponses, RequestBuilder } from '@waxwing/jmap'
import { describe, expect, it } from 'vitest'
import { makeFilesClient } from './files-client'

const ACC = 'a'

function node(id: string, parentId: string | null, overrides: Partial<FileNode> = {}): FileNode {
  return {
    id,
    parentId,
    nodeType: 'file',
    blobId: `blob-${id}`,
    target: null,
    size: 10,
    name: `${id}.txt`,
    type: 'text/plain',
    created: '2026-08-21T08:00:00Z',
    modified: '2026-08-21T08:00:00Z',
    accessed: '2026-08-21T08:00:00Z',
    changed: '2026-08-21T08:00:00Z',
    executable: false,
    isSubscribed: false,
    myRights: {
      mayRead: true,
      mayAddChildren: true,
      mayRename: true,
      mayDelete: true,
      mayModifyContent: true,
      mayShare: true,
    },
    shareWith: {},
    role: null,
    ...overrides,
  }
}

const folder = (id: string, parentId: string | null, name: string): FileNode =>
  node(id, parentId, { nodeType: 'directory', name, blobId: null, type: null })

interface Fake {
  client: JmapClient
  /** Every batch that was sent, in order. */
  sent: Invocation<Record<string, unknown>>[][]
}

/**
 * A server with Stalwart 0.16's manners.
 *
 * Four of them are load-bearing. (1) `parentId: null` inside a filter is refused, and the refusal
 * takes the WHOLE batch with it — which is why this throws rather than returning a method error.
 * (2) A query with no filter returns every node in the account, not the roots: "no filter" means
 * "no restriction", and putting the level back together is the client's job. (3) `position` and
 * `limit` are honoured, so a listing longer than one page is a listing that has to be walked.
 * (4) `FileNode/get` answers a back-reference with the query's own ids and an explicit `ids` list
 * with those nodes — the two paths `files-client.ts` actually uses.
 */
function fakeClient(nodes: FileNode[], principals: Principal[] = []): Fake {
  const sent: Invocation<Record<string, unknown>>[][] = []

  const handle = (calls: Invocation<Record<string, unknown>>[]): MethodResponses => {
    sent.push(calls)
    const responses: Invocation<Record<string, unknown>>[] = []
    let queried: FileNode[] = []
    for (const [name, args, id] of calls) {
      if (name === 'FileNode/query') {
        const filter = args.filter as { parentId?: string | null; name?: string } | undefined
        if (filter !== undefined && filter.parentId === null) {
          throw new Error('notRequest: invalid type: null, expected a borrowed string')
        }
        let matched = nodes
        if (filter?.parentId !== undefined) {
          matched = matched.filter((n) => n.parentId === filter.parentId)
        }
        if (filter?.name !== undefined) {
          const term = filter.name
          matched = matched.filter((n) => n.name.includes(term))
        }
        const position = (args.position as number | undefined) ?? 0
        const limit = (args.limit as number | undefined) ?? matched.length
        queried = matched.slice(position, position + limit)
        responses.push([
          name,
          {
            accountId: ACC,
            queryState: 'q1',
            position,
            total: matched.length,
            ids: queried.map((n) => n.id),
          },
          id,
        ])
        continue
      }
      if (name === 'FileNode/get') {
        const ids = args.ids as string[] | undefined
        const list = ids === undefined ? queried : nodes.filter((n) => ids.includes(n.id))
        responses.push([name, { accountId: ACC, state: 's1', list, notFound: [] }, id])
        continue
      }
      if (name === 'FileNode/set') {
        responses.push([
          name,
          { accountId: ACC, oldState: 's0', newState: 's1', updated: {}, destroyed: [] },
          id,
        ])
        continue
      }
      if (name === 'Principal/query') {
        if (args.filter === null) throw new Error('notRequest: invalid type: null')
        responses.push([
          name,
          { accountId: ACC, queryState: 'q1', ids: principals.map((p) => p.id) },
          id,
        ])
        continue
      }
      responses.push([name, { accountId: ACC, state: 's1', list: principals, notFound: [] }, id])
    }
    return new MethodResponses(responses, 'session-state', undefined)
  }

  const client = {
    request() {
      return new RequestBuilder(async (builder) =>
        handle(builder.invocations as Invocation<Record<string, unknown>>[]),
      )
    },
    async call(calls: Invocation<Record<string, unknown>>[]) {
      return handle(calls)
    },
  } as unknown as JmapClient

  return { client, sent }
}

/** The arguments of the first `name` call in the last batch sent. */
function argsOf(fake: Fake, name: string): Record<string, unknown> {
  const batch = fake.sent.at(-1) ?? []
  const call = batch.find(([called]) => called === name)
  if (call === undefined) throw new Error(`no ${name} in the last batch`)
  return call[1]
}

/** Every `name` call across every batch. */
function allCalls(fake: Fake, name: string): Record<string, unknown>[] {
  return fake.sent
    .flat()
    .filter(([called]) => called === name)
    .map(([, args]) => args)
}

describe('list', () => {
  it('sends NO filter key at the root — an absent argument cannot be refused', async () => {
    const fake = fakeClient([node('r1', null)])
    await makeFilesClient(fake.client, ACC).list(null)

    const args = argsOf(fake, 'FileNode/query')
    expect(Object.hasOwn(args, 'filter')).toBe(false)
  })

  it('lists the root against a server that refuses a null filter', async () => {
    const fake = fakeClient([node('r1', null), node('c1', 'd1')])

    const listing = await makeFilesClient(fake.client, ACC).list(null)

    expect(listing.nodes).toEqual([node('r1', null)])
  })

  it('keeps only this level when the unfiltered answer is the whole tree', async () => {
    const fake = fakeClient([
      folder('d1', null, 'folder'),
      node('r1', null),
      node('c1', 'd1'),
      node('c2', 'd1'),
    ])

    const listing = await makeFilesClient(fake.client, ACC).list(null)

    expect(listing.nodes.map((n) => n.id).sort()).toEqual(['d1', 'r1'])
  })

  it('filters server-side inside a folder, where a string parentId is accepted', async () => {
    const fake = fakeClient([node('r1', null), node('c1', 'd1')])

    const listing = await makeFilesClient(fake.client, ACC).list('d1')

    expect(argsOf(fake, 'FileNode/query').filter).toEqual({ parentId: 'd1' })
    expect(listing.nodes.map((n) => n.id)).toEqual(['c1'])
  })

  it('sends the comparator it was given, so a TRUNCATED listing is truncated in that order', async () => {
    const fake = fakeClient([node('r1', null)])

    await makeFilesClient(fake.client, ACC).list(null, {
      sort: [{ property: 'size', isAscending: false }],
    })

    expect(argsOf(fake, 'FileNode/query').sort).toEqual([{ property: 'size', isAscending: false }])
  })

  it('omits `position` on the first page rather than sending the default', async () => {
    const fake = fakeClient([node('r1', null)])
    await makeFilesClient(fake.client, ACC).list(null)

    // Same rule as the filter: an argument we have no need to send is one the server cannot refuse.
    expect(Object.hasOwn(argsOf(fake, 'FileNode/query'), 'position')).toBe(false)
  })
})

/**
 * B-6 — the listing that stopped at 500 and said nothing.
 *
 * `maxObjectsInGet` is 500, the root query is unfiltered, and the old client sent one page. An
 * account with 600 nodes therefore showed a root folder that was short and looked complete, which
 * is worse than one that is short and says so: every conclusion drawn from it ("I must have deleted
 * that") is wrong.
 */
describe('a listing longer than one page', () => {
  const many = (count: number, parentId: string | null = null): FileNode[] =>
    Array.from({ length: count }, (_, index) =>
      node(`n${String(index).padStart(4, '0')}`, parentId),
    )

  it('walks past the first page instead of stopping at it', async () => {
    const fake = fakeClient(many(1200))

    const listing = await makeFilesClient(fake.client, ACC).list(null)

    expect(listing.nodes).toHaveLength(1200)
    expect(listing.truncated).toBe(false)
    // Three pages: 500, 500, 200 — the short one is what says the walk is over.
    expect(allCalls(fake, 'FileNode/query').map((args) => args.position)).toEqual([
      undefined,
      500,
      1000,
    ])
  })

  it('says so when it stops short, rather than looking complete', async () => {
    // 10 pages of 500 is the ceiling; the eleventh page is the one never fetched.
    const fake = fakeClient(many(5001))

    const listing = await makeFilesClient(fake.client, ACC).list(null)

    expect(listing.nodes).toHaveLength(5000)
    expect(listing.truncated).toBe(true)
  })

  it('reports complete when the last page happens to fill exactly', async () => {
    // The off-by-one that would make every 500-node account claim to be truncated.
    const fake = fakeClient(many(500))

    const listing = await makeFilesClient(fake.client, ACC).list(null)

    expect(listing.nodes).toHaveLength(500)
    expect(listing.truncated).toBe(false)
  })

  it('stops on a server that ignores `position` instead of paging for ever', async () => {
    const nodes = many(600)
    // A server that answers every page with the first one. Not hypothetical: this client already
    // knows this server reads one query argument differently than the draft says.
    const stuck = {
      request: () =>
        new RequestBuilder(async (builder) => {
          const calls = builder.invocations as Invocation<Record<string, unknown>>[]
          const responses: Invocation<Record<string, unknown>>[] = []
          const head = nodes.slice(0, 500)
          for (const [name, , id] of calls) {
            responses.push(
              name === 'FileNode/query'
                ? [
                    name,
                    { accountId: ACC, queryState: 'q', position: 0, ids: head.map((n) => n.id) },
                    id,
                  ]
                : [name, { accountId: ACC, state: 's', list: head, notFound: [] }, id],
            )
          }
          return new MethodResponses(responses, 'session', undefined)
        }),
    } as unknown as JmapClient

    const listing = await makeFilesClient(stuck, ACC).list(null)

    expect(listing.nodes).toHaveLength(500)
    expect(listing.truncated).toBe(true)
  })
})

/** D-1 — the server changes `parentId` without complaint; the client had no way to ask. */
describe('move', () => {
  it('patches parentId for every node in one set', async () => {
    const fake = fakeClient([node('f1', 'd1'), node('f2', 'd1')])

    await makeFilesClient(fake.client, ACC).move(['f1', 'f2'], 'd2')

    expect(argsOf(fake, 'FileNode/set').update).toEqual({
      f1: { parentId: 'd2' },
      f2: { parentId: 'd2' },
    })
  })

  it('sends a real null for the root — the value the server itself returns there', async () => {
    const fake = fakeClient([node('f1', 'd1')])

    await makeFilesClient(fake.client, ACC).move(['f1'], null)

    // NOT the omitted-argument rule: that one is about a query FILTER condition, where this server
    // reads `parentId` as a required string. Here it is the property's own value in a patch, and
    // "no parent" has no other spelling.
    expect(argsOf(fake, 'FileNode/set').update).toEqual({ f1: { parentId: null } })
  })

  it('spends no round trip on an empty selection', async () => {
    const fake = fakeClient([])

    await makeFilesClient(fake.client, ACC).move([], 'd1')

    expect(fake.sent).toEqual([])
  })
})

describe('destroy', () => {
  it('takes the whole selection in one set, so it cannot half-succeed', async () => {
    const fake = fakeClient([node('f1', null), node('f2', null)])

    await makeFilesClient(fake.client, ACC).destroy(['f1', 'f2'])

    expect(argsOf(fake, 'FileNode/set').destroy).toEqual(['f1', 'f2'])
  })
})

/** D-3 — `FileNode/query` supports a name condition and nothing was asking. */
describe('search', () => {
  it('sends the name condition and finds across the whole account', async () => {
    const fake = fakeClient([
      folder('d1', null, 'invoices'),
      node('f1', 'd1', { name: 'report.txt' }),
      node('f2', null, { name: 'notes.txt' }),
    ])

    const hits = await makeFilesClient(fake.client, ACC).search('report')

    expect(hits.map((hit) => hit.node.id)).toEqual(['f1'])
  })

  it('names the folder each hit was found in — two `report.txt` are not one row twice', async () => {
    const fake = fakeClient([
      folder('d1', null, 'invoices'),
      folder('d2', null, 'archive'),
      node('f1', 'd1', { name: 'report.txt' }),
      node('f2', 'd2', { name: 'report.txt' }),
      node('f3', null, { name: 'report.txt' }),
    ])

    const hits = await makeFilesClient(fake.client, ACC).search('report')

    expect(hits.map((hit) => hit.parent?.name ?? null)).toEqual(['invoices', 'archive', null])
  })

  it('answers a blank query with nothing rather than with the whole account', async () => {
    const fake = fakeClient([node('f1', null)])

    // `{ name: "" }` matches every node there is, and a field nobody has typed into is not a
    // request for the entire tree.
    await expect(makeFilesClient(fake.client, ACC).search('   ')).resolves.toEqual([])
    expect(fake.sent).toEqual([])
  })
})

describe('ancestors', () => {
  it('walks up to the root so a hit can state where it really lives', async () => {
    const fake = fakeClient([
      folder('d1', null, 'work'),
      folder('d2', 'd1', 'invoices'),
      node('f1', 'd2', { name: 'report.txt' }),
    ])

    const chain = await makeFilesClient(fake.client, ACC).ancestors(node('f1', 'd2'))

    expect(chain.map((n) => n.name)).toEqual(['work', 'invoices'])
  })

  it('is empty for a node at the root', async () => {
    const fake = fakeClient([node('f1', null)])

    await expect(makeFilesClient(fake.client, ACC).ancestors(node('f1', null))).resolves.toEqual([])
  })
})

describe('searchPrincipals', () => {
  it('omits the filter for an empty query instead of sending null', async () => {
    const fake = fakeClient([])

    await makeFilesClient(fake.client, ACC).searchPrincipals('   ')

    expect(Object.hasOwn(argsOf(fake, 'Principal/query'), 'filter')).toBe(false)
  })

  it('sends a text filter for a real query', async () => {
    const fake = fakeClient([])

    await makeFilesClient(fake.client, ACC).searchPrincipals('bob')

    expect(argsOf(fake, 'Principal/query').filter).toEqual({ text: 'bob' })
  })
})
