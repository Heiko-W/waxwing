/**
 * Attaching a stored file to a draft (D-5) — the mapping, and the measurement it rests on.
 *
 * **The finding: the bytes never move.** A `FileNode`'s `blobId` can be handed straight to
 * `Email/set create` as `attachments[].blobId`. There is no re-upload, no download-and-upload
 * round trip, and no second copy of the file in the account.
 *
 * Measured against the fixture (Stalwart v0.16.18 on `:18080`) with a throwaway account, because
 * the alternative reading — that a file blob and a mail blob live in different namespaces — would
 * have made this feature cost an upload of every attached file:
 *
 * 1. Upload 213 bytes → blob `ea9xiqw0…be1yornibq`.
 * 2. `FileNode/set create` with that blobId → the node reports its OWN `blobId`, `ca9xiqw0…bamae`.
 *    **The two ids differ** — the upload id does not address the stored file, exactly as
 *    `files-client.ts` warns.
 * 3. `Email/set create` with `attachments: [{ blobId: <the NODE's id>, … }]` → **created**.
 * 4. Download the resulting message part → `sha256` identical to the original 213 bytes.
 *
 * So the id to carry is the NODE's `blobId`, not the one an upload returned, and step 4 is what
 * turns "the server accepted it" into "the recipient gets the file". `Blob/get` on the node's id
 * also returns the content directly, which is the same fact from the other side.
 *
 * The consequence for this module: attaching is a pure, synchronous, offline-safe mapping from a
 * `FileNode` to a {@link DraftAttachment}. It needs no network at all, so a draft assembled on a
 * train sends the file when the outbox drains — the blob is already on the server.
 *
 * **What it deliberately does not do.** A blob reference is not a copy: if the file is deleted from
 * the account before the outbox flushes, the send fails rather than sending stale bytes. That is
 * the honest behaviour and the same one forwarding already has (`reply.ts` `forwardAttachments`
 * carries the source message's blobIds the same way).
 */

import type { FileNode } from '@waxwing/jmap'
import type { JmapSession } from '../app/session/types'
import type { ValidationLimits } from './attachment-upload'
import { validateFile, validateTotal } from './attachment-upload'
import type { DraftAttachment } from './reply'

/** The media type used when a node reports none — the same fallback an upload uses. */
const FALLBACK_TYPE = 'application/octet-stream'

/** `draft-ietf-jmap-filenode`, as the fixture advertises it. */
const FILENODE_CAPABILITY = 'urn:ietf:params:jmap:filenode'

/**
 * Does this account have a file store to attach FROM?
 *
 * Read here rather than through `files/files-client.ts` on purpose: the composer must be able to
 * ask this question without pulling the files module into its chunk. The picker itself is lazy and
 * imports the client; this predicate decides whether the picker is ever offered.
 */
export function canAttachFromFiles(session: JmapSession | null, accountId: string | null): boolean {
  if (session === null || accountId === null) return false
  return session.accounts?.[accountId]?.accountCapabilities?.[FILENODE_CAPABILITY] !== undefined
}

/**
 * Can this node become an attachment at all?
 *
 * A directory has no `blobId`, and a symlink's is the LINK, not the target — attaching either would
 * produce an empty part with a plausible name, which is worse than not offering it.
 */
export function isAttachableFile(node: FileNode): boolean {
  return node.nodeType === 'file' && node.blobId !== null
}

/**
 * A stored file → the draft attachment referencing the SAME blob. `null` for anything unattachable.
 *
 * `cid: null` — always a regular attachment, never an inline image. Picking a photo out of the
 * files area means "send this file"; an inline image is something you drop into the text, and the
 * body has no `<img>` waiting for a cid this dialog would have to invent.
 */
export function fileNodeAttachment(node: FileNode): DraftAttachment | null {
  if (!isAttachableFile(node) || node.blobId === null) return null
  return {
    blobId: node.blobId,
    name: node.name,
    type: node.type ?? FALLBACK_TYPE,
    size: node.size,
    cid: null,
  }
}

/** Why a chosen file could not be attached. */
export type FileAttachRefusal = 'tooLarge' | 'totalTooLarge'

export interface FileAttachPlan {
  /** In pick order, ready for `addAttachments`. */
  readonly attachments: readonly DraftAttachment[]
  /** Files left out, and why — the dialog names them rather than silently dropping them. */
  readonly refused: readonly { readonly name: string; readonly reason: FileAttachRefusal }[]
}

/**
 * Check a set of picked nodes against the account's size caps and split them accordingly.
 *
 * The SAME two checks an upload runs (`validateFile` / `validateTotal`), and running them matters
 * even though nothing is uploaded: `maxSizeAttachmentsPerEmail` is a limit on the MESSAGE, so a
 * 40 MB file already sitting in the account is exactly as unsendable as a 40 MB file on disk. The
 * running total carries each accepted file forward, so picking three 20 MB files stops at the one
 * that crosses the cap instead of accepting all three and failing at send.
 */
export function planFileAttachments(
  nodes: readonly FileNode[],
  existingBytes: number,
  limits: ValidationLimits,
): FileAttachPlan {
  const attachments: DraftAttachment[] = []
  const refused: { name: string; reason: FileAttachRefusal }[] = []
  let total = existingBytes
  for (const node of nodes) {
    const attachment = fileNodeAttachment(node)
    if (attachment === null) continue
    if (validateFile(attachment.size, limits) !== null) {
      refused.push({ name: node.name, reason: 'tooLarge' })
      continue
    }
    if (validateTotal(total, attachment.size, limits) !== null) {
      refused.push({ name: node.name, reason: 'totalTooLarge' })
      continue
    }
    total += attachment.size
    attachments.push(attachment)
  }
  return { attachments, refused }
}
