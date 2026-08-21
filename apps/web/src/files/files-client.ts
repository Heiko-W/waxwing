/**
 * The JMAP seam for file storage (M5.7, FR-FILE-01).
 *
 * Online-only: files are not in the replica. A folder the user is looking at is one round trip,
 * and a download goes through the same authenticated blob endpoint attachments already use — a
 * file node's `blobId` is an ordinary blob.
 *
 * **Uploads are two steps, and the second one matters.** The bytes go to the upload endpoint,
 * which returns a blob id; `FileNode/set` then creates the node referencing it, and the server
 * mints its OWN blob id for the stored file. Caching the upload id as if it addressed the file is
 * the same trap RFC 9661 sets for Sieve scripts.
 */

import type {
  Comparator,
  FileNode,
  FileNodeCapability,
  FileNodeFilterCondition,
  FileNodeRights,
  Id,
  JmapClient,
  Principal,
} from '@waxwing/jmap'
import { Capabilities, hasCapability, Methods } from '@waxwing/jmap'
import type { JmapSession } from '../app/session/types'
import { searchPrincipals } from '../sharing/principals'

/** Why a write failed, in the terms the UI can explain. */
export type FileFailure = 'nameTaken' | 'tooLarge' | 'overQuota' | 'forbidden' | 'rejected'

export class FileSetError extends Error {
  constructor(
    readonly failure: FileFailure,
    description?: string | null,
  ) {
    super(description ?? failure)
    this.name = 'FileSetError'
  }
}

function classify(type: string): FileFailure {
  switch (type) {
    case 'alreadyExists':
      return 'nameTaken'
    case 'tooLarge':
      return 'tooLarge'
    case 'overQuota':
      return 'overQuota'
    case 'forbidden':
      return 'forbidden'
    default:
      return 'rejected'
  }
}

/**
 * One page of `FileNode/query`, and the ceiling the `#ids` back-reference has to respect.
 *
 * `maxObjectsInGet` is 500 on Stalwart 0.16. The `FileNode/get` below addresses its ids by
 * BACK-REFERENCE, so the generic `/get` chunking in `packages/jmap` cannot help — it splits a list
 * of ids this client does not have. A page therefore has to be small enough to survive the get,
 * which means the query's `limit` is the get's limit too.
 */
const PAGE = 500

/**
 * How many pages one listing will spend before it says so (B-6).
 *
 * The root query carries NO filter (see {@link FilesClient.list}), so at the root a page is a page
 * of the whole account, not of this level — an account with 5 000 nodes needs ten round trips to
 * show a root folder holding three. That is the price of the shape that works against this server,
 * and it is bounded here rather than left to run.
 *
 * What is NOT acceptable is the silence: before this, the listing stopped at 500 and said nothing,
 * so a reader with 600 files saw a folder that looked complete and was not. {@link FileListing}
 * carries the answer to "is this all of it", and the screen states it.
 */
const MAX_PAGES = 10

/** How many hits a search shows. A result list nobody scrolls to the end of is not a better answer. */
const SEARCH_LIMIT = 100

/** A cycle in `parentId` is a server bug, not a tree — {@link FilesClient.ancestors} stops here. */
const MAX_DEPTH = 32

/**
 * The order sent when the caller names none — the one this screen has always sent.
 *
 * Never absent. A query with no `sort` leaves the server free to answer in whatever order it likes,
 * and where the answer is a PAGE of a larger set, that order is what decides which nodes the reader
 * gets at all.
 */
const DEFAULT_SORT: readonly Comparator[] = [{ property: 'name', isAscending: true }]

/** The order to ask the server for. Built by `file-sort.ts`, which is where the gating lives. */
export interface FileQueryOptions {
  readonly sort?: readonly Comparator[]
}

/** A level of the tree, and whether it is all of it. */
export interface FileListing {
  readonly nodes: readonly FileNode[]
  /**
   * The server had more than this client fetched.
   *
   * True means "something is missing from `nodes`", never "something might be": the pages are
   * counted, and a short page ends the walk.
   */
  readonly truncated: boolean
}

/** A search result, with the folder it sits in — `null` for one at the root. */
export interface FileSearchHit {
  readonly node: FileNode
  readonly parent: FileNode | null
}

