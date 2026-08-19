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
        filter: { parentId },
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
      const list = responses.get(nodes).list
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
      const found = builder.invoke(Methods.principalQuery, {
        accountId,
        // `text`, not `name`: measured, see `principalSearchFilter`.
        filter: principalSearchFilter(query),
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
