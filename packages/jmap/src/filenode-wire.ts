/**
 * The two wire formats of `FileNode`, and one internal shape between them.
 *
 * `draft-ietf-jmap-filenode` moved under Stalwart's feet. Measured on the same fixture, a file node
 * on **0.16.27** and on **1.0.0**:
 *
 * |                 | 0.16.27                                      | 1.0.0                                        |
 * | --------------- | -------------------------------------------- | -------------------------------------------- |
 * | kind            | `nodeType: "file" \| "directory" \| "symlink"` | `@type: "File" \| "Directory" \| "SymLink"`    |
 * | media type      | `type`                                       | `mediaType`                                  |
 * | on create       | kind optional (a node with no `blobId` is a directory) | `@type` REQUIRED — `"@type is required on creation."`, and `nodeType`/`type` are refused as `Invalid property` |
 * | absent values   | present as `null` (`blobId`, `target`, `size`, `type`, `executable`) | simply not there                |
 * | no shares       | `shareWith: {}`                              | `shareWith: null`                            |
 * | rights          | six `may…` flags, on EVERY node             | seven — `maySetMetadata` joined them, and only a **directory** carries them: a file has no `myRights` and no `shareWith` and inherits its folder's |
 * | capability      | no `supportedNodeTypes`                      | `supportedNodeTypes: ["Directory","File","SymLink"]` |
 *
 * The code that draws the Files screen, sorts it and attaches a file to a message was written against
 * the left column and reads `node.nodeType === 'directory'` in a dozen places. Teaching each of them
 * two spellings would be a dozen chances to teach one of them wrong, so the translation happens once,
 * at the two points where a node enters the app ({@link normalizeFileNode}), and at the two points
 * where one is written ({@link newDirectory}, {@link newFile}).
 *
 * **Which dialect is asked of the server, not guessed from its version.** The account's
 * `urn:ietf:params:jmap:filenode` capability lists `supportedNodeTypes` on 1.0 and has no such key
 * on 0.16 — the draft's own way of saying "the kind is a typed object". {@link fileNodeWire} reads it.
 */

import type { Id } from './types/core'
import type { FileNode, FileNodeRights, FileNodeType } from './types/filenode'

/** `legacy` is the 0.16 spelling (`nodeType`, `type`); `typed` is 1.0's (`@type`, `mediaType`). */
export type FileNodeWire = 'legacy' | 'typed'

/** What `urn:ietf:params:jmap:filenode` advertises when the server speaks the typed form. */
export function fileNodeWire(capability: unknown): FileNodeWire {
  const types = (capability as { supportedNodeTypes?: unknown } | null | undefined)
    ?.supportedNodeTypes
  return Array.isArray(types) ? 'typed' : 'legacy'
}

const TYPED_KINDS: Readonly<Record<string, FileNodeType>> = {
  File: 'file',
  Directory: 'directory',
  SymLink: 'symlink',
}

/** No right at all. What a node gets when nothing says otherwise — the same as 0.16's child of a shared folder. */
export const NO_FILE_RIGHTS: FileNodeRights = {
  mayRead: false,
  mayAddChildren: false,
  mayRename: false,
  mayDelete: false,
  mayModifyContent: false,
  mayShare: false,
}

/** Every right: what the owner of a node has. */
export const FULL_FILE_RIGHTS: FileNodeRights = {
  mayRead: true,
  mayAddChildren: true,
  mayRename: true,
  mayDelete: true,
  mayModifyContent: true,
  mayShare: true,
  maySetMetadata: true,
}

/**
 * A node in either dialect, as the app's {@link FileNode}.
 *
 * Total on purpose: it fills what the 1.0 server leaves out with the value 0.16 sent, so every
 * consumer can keep treating `blobId`, `type`, `target` and `shareWith` as always-present. A node
 * the server describes with neither kind marker is classified by the one fact both dialects agree
 * on — a directory has no blob.
 *
 * **Rights.** 1.0 puts `myRights` on directories only; a file has none (measured: the owner sees
 * `SharedDir` with all seven and `inside.txt` with no `myRights` at all, the grantee likewise). It
 * inherits its folder's. A node without any therefore gets `fallbackRights` — and defaulting that to
 * "none" hid Delete, Rename, Share and Download from every file in the user's OWN account, which is
 * how the end-to-end suite found it. {@link normalizeFileNodes} resolves the inheritance within a
 * batch; callers say what a node with no parent in the batch gets.
 */
