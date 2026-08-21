/**
 * Attaching a stored file (D-5) — and the one assertion the whole finding rests on.
 *
 * The load-bearing test is "carries the NODE's blobId, not an uploaded one". If that were wrong the
 * feature would cost a download-plus-upload of every attached file; because it is right, attaching
 * is a synchronous mapping with no network at all. Measured against Stalwart v0.16.18: an
 * `Email/set create` whose `attachments[0].blobId` is a `FileNode.blobId` is CREATED, and the bytes
 * downloaded from the resulting message part hash identically to the file. See the module header.
 */

import type { FileNode } from '@waxwing/jmap'
import { describe, expect, it } from 'vitest'
import {
  canAttachFromFiles,
  fileNodeAttachment,
  isAttachableFile,
  planFileAttachments,
} from './attach-from-files'
import type { ValidationLimits } from './attachment-upload'

function node(over: Partial<FileNode> = {}): FileNode {
  return {
    id: 'n1',
    parentId: null,
    nodeType: 'file',
    // The shape a real one has: the node's own id, NOT the id the upload returned. Measured on the
    // fixture, upload `ea9xiqw0…be1yornibq` produced node blob `ca9xiqw0…bamae` — different ids.
    blobId: 'ca9xiqw0tx7podlkk9opjxltsjv3pp07irksgmcvtbnrzstr7aansbamae',
    target: null,
    size: 213,
    name: 'd5-probe.txt',
    type: 'text/plain',
    created: '2026-08-21T18:06:06Z',
    modified: '2026-08-21T18:06:06Z',
    accessed: '2026-08-21T18:06:06Z',
    changed: '2026-08-21T18:06:06Z',
    executable: false,
    isSubscribed: true,
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
    ...over,
  }
}

const LIMITS: ValidationLimits = { maxSizeUpload: 1000, maxSizeAttachmentsPerEmail: 1500 }

describe('fileNodeAttachment', () => {
  it('carries the NODE blobId straight onto the draft — no upload, no second copy', () => {
    // THE finding. The attachment references the file's own blob; nothing is transferred, which is
    // why this function is synchronous and works offline.
    const attachment = fileNodeAttachment(node())
    expect(attachment).toEqual({
      blobId: 'ca9xiqw0tx7podlkk9opjxltsjv3pp07irksgmcvtbnrzstr7aansbamae',
      name: 'd5-probe.txt',
      type: 'text/plain',
      size: 213,
      cid: null,
    })
  })

  it('is never inline: a picked file is an attachment, not an image dropped into the text', () => {
    expect(fileNodeAttachment(node({ type: 'image/png', name: 'photo.png' }))?.cid).toBeNull()
  })

  it('falls back to octet-stream where the node reports no media type', () => {
    expect(fileNodeAttachment(node({ type: null }))?.type).toBe('application/octet-stream')
  })

  it('refuses a directory and a symlink', () => {
    // A directory has no blob; a symlink's blob is the LINK. Both would attach an empty part with
    // a name that looks right, which is worse than not offering them.
    expect(fileNodeAttachment(node({ nodeType: 'directory', blobId: null }))).toBeNull()
    expect(fileNodeAttachment(node({ nodeType: 'symlink', target: '../x' }))).toBeNull()
    expect(isAttachableFile(node({ nodeType: 'directory', blobId: null }))).toBe(false)
    expect(isAttachableFile(node())).toBe(true)
  })
})

describe('planFileAttachments', () => {
  it('accepts what fits and names what does not', () => {
    const plan = planFileAttachments([node({ id: 'a', size: 400 })], 0, LIMITS)
    expect(plan.attachments).toHaveLength(1)
    expect(plan.refused).toEqual([])
  })

  it('applies the per-file cap even though nothing is uploaded', () => {
    // `maxSizeUpload` is about the transfer, but a file bigger than it is also a message part
    // bigger than the server will take — and the refusal has to happen here, where it can be named.
    const plan = planFileAttachments([node({ size: 5000, name: 'huge.bin' })], 0, LIMITS)
    expect(plan.attachments).toEqual([])
    expect(plan.refused).toEqual([{ name: 'huge.bin', reason: 'tooLarge' }])
  })

  it('counts what the draft ALREADY carries against the per-email cap', () => {
    const plan = planFileAttachments([node({ size: 800, name: 'late.txt' })], 900, LIMITS)
    expect(plan.attachments).toEqual([])
    expect(plan.refused).toEqual([{ name: 'late.txt', reason: 'totalTooLarge' }])
  })

  it('carries the running total forward, so a multi-pick stops at the one that crosses', () => {
    // The defect this prevents: checking each file against the cap in isolation accepts three
    // 800-byte files under a 1500-byte cap, and the send fails afterwards with nothing to point at.
    const plan = planFileAttachments(
      [
        node({ id: 'a', size: 800, name: 'a.txt' }),
        node({ id: 'b', size: 800, name: 'b.txt' }),
        node({ id: 'c', size: 100, name: 'c.txt' }),
      ],
      0,
      LIMITS,
    )
    expect(plan.attachments.map((a) => a.name)).toEqual(['a.txt', 'c.txt'])
    expect(plan.refused).toEqual([{ name: 'b.txt', reason: 'totalTooLarge' }])
  })

  it('never fails on an unlimited cap', () => {
    const plan = planFileAttachments([node({ size: 900 })], 1_000_000, {
      maxSizeUpload: 1000,
      maxSizeAttachmentsPerEmail: null,
    })
    expect(plan.attachments).toHaveLength(1)
  })

  it('silently skips folders rather than refusing them — they were never a choice', () => {
    const plan = planFileAttachments([node({ nodeType: 'directory', blobId: null })], 0, LIMITS)
    expect(plan.attachments).toEqual([])
    expect(plan.refused).toEqual([])
  })
})

describe('canAttachFromFiles', () => {
  const session = {
    accounts: { b: { accountCapabilities: { 'urn:ietf:params:jmap:filenode': {} } } },
  } as never

  it('is true only where the account advertises a file store', () => {
    expect(canAttachFromFiles(session, 'b')).toBe(true)
    expect(canAttachFromFiles(session, 'other')).toBe(false)
    expect(canAttachFromFiles(null, 'b')).toBe(false)
    expect(canAttachFromFiles(session, null)).toBe(false)
  })
})
