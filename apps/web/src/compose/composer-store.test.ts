import { beforeEach, describe, expect, it } from 'vitest'
import { MAX_OPEN, useComposerStore } from './composer-store'

const reset = (): void => useComposerStore.setState({ drafts: new Map(), focusedId: undefined })
const store = () => useComposerStore.getState()

describe('composer store', () => {
  beforeEach(reset)

  it('opens a draft, returns a unique id, and focuses it', () => {
    const a = store().openDraft()
    const b = store().openDraft()
    expect(a).not.toBe(b)
    expect(store().drafts.size).toBe(2)
    expect(store().focusedId).toBe(b)
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
})
