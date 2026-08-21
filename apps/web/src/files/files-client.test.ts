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

interface Fake {
  client: JmapClient
  /** Every batch that was sent, in order. */
  sent: Invocation<Record<string, unknown>>[][]
}

/**
 * A server with Stalwart 0.16's manners.
 *
 * Two of them are load-bearing. (1) `parentId: null` inside a filter is refused, and the refusal
 * takes the WHOLE batch with it — which is why this throws rather than returning a method error.
 * (2) A query with no filter returns every node in the account, not the roots: "no filter" means
 * "no restriction", and putting the level back together is the client's job.
 */
function fakeClient(nodes: FileNode[], principals: Principal[] = []): Fake {
  const sent: Invocation<Record<string, unknown>>[][] = []

  const client = {
    request() {
      return new RequestBuilder(async (builder) => {
        const calls = builder.invocations as Invocation<Record<string, unknown>>[]
        sent.push(calls)
        const responses: Invocation<Record<string, unknown>>[] = []
        let queried: FileNode[] = []
        for (const [name, args, id] of calls) {
          if (name === 'FileNode/query') {
            const filter = args.filter as { parentId?: string | null } | undefined
            if (filter !== undefined && filter.parentId === null) {
              throw new Error('notRequest: invalid type: null, expected a borrowed string')
            }
            queried =
              filter === undefined ? nodes : nodes.filter((n) => n.parentId === filter.parentId)
            responses.push([
              name,
              { accountId: ACC, queryState: 'q1', ids: queried.map((n) => n.id) },
              id,
            ])
            continue
          }
          if (name === 'FileNode/get') {
            responses.push([name, { accountId: ACC, state: 's1', list: queried, notFound: [] }, id])
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
          responses.push([
            name,
            { accountId: ACC, state: 's1', list: principals, notFound: [] },
            id,
          ])
        }
        return new MethodResponses(responses, 'session-state', undefined)
      })
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

describe('list', () => {
  it('sends NO filter key at the root — an absent argument cannot be refused', async () => {
    const fake = fakeClient([node('r1', null)])
    await makeFilesClient(fake.client, ACC).list(null)

    const args = argsOf(fake, 'FileNode/query')
    expect(Object.hasOwn(args, 'filter')).toBe(false)
  })

  it('lists the root against a server that refuses a null filter', async () => {
    const fake = fakeClient([node('r1', null), node('c1', 'd1')])

    await expect(makeFilesClient(fake.client, ACC).list(null)).resolves.toEqual([node('r1', null)])
  })

  it('keeps only this level when the unfiltered answer is the whole tree', async () => {
    const fake = fakeClient([
      node('d1', null, { nodeType: 'directory', name: 'folder', blobId: null, type: null }),
      node('r1', null),
      node('c1', 'd1'),
      node('c2', 'd1'),
    ])

    const roots = await makeFilesClient(fake.client, ACC).list(null)

    expect(roots.map((n) => n.id)).toEqual(['d1', 'r1'])
  })

  it('filters server-side inside a folder, where a string parentId is accepted', async () => {
    const fake = fakeClient([node('r1', null), node('c1', 'd1')])

    const children = await makeFilesClient(fake.client, ACC).list('d1')

    expect(argsOf(fake, 'FileNode/query').filter).toEqual({ parentId: 'd1' })
    expect(children.map((n) => n.id)).toEqual(['c1'])
  })

  it('puts directories before files', async () => {
    const fake = fakeClient([
      node('f1', null, { name: 'a-file' }),
      node('d1', null, { nodeType: 'directory', name: 'z-folder', blobId: null, type: null }),
    ])

    const roots = await makeFilesClient(fake.client, ACC).list(null)

    expect(roots.map((n) => n.id)).toEqual(['d1', 'f1'])
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