export function normalizeFileNode(
  raw: object,
  fallbackRights: FileNodeRights = NO_FILE_RIGHTS,
): FileNode {
  const node = raw as Record<string, unknown> & Partial<FileNode>
  const typed = typeof node['@type'] === 'string' ? TYPED_KINDS[node['@type']] : undefined
  const blobId = node.blobId ?? null
  const kind: FileNodeType = typed ?? node.nodeType ?? (blobId === null ? 'directory' : 'file')
  const mediaType = typeof node.mediaType === 'string' ? node.mediaType : undefined
  // The wire-only spellings are dropped rather than carried along: a node that has both `type` and
  // `mediaType` on it is a node nobody can say the truth of.
  const { '@type': _kind, mediaType: _mediaType, ...rest } = node
  return {
    ...rest,
    nodeType: kind,
    blobId,
    target: node.target ?? null,
    size: node.size ?? 0,
    type: node.type ?? mediaType ?? null,
    executable: node.executable ?? false,
    myRights: node.myRights ?? fallbackRights,
    shareWith: node.shareWith ?? {},
    role: node.role ?? null,
  } as FileNode
}

/**
 * {@link normalizeFileNode} over a batch, with rights inherited down the tree where the batch holds
 * the folder.
 *
 * A node that carries `myRights` keeps them. One that does not takes its parent's — the parent's
 * OWN, if it has them, or what the parent inherited in turn — and a node whose parent is not in the
 * batch takes `rootRights`: pass {@link FULL_FILE_RIGHTS} for the user's own account (everything in
 * it is theirs) and {@link NO_FILE_RIGHTS} for a delegated one, where the right answer lives in a
 * folder this batch may not hold and "none" is what 0.16 reported for such a node too.
 */
export function normalizeFileNodes(
  raws: readonly object[],
  rootRights: FileNodeRights,
): FileNode[] {
  const byId = new Map<string, Record<string, unknown>>()
  for (const raw of raws) {
    const id = (raw as { id?: unknown }).id
    if (typeof id === 'string') byId.set(id, raw as Record<string, unknown>)
  }
  const resolved = new Map<string, FileNodeRights>()
  const rightsOf = (raw: Record<string, unknown>, depth: number): FileNodeRights => {
    const own = raw.myRights as FileNodeRights | null | undefined
    if (own !== undefined && own !== null) return own
    const id = raw.id as string
    const known = resolved.get(id)
    if (known !== undefined) return known
    const parentId = raw.parentId
    const parent = typeof parentId === 'string' ? byId.get(parentId) : undefined
    // `depth` bounds a cycle a hostile or broken server could draw; the tree is capped at 64 levels.
    const rights = parent === undefined || depth > 64 ? rootRights : rightsOf(parent, depth + 1)
    resolved.set(id, rights)
    return rights
  }
  return raws.map((raw) => normalizeFileNode(raw, rightsOf(raw as Record<string, unknown>, 0)))
}

/** The create object for a directory. `name` and `parentId` ride alongside. */
export function newDirectory(
  wire: FileNodeWire,
  fields: { name: string; parentId: Id | null },
): Record<string, unknown> {
  return wire === 'typed'
    ? { '@type': 'Directory', ...fields }
    : { nodeType: 'directory', ...fields }
}

/**
 * The create object for a file made from an uploaded blob.
 *
 * On 1.0 a file created WITHOUT `mediaType` is stored as `application/octet-stream` whatever the
 * blob was uploaded as (measured) — the type is not inherited from the upload, so a PDF would
 * download as an anonymous binary. It is therefore always sent.
 */
export function newFile(
  wire: FileNodeWire,
  fields: { name: string; parentId: Id | null; blobId: Id; mediaType: string },
): Record<string, unknown> {
  const { mediaType, ...rest } = fields
  return wire === 'typed' ? { '@type': 'File', ...rest, mediaType } : { ...rest, type: mediaType }
}