export interface FilesClient {
  /** The children of `parentId`, or the roots when it is `null`. */
  list(parentId: Id | null, options?: FileQueryOptions): Promise<FileListing>
  /** Nodes across the WHOLE account whose name contains `query`; empty for a blank query. */
  search(query: string, options?: FileQueryOptions): Promise<readonly FileSearchHit[]>
  /** The chain from the root down to `node`'s parent, root first; empty for a node at the root. */
  ancestors(node: FileNode): Promise<readonly FileNode[]>
  /** Uploads `file` into `parentId`. */
  upload(file: File, parentId: Id | null): Promise<FileNode | null>
  createFolder(name: string, parentId: Id | null): Promise<void>
  rename(id: Id, name: string): Promise<void>
  /** Re-parents every node in `ids`; `null` moves them to the root. */
  move(ids: readonly Id[], parentId: Id | null): Promise<void>
  /**
   * Destroys every node in `ids`, permanently.
   *
   * A LIST because a selection is what asks for it (D-2), and one `FileNode/set` is what makes the
   * whole selection succeed or fail together — a per-node loop can leave half a selection deleted,
   * which is the one outcome nothing on screen can describe.
   */
  destroy(ids: readonly Id[]): Promise<void>
  /** The stored bytes, for a download. */
  download(node: FileNode): Promise<Blob | null>
  /**
   * Everyone this account may share with, matching `query` — never including the user themself.
   *
   * An empty query lists everyone rather than nobody: a picker that shows nothing until you type
   * hides the fact that there are only three colleagues to choose from.
   */
  searchPrincipals(query: string): Promise<Principal[]>
  /** Replaces the node's whole grant map. See `sharing.ts` on why the rest must be carried over. */
  setShareWith(id: Id, shareWith: Record<Id, FileNodeRights>): Promise<void>
}

/** Re-exported so the Files screen keeps one import; the implementation is shared (S-3). */
export { currentUserPrincipalId } from '../sharing/principals'

