/**
 * JMAP File Storage — `FileNode` (M5.7, FR-FILE-01).
 *
 * **Standardisation status:** `draft-ietf-jmap-filenode`, a JMAP working-group document with no
 * RFC number. Stalwart's README claims draft-03 while the IETF is at -14, so the shapes below were
 * **measured against Stalwart 0.16** rather than transcribed from either. Where a future revision
 * disagrees with the server, the server is what this client talks to.
 *
 * A file node is a filesystem entry: a directory, a file with a blob, or a symlink. The tree is
 * `parentId`-linked, with `null` for the roots — the same shape as the mailbox tree, which is why
 * it needs no new UI vocabulary.
 */

import type {
  ChangesRequest,
  ChangesResponse,
  FilterOperator,
  GetRequest,
  GetResponse,
  Id,
  QueryChangesRequest,
  QueryChangesResponse,
  QueryRequest,
  QueryResponse,
  SetRequest,
  SetResponse,
  UnsignedInt,
  UTCDate,
} from './core'

/** What a node is. Measured values; the draft also allows `symlink`, which Stalwart returns as such. */
export type FileNodeType = 'file' | 'directory' | 'symlink'

/** Per-node permissions (measured). */
export interface FileNodeRights {
  mayRead: boolean
  mayAddChildren: boolean
  mayRename: boolean
  mayDelete: boolean
  mayModifyContent: boolean
  mayShare: boolean
}

/** A node in the file tree. */
export interface FileNode {
  id: Id
  /** `null` for a root-level node. */
  parentId: Id | null
  nodeType: FileNodeType
  /** The stored bytes; `null` for a directory. */
  blobId: Id | null
  /** The symlink target; `null` otherwise. */
  target: string | null
  size: UnsignedInt
  name: string
  /** Media type; `null` for a directory. */
  type: string | null
  created: UTCDate
  modified: UTCDate
  accessed: UTCDate
  changed: UTCDate
  executable: boolean
  isSubscribed: boolean
  myRights: FileNodeRights
  /** RFC 9670 sharing: principal id → the rights granted to it. */
  shareWith: Record<Id, Partial<FileNodeRights>>
  role: string | null
}

/**
 * The account-level `urn:ietf:params:jmap:filenode` object (measured against Stalwart 0.16).
 *
 * `forbiddenNameChars` and `forbiddenNodeNames` are worth honouring client-side rather than
 * letting the server refuse: the reserved DOS names (`CON`, `LPT1`, …) are exactly the sort of
 * thing a user types without expecting a rejection.
 */
export interface FileNodeCapability {
  maxFileNodeDepth: UnsignedInt | null
  maxSizeFileNodeName: UnsignedInt
  /** A string of characters no name may contain, e.g. `/<>:"\|?*`. */
  forbiddenNameChars: string
  forbiddenNodeNames: string[]
  fileNodeQuerySortOptions: string[]
}

export type FileNodeGetRequest = GetRequest
export type FileNodeGetResponse = GetResponse<FileNode>
export type FileNodeChangesRequest = ChangesRequest
export type FileNodeChangesResponse = ChangesResponse
export interface FileNodeSetRequest extends SetRequest<FileNode> {
  /**
   * If `true`, destroying a directory also destroys everything under it (default `false`);
   * otherwise a directory that still has children cannot be destroyed at all.
   *
   * **The name is `…Children`, not `…Contents`**, and it is measured rather than read off a
   * registry — Stalwart v0.16.18 answers `notDestroyed: { type: "nodeHasChildren" }` for
   * `onDestroyRemoveContents` (RFC 9610's spelling, for address books) and destroys the whole
   * subtree for `onDestroyRemoveChildren`. Getting it wrong is silent in the type system and loud
   * only against a real server, which is why it is spelled out here.
   */
  onDestroyRemoveChildren?: boolean
}
export type FileNodeSetResponse = SetResponse<FileNode>

export interface FileNodeFilterCondition {
  parentId?: Id | null
  /** Substring match on the name. */
  name?: string
  nodeType?: FileNodeType
  type?: string
  minSize?: UnsignedInt
  maxSize?: UnsignedInt
  createdBefore?: UTCDate
  createdAfter?: UTCDate
}

export type FileNodeFilter = FilterOperator | FileNodeFilterCondition

export type FileNodeQueryRequest = Omit<QueryRequest, 'filter'> & {
  filter?: FileNodeFilter | null
}
export type FileNodeQueryResponse = QueryResponse
/** No {@link Methods} entry: file browsing is online-only, so there is no query state to diff. */
export type FileNodeQueryChangesRequest = Omit<QueryChangesRequest, 'filter'> & {
  filter?: FileNodeFilter | null
}
export type FileNodeQueryChangesResponse = QueryChangesResponse

/**
 * Whether `name` is one this server will refuse.
 *
 * Checked before the round trip because the reasons are not guessable: a name containing `:` or
 * called `AUX` is refused for Windows-compatibility reasons that have nothing to do with the
 * user's intent, and "the server said no" is not an explanation anyone can act on.
 */
export function fileNodeNameProblem(
  name: string,
  capability: Pick<
    FileNodeCapability,
    'forbiddenNameChars' | 'forbiddenNodeNames' | 'maxSizeFileNodeName'
  >,
): 'empty' | 'tooLong' | 'forbiddenCharacter' | 'reservedName' | null {
  const trimmed = name.trim()
  if (trimmed === '') return 'empty'
  // The limit is in octets, not characters — a name of emoji is four times its length here.
  if (new TextEncoder().encode(trimmed).length > capability.maxSizeFileNodeName) return 'tooLong'
  for (const character of capability.forbiddenNameChars) {
    if (trimmed.includes(character)) return 'forbiddenCharacter'
  }
  // The reserved names are compared case-insensitively: `con`, `CON` and `Con` are all the DOS
  // device on the platforms this list exists for.
  const upper = trimmed.toUpperCase()
  if (capability.forbiddenNodeNames.some((reserved) => reserved.toUpperCase() === upper)) {
    return 'reservedName'
  }
  return null
}
