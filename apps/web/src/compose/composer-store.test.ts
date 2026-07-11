import { beforeEach, describe, expect, it } from 'vitest'
import type { UploadItem } from './attachment-upload'
import { MAX_OPEN, useComposerStore } from './composer-store'

const reset = (): void =>
  useComposerStore.setState({ drafts: new Map(), focusedId: undefined, uploads: new Map() })
const store = () => useComposerStore.getState()

const uploadItem = (over: Partial<UploadItem> = {}): UploadItem => ({
  tempId: 'u1',
  name: 'a.png',
  type: 'image/png',
  size: 10,
  inline: false,
  cid: null,
  previewUrl: null,
  status: 'uploading',
  progress: 0,
  error: null,
  ...over,
})

describe('composer store', () => {
  beforeEach(reset)

  it('opens a draft, returns a unique id, and focuses it', () => {
    const a = store().openDraft()
    const b = store().openDraft()
    expect(a).not.toBe(b)
    expect(store().drafts.size).toBe(2)
    expect(store().focusedId).toBe(b)
  })

  it('reopens under a fixed id idempotently (restore / open-from-Drafts): focuses, never duplicates', () => {
    const first = store().openDraft({ id: 'local-1', subject: 'Draft' })
    expect(first).toBe('local-1')
    store().openDraft() // an unrelated draft steals focus
    const again = store().openDraft({ id: 'local-1', subject: 'ignored on reopen' })
    expect(again).toBe('local-1')
    expect(store().drafts.size).toBe(2) // no duplicate row
    expect(store().focusedId).toBe('local-1') // reopen re-focuses it
    expect(store().drafts.get('local-1')?.subject).toBe('Draft') // existing content untouched
  })

  it('seeds a reply/forward draft with recipients, threading and attachments', () => {
    const id = store().openDraft({
      subject: 'Re: Hi',
      body: '<blockquote>x</blockquote>',
      to: [{ name: 'A', email: 'a@x.test' }],
      cc: [{ name: null, email: 'c@x.test' }],
      inReplyTo: ['<m1>'],
      references: ['<m0>', '<m1>'],
      fromIdentityHint: 'me@x.test',
      attachments: [{ blobId: 'b1', name: 'a.pdf', type: 'application/pdf', size: 3, cid: null }],
    })
    const draft = store().drafts.get(id)
    expect(draft?.to).toEqual([{ name: 'A', email: 'a@x.test' }])
    expect(draft?.cc).toHaveLength(1)
    expect(draft?.inReplyTo).toEqual(['<m1>'])
    expect(draft?.references).toEqual(['<m0>', '<m1>'])
    expect(draft?.fromIdentityHint).toBe('me@x.test')
    expect(draft?.attachments).toHaveLength(1)
    expect(draft?.dirty).toBe(false)
  })

  it('edits parallel drafts independently', () => {
    const a = store().openDraft()
    const b = store().openDraft()
    store().updateBody(a, '<p>A</p>')
    store().updateSubject(b, 'Hi B')
    expect(store().drafts.get(a)?.body).toBe('<p>A</p>')
    expect(store().drafts.get(a)?.subject).toBe('')
    expect(store().drafts.get(b)?.subject).toBe('Hi B')
    expect(store().drafts.get(a)?.dirty).toBe(true)
    expect(store().drafts.get(b)?.body).toBe('')
  })

  it('transitions mode docked → expanded → minimized', () => {
    const id = store().openDraft()
    store().setMode(id, 'expanded')
    expect(store().drafts.get(id)?.mode).toBe('expanded')
    store().setMode(id, 'minimized')
    expect(store().drafts.get(id)?.mode).toBe('minimized')
  })

  it('collapses the oldest open draft past MAX_OPEN without dropping any', () => {
    const ids = Array.from({ length: MAX_OPEN + 1 }, () => store().openDraft())
    expect(store().drafts.size).toBe(MAX_OPEN + 1) // nothing dropped
    const open = [...store().drafts.values()].filter((draft) => draft.mode !== 'minimized')
    expect(open).toHaveLength(MAX_OPEN)
    expect(store().drafts.get(ids[0] as string)?.mode).toBe('minimized')
  })

  it('closes only the target draft and refocuses a remaining one', () => {
    const a = store().openDraft()
    const b = store().openDraft()
    store().closeDraft(b)
    expect(store().drafts.has(b)).toBe(false)
    expect(store().drafts.has(a)).toBe(true)
    expect(store().focusedId).toBe(a)
  })

  it('setRecipients replaces a field and marks the draft dirty', () => {
    const id = store().openDraft()
    store().setRecipients(id, 'to', [{ name: null, email: 'a@x.com' }])
    expect(store().drafts.get(id)?.to).toEqual([{ name: null, email: 'a@x.com' }])
    expect(store().drafts.get(id)?.dirty).toBe(true)
  })

  it('moveRecipient moves one address between fields, deduping in the target', () => {
    const id = store().openDraft({
      to: [
        { name: null, email: 'a@x.com' },
        { name: null, email: 'b@x.com' },
      ],
      cc: [{ name: null, email: 'B@X.com' }],
    })
    store().moveRecipient(id, 'to', 'cc', 1)
    expect(store().drafts.get(id)?.to).toEqual([{ name: null, email: 'a@x.com' }])
    expect(store().drafts.get(id)?.cc).toEqual([{ name: null, email: 'B@X.com' }])
  })

  it('setFromIdentity sets the identity + body; markDirty:false leaves the draft clean (M2.5)', () => {
    const id = store().openDraft({ fromIdentityHint: 'me@x.test' })
    expect(store().drafts.get(id)?.fromIdentityId).toBeUndefined()
    store().setFromIdentity(id, 'id-1', '<p>seeded</p>', { markDirty: false })
    expect(store().drafts.get(id)?.fromIdentityId).toBe('id-1')
    expect(store().drafts.get(id)?.body).toBe('<p>seeded</p>')
    expect(store().drafts.get(id)?.dirty).toBe(false)
    store().setFromIdentity(id, 'id-2', '<p>swapped</p>')
    expect(store().drafts.get(id)?.fromIdentityId).toBe('id-2')
    expect(store().drafts.get(id)?.dirty).toBe(true)
  })

  it('adds attachments (deduped by blobId+cid) and marks dirty (M2.7)', () => {
    const id = store().openDraft()
    store().addAttachments(id, [{ blobId: 'b1', name: 'a', type: 'image/png', size: 1, cid: null }])
    store().addAttachments(id, [{ blobId: 'b1', name: 'a', type: 'image/png', size: 1, cid: null }]) // dup
    store().addAttachments(id, [{ blobId: 'b1', name: 'a', type: 'image/png', size: 1, cid: 'x' }]) // same blob, inline
    expect(store().drafts.get(id)?.attachments).toHaveLength(2)
    expect(store().drafts.get(id)?.dirty).toBe(true)
  })

  it('removes an attachment by blobId', () => {
    const id = store().openDraft()
    store().addAttachments(id, [
      { blobId: 'b1', name: 'a', type: 'x', size: 1, cid: null },
      { blobId: 'b2', name: 'b', type: 'x', size: 1, cid: null },
    ])
    store().removeAttachment(id, 'b1')
    expect(
      store()
        .drafts.get(id)
        ?.attachments.map((a) => a.blobId),
    ).toEqual(['b2'])
  })

  it('tracks in-flight uploads and patches / removes them', () => {
    const id = store().openDraft()
    store().addUpload(id, uploadItem({ tempId: 'u1' }))
    store().addUpload(id, uploadItem({ tempId: 'u2' }))
    store().patchUpload(id, 'u1', { status: 'error', error: { code: 'server' } })
    expect(
      store()
        .uploads.get(id)
        ?.find((u) => u.tempId === 'u1')?.status,
    ).toBe('error')
    store().removeUpload(id, 'u2')
    expect(
      store()
        .uploads.get(id)
        ?.map((u) => u.tempId),
    ).toEqual(['u1'])
  })

  it('keeps uploads across a minimize and clears them on close', () => {
    const id = store().openDraft()
    store().addUpload(id, uploadItem())
    store().setMode(id, 'minimized')
    expect(store().uploads.get(id)).toHaveLength(1) // survives the window remount
    store().closeDraft(id)
    expect(store().uploads.has(id)).toBe(false)
  })
})