export function makeFilesClient(
  client: JmapClient,
  accountId: Id,
  /** Excluded from principal searches. See {@link currentUserPrincipalId}. */
  selfPrincipalId: Id | null = null,
): FilesClient {
  /** Throws {@link FileSetError} for the first per-object refusal in a `/set` response. */
  function throwIfRefused(response: {
    notCreated?: Record<string, { type: string; description?: string | null }> | null
    notUpdated?: Record<string, { type: string; description?: string | null }> | null
    notDestroyed?: Record<string, { type: string; description?: string | null }> | null
  }): void {
    for (const group of [response.notCreated, response.notUpdated, response.notDestroyed]) {
      const first = Object.values(group ?? {})[0]
      if (first !== undefined) throw new FileSetError(classify(first.type), first.description)
    }
  }

  /**
   * One `FileNode/query` + `FileNode/get` round trip. The shape every listing here is built from.
   *
   * THE ROOT LEVEL SENDS NO FILTER AT ALL, and that is the whole fix for the screen.
   *
   * `filter: { parentId: null }` is what the draft's filter condition says "the roots" — and
   * Stalwart 0.16 answers it with `invalidArguments: "invalid type: null, expected a borrowed
   * string"`, because it accepts `parentId` only as a String even though it returns that same field
   * as `null` in every root node it hands back. What made that a dead screen rather than an empty
   * list is the SECOND half: a single refused method makes Stalwart reject the WHOLE request with
   * HTTP 400 `notRequest`, so the `FileNode/get` below never ran either. Measured by `curl` against
   * the fixture: no filter → OK, `{parentId:"a"}` → OK, `{parentId:null}` → refused, and the app's
   * own two-method request → 400.
   *
   * So an optional argument whose value we do not have is OMITTED, never sent as `null`. That is
   * the repo's `exactOptionalPropertyTypes` idiom (conditional spreading) applied to the wire, and
   * it is the shape that survives a server which is stricter than the draft: a key that is not
   * there cannot be rejected.
   *
   * The price is honest and bounded: an unfiltered query returns the whole tree, so a page is spent
   * on every node rather than on this level's, and the client-side level filter under `list` puts
   * the level back together. Paging is what keeps that price from becoming a truncated listing.
   */
  async function fetchPage(
    filter: FileNodeFilterCondition | undefined,
    sort: readonly Comparator[],
    position: number,
    limit: number,
  ): Promise<{ ids: Id[]; nodes: FileNode[] }> {
    const builder = client.request()
    const query = builder.invoke(Methods.fileNodeQuery, {
      accountId,
      ...(filter === undefined ? {} : { filter }),
      sort: [...sort],
      // Omitted at 0 rather than sent: the same rule the filter follows one line up. A default the
      // server already applies is one more argument it could refuse.
      ...(position === 0 ? {} : { position }),
      limit,
    })
    const nodes = builder.invoke(Methods.fileNodeGet, {
      accountId,
      '#ids': query.ref('/ids'),
    })
    const responses = await builder.send()
    return { ids: responses.get(query).ids, nodes: responses.get(nodes).list }
  }

  /** `FileNode/get` for ids this client already holds — no back-reference, so it chunks normally. */
  async function getNodes(ids: readonly Id[]): Promise<FileNode[]> {
    if (ids.length === 0) return []
    const responses = await client.call([
      [Methods.fileNodeGet.name, { accountId, ids: [...ids] }, 'f0'],
    ])
    return responses.get<{ list: FileNode[] }>('f0').list
  }

  return {
    async list(parentId, options = {}) {
      const sort = options.sort ?? DEFAULT_SORT
      /*
       * PAGED, AND HONEST ABOUT WHERE IT STOPS (B-6).
       *
       * It used to be one query with `limit: 500` and no `position`, so an account with more nodes
       * than that lost the remainder — with nothing on screen to say so. A listing that is short is
       * survivable; a listing that is short and looks complete is not, because every conclusion the
       * reader draws from it ("I must have deleted that file") is wrong.
       *
       * Three ways out of the loop, and they are not the same answer:
       *   - a short page: that was the end of the query, and the listing is COMPLETE;
       *   - {@link MAX_PAGES} spent: the listing is truncated, and the screen says so;
       *   - a page that added nothing new: a server that ignored `position` and is handing back the
       *     same page for ever. Also truncated — and the guard that stops this being a loop.
       */
      const collected = new Map<Id, FileNode>()
      let truncated = false
      let position = 0
      for (let page = 0; ; page += 1) {
        const { ids, nodes } = await fetchPage(
          parentId === null ? undefined : { parentId },
          sort,
          position,
          PAGE,
        )
        const before = collected.size
        for (const node of nodes) collected.set(node.id, node)
        if (ids.length < PAGE) break
        if (collected.size === before || page + 1 >= MAX_PAGES) {
          truncated = true
          break
        }
        position += ids.length
      }
      // The level the caller asked for, filtered HERE and not only by the server: at the root the
      // query above carries no filter and the answer is the whole tree, and below the root this
      // costs one pass to stop trusting a server we already know reads this filter differently
      // than we do. The ORDER is the caller's business — see `file-sort.ts`.
      const nodes = [...collected.values()].filter((node) => (node.parentId ?? null) === parentId)
      return { nodes, truncated }
    },

    async search(query, options = {}) {
      const term = query.trim()
      // An empty search is not a search for everything: `{ name: "" }` matches every node in the
      // account, and answering a blank field with the whole tree is not what anyone asked for.
      if (term === '') return []
      // Deliberately account-wide, and one page of it. `FileNodeFilterCondition` has no "inside
      // this subtree" condition, so a search that claimed to be scoped to the open folder would be
      // a lie about what was searched — the screen says which it is instead.
      const { nodes: list } = await fetchPage(
        { name: term },
        options.sort ?? DEFAULT_SORT,
        0,
        SEARCH_LIMIT,
      )
      /*
       * The folder each hit sits in, in ONE extra round trip.
       *
       * Not decoration. A search spans the whole account, so `report.txt` can appear three times
       * over — and three identical rows are worse than no search at all. This is the same defect
       * `use-row-actions.ts` was built for, one level up: the row has to say WHICH file it is.
       */
      const parentIds = [...new Set(list.map((node) => node.parentId).filter((id) => id !== null))]
      const parents = new Map((await getNodes(parentIds)).map((node) => [node.id, node]))
      return list.map((node) => ({
        node,
        parent: node.parentId === null ? null : (parents.get(node.parentId) ?? null),
      }))
    },

    async ancestors(node) {
      const chain: FileNode[] = []
      let parentId = node.parentId
      for (let depth = 0; parentId !== null && depth < MAX_DEPTH; depth += 1) {
        const [parent] = await getNodes([parentId])
        if (parent === undefined) break
        chain.unshift(parent)
        parentId = parent.parentId
      }
      return chain
    },

    async move(ids, parentId) {
      if (ids.length === 0) return
      /*
       * `parentId: null` IS SENT, and that is not the trap the header warns about.
       *
       * The refused shape was a null inside a `FileNode/query` FILTER CONDITION, where the server
       * reads `parentId` as a required string. Here it is the property's own value in a patch, and
       * `null` is the value every root node carries in the answers this same server sends back —
       * "move it to the root" has no other spelling.
       */
      const update: Record<Id, { parentId: Id | null }> = {}
      for (const id of ids) update[id] = { parentId }
      const responses = await client.call([[Methods.fileNodeSet.name, { accountId, update }, 'f0']])
      throwIfRefused(responses.get<{ notUpdated: Record<string, { type: string }> | null }>('f0'))
    },

    async upload(file, parentId) {
      const uploaded = await client.upload(accountId, file, {
        type: file.type === '' ? 'application/octet-stream' : file.type,
      })
      const responses = await client.call([
        [
          Methods.fileNodeSet.name,
          {
            accountId,
            create: {
              f: {
                name: file.name,
                parentId,
                blobId: uploaded.blobId,
                type: uploaded.type,
              },
            },
          },
          'f0',
        ],
      ])
      const response = responses.get<{
        created: Record<string, FileNode> | null
        notCreated: Record<string, { type: string; description?: string | null }> | null
      }>('f0')
      throwIfRefused(response)
      return response.created?.f ?? null
    },

    async createFolder(name, parentId) {
      const responses = await client.call([
        [
          Methods.fileNodeSet.name,
          { accountId, create: { d: { name, parentId, nodeType: 'directory' } } },
          'f0',
        ],
      ])
      throwIfRefused(responses.get<{ notCreated: Record<string, { type: string }> | null }>('f0'))
    },

    async rename(id, name) {
      const responses = await client.call([
        [Methods.fileNodeSet.name, { accountId, update: { [id]: { name } } }, 'f0'],
      ])
      throwIfRefused(responses.get<{ notUpdated: Record<string, { type: string }> | null }>('f0'))
    },

    async destroy(ids) {
      if (ids.length === 0) return
      const responses = await client.call([
        [Methods.fileNodeSet.name, { accountId, destroy: [...ids] }, 'f0'],
      ])
      throwIfRefused(responses.get<{ notDestroyed: Record<string, { type: string }> | null }>('f0'))
    },

    async download(node) {
      if (node.blobId === null) return null
      const bytes = await client.download(
        accountId,
        node.blobId,
        node.type ?? 'application/octet-stream',
        node.name,
      )
      return new Blob([bytes as BlobPart], { type: node.type ?? 'application/octet-stream' })
    },

    async searchPrincipals(query) {
      // One implementation, in `../sharing/principals.ts`, because the mail-folder share dialog runs
      // the identical query (S-3) and the two rules it encodes — `text` rather than the RFC's
      // `name`, and an ABSENT filter key rather than a null one — are the kind that get re-derived
      // wrongly the second time.
      return await searchPrincipals(client, accountId, query, selfPrincipalId)
    },

    async setShareWith(id, shareWith) {
      const responses = await client.call([
        [Methods.fileNodeSet.name, { accountId, update: { [id]: { shareWith } } }, 'f0'],
      ])
      throwIfRefused(responses.get<{ notUpdated: Record<string, { type: string }> | null }>('f0'))
    },
  }
}

/** Does this server offer file storage for this account? */
export function serverSupportsFiles(
  session: JmapSession | null,
  accountId: string | null,
): boolean {
  if (session === null || accountId === null) return false
  return hasCapability(session, Capabilities.fileNode, accountId)
}

/** The account's file-storage limits, for client-side name checking. */
export function fileCapability(
  session: JmapSession | null,
  accountId: string | null,
): FileNodeCapability | null {
  if (session === null || accountId === null) return null
  const capability = session.accounts?.[accountId]?.accountCapabilities?.[Capabilities.fileNode]
  return (capability as FileNodeCapability | undefined) ?? null
}
