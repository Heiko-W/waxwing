import { renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { putIdentities, putMailboxes, type ReplicaDb, ReplicaProvider } from '../sync'
import { setActiveEngine } from '../sync/engine'
import { freshDb, mailbox } from '../sync/test-utils'
import { useComposerStore } from './composer-store'
import { useDraftSync } from './use-draft-sync'

let db: ReplicaDb
const dispatch = vi.fn()
const cancelSend = vi.fn(async () => true)

beforeEach(async () => {
  db = freshDb()
  dispatch.mockReset()
  cancelSend.mockClear()
  setActiveEngine({ dispatch, cancelSend } as unknown as Parameters<typeof setActiveEngine>[0])
  useComposerStore.setState({ drafts: new Map(), focusedId: undefined, uploads: new Map() })
  await putMailboxes(db, 'a', [
    mailbox('mb-d', { role: 'drafts' }),
    mailbox('mb-s', { role: 'sent' }),
  ])
  await putIdentities(db, 'a', [
    {
      id: 'id1',
      name: 'Me',
      email: 'me@x.test',
      replyTo: null,
      bcc: null,
      textSignature: '',
      htmlSignature: '',
      mayDelete: true,
    },
  ])
})

afterEach(async () => {
  setActiveEngine(null)
  await db.delete()
})

function wrapper({ children }: { children: ReactNode }) {
  return (
    <ReplicaProvider accountId="a" db={db}>
      {children}
    </ReplicaProvider>
  )
}

const open = (init: Parameters<ReturnType<typeof useComposerStore.getState>['openDraft']>[0]) =>
  useComposerStore.getState().openDraft(init)

describe('useDraftSync.send (M2.8)', () => {
  it('dispatches a sendEmail intent with envelope + onSuccessUpdateEmail + notBefore', async () => {
    const id = open({
      to: [{ name: null, email: 'a@x.test' }],
      cc: [{ name: null, email: 'A@x.test' }], // duplicate of `to` (different case)
      subject: 'Hi',
      body: '<p>hi</p>',
      fromIdentityId: 'id1',
      sourceEmailId: 'src-9',
      sourceFlag: '$answered',
    })
    const { result } = renderHook(() => useDraftSync(), { wrapper })

    const res = await result.current.send(id, { undoMs: 15000 })

    expect(res).toEqual({ ok: true, undoMs: 15000 })
    expect((await db.drafts.get(['a', id]))?.status).toBe('sending')
    const call = dispatch.mock.calls[0] as [Record<string, unknown>, Record<string, unknown>]
    const intent = call[0] as {
      kind: string
      identityId: string
      envelope: { mailFrom: unknown; rcptTo: unknown }
      onSuccessUpdateEmail: unknown
      source: unknown
    }
    expect(intent.kind).toBe('sendEmail')
    expect(intent.identityId).toBe('id1')
    expect(intent.envelope.mailFrom).toEqual({ email: 'me@x.test' })
    expect(intent.envelope.rcptTo).toEqual([{ email: 'a@x.test' }]) // deduped across to+cc
    expect(intent.onSuccessUpdateEmail).toEqual({
      'mailboxIds/mb-d': null,
      'mailboxIds/mb-s': true,
      'keywords/$draft': null,
      'keywords/$seen': true,
    })
    expect(intent.source).toEqual({ emailId: 'src-9', keyword: '$answered' })
    expect(call[1].id).toBe(`send:${id}`) // a DISTINCT id from autosave's `draft:<id>`
    expect(typeof call[1].notBefore).toBe('number')
  })

  it('cancels a queued autosave (deletes the draft:<id> outbox row) before dispatching the send', async () => {
    const id = open({
      to: [{ name: null, email: 'a@x.test' }],
      fromIdentityId: 'id1',
      subject: 'Hi',
    })
    // Simulate a pending autosave row already queued for this draft.
    await db.outbox.put({
      accountId: 'a',
      id: `draft:${id}`,
      type: 'saveDraft',
      payload: {},
      ifInState: null,
      status: 'pending',
      attempts: 0,
      createdAt: 1,
      lastError: null,
      notBefore: null,
    })
    const { result } = renderHook(() => useDraftSync(), { wrapper })

    await result.current.send(id, { undoMs: 0 })

    expect(await db.outbox.get(['a', `draft:${id}`])).toBeUndefined() // autosave cancelled
    expect((dispatch.mock.calls[0]?.[1] as { id: string }).id).toBe(`send:${id}`)
  })

  it('refuses to send with no recipients or no identity', async () => {
    const { result } = renderHook(() => useDraftSync(), { wrapper })
    const noRcpt = open({ fromIdentityId: 'id1', subject: 'x' })
    expect(await result.current.send(noRcpt, { undoMs: 0 })).toEqual({
      ok: false,
      reason: 'noRecipients',
    })
    const noId = open({ to: [{ name: null, email: 'a@x.test' }] })
    expect(await result.current.send(noId, { undoMs: 0 })).toEqual({
      ok: false,
      reason: 'noIdentity',
    })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('undoSend cancels the queued send and reopens the draft', async () => {
    const id = open({
      to: [{ name: null, email: 'a@x.test' }],
      fromIdentityId: 'id1',
      subject: 'Hi',
    })
    const { result } = renderHook(() => useDraftSync(), { wrapper })
    await result.current.send(id, { undoMs: 15000 })
    useComposerStore.getState().closeDraft(id) // the window closes on send

    await result.current.undoSend(id)

    expect(cancelSend).toHaveBeenCalledWith(`send:${id}`)
    expect(useComposerStore.getState().drafts.has(id)).toBe(true) // reopened for editing
  })
})
