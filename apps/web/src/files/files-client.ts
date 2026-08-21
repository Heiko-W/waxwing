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
  FileNode,
  FileNodeCapability,
  FileNodeRights,
  Id,
  JmapClient,
  Principal,
  PrincipalCapability,
} from '@waxwing/jmap'
import { Capabilities, hasCapability, Methods, principalSearchFilter } from '@waxwing/jmap'
import type { JmapSession } from '../app/session/types'

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

export interface FilesClient {
  /** The children of `parentId`, or the roots when it is `null`. */
  list(parentId: Id | null): Promise<FileNode[]>
  /** Uploads `file` into `parentId`. */
  upload(file: File, parentId: Id | null): Promise<FileNode | null>
  createFolder(name: string, parentId: Id | null): Promise<void>
  rename(id: Id, name: string): Promise<void>
  destroy(id: Id): Promise<void>
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

/**
 * The user's own principal id, from the account capability.
 *
 * `null` when the server does not advertise it — in which case the picker cannot exclude the user
 * and does not pretend to. Sharing a file with yourself is harmless; silently filtering the wrong
 * row out would not be.
 */
export function currentUserPrincipalId(
  session: JmapSession | null,
  accountId: Id | null,
): Id | null {
  if (session === null || accountId === null) return null
  const capability = session.accounts?.[accountId]?.accountCapabilities?.[
    Capabilities.principals
  ] as PrincipalCapability | undefined
  return capability?.currentUserPrincipalId ?? null
}

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

  return {
    async list(parentId) {
      const builder = client.request()
      const query = builder.invoke(Methods.fileNodeQuery, {
        accountId,
        /*
         * THE ROOT LEVEL SENDS NO FILTER AT ALL, and that is the whole fix for the screen.
         *
         * `filter: { parentId: null }` is what RFC 9670's filter condition says "the roots" — and
         * Stalwart 0.16 answers it with `invalidArguments: "invalid type: null, expected a
         * borrowed string"`, because it accepts `parentId` only as a String even though it returns
         * that same field as `null` in every root node it hands back. What made that a dead screen
         * rather than an empty list is the SECOND half: a single refused method makes Stalwart
         * reject the WHOLE request with HTTP 400 `notRequest`, so the `FileNode/get` below never
         * ran either. Measured by `curl` against the fixture: no filter → OK, `{parentId:"a"}` →
         * OK, `{parentId:null}` → refused, and the app's own two-method request → 400.
         *
         * So an optional argument whose value we do not have is OMITTED, never sent as `null`.
         * That is the repo's `exactOptionalPropertyTypes` idiom (conditional spreading) applied to
         * the wire, and it is the shape that survives a server which is stricter than the RFC:
         * a key that is not there cannot be rejected.
         *
         * The price is honest and bounded: an unfiltered query returns the whole tree, so the
         * `limit` below is spent on every node rather than on this level's, and the client-side
         * level filter under `list` puts the level back together. For an account with more than
         * `limit` nodes the root listing can therefore be short — a listing that is incomplete at
         * the far end beats a screen that never loads at all, and no other request shape gets both
         * past this server.
         */
        ...(parentId === null ? {} : { filter: { parentId } }),
        sort: [
          // Directories first, then by name — the ordering every file manager uses, and the one
          // `fileNodeQuerySortOptions` supports.
          { property: 'name', isAscending: true },
        ],
        limit: 500,
      })
      const nodes = builder.invoke(Methods.fileNodeGet, {
        accountId,
        '#ids': query.ref('/ids'),
      })
      const responses = await builder.send()
      // The level the caller asked for, filtered HERE and not only by the server: at the root the
      // query above carries no filter and the answer is the whole tree, and below the root this
      // costs one pass over at most `limit` nodes to stop trusting a server we already know reads
      // this filter differently than we do.
      const list = responses.get(nodes).list.filter((node) => (node.parentId ?? null) === parentId)
      // Directories before files, then the server's name order within each group.
      return [
        ...list.filter((node) => node.nodeType === 'directory'),
        ...list.filter((node) => node.nodeType !== 'directory'),
      ]
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

    async destroy(id) {
      const responses = await client.call([
        [Methods.fileNodeSet.name, { accountId, destroy: [id] }, 'f0'],
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
      const builder = client.request()
      // `principalSearchFilter` answers `null` for an empty query — "everyone" — and the share
      // picker opens on exactly that. Same rule as `list` above: "no filter" is an ABSENT key, not
      // a null one. This one has not been seen to fail, and that is the point of fixing it now:
      // it is the identical shape one round trip away from the one that took the Files screen out.
      const filter = principalSearchFilter(query)
      const found = builder.invoke(Methods.principalQuery, {
        accountId,
        // `text`, not `name`: measured, see `principalSearchFilter`.
        ...(filter === null ? {} : { filter }),
        limit: 50,
      })
      const principals = builder.invoke(Methods.principalGet, {
        accountId,
        '#ids': found.ref('/ids'),
      })
      const responses = await builder.send()
      return responses.get(principals).list.filter((principal) => principal.id !== selfPrincipalId)
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
