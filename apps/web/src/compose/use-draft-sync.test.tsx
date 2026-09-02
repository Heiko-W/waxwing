import { renderHook } from '@testing-library/react'
import type { ComponentProps, ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionContext } from '../app/session/context'
import { putIdentities, putMailboxes, type ReplicaDb, ReplicaProvider } from '../sync'
import { setActiveEngine } from '../sync/engine'
import { freshDb, mailbox } from '../sync/test-utils'
import { useComposerStore } from './composer-store'
import { applySignature } from './signature'
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

  it('refuses to send (engineUnavailable) when no engine runs, leaving the draft untouched', async () => {
    setActiveEngine(null) // e.g. a browser without Web Locks / BroadcastChannel
    const id = open({
      to: [{ name: null, email: 'a@x.test' }],
      fromIdentityId: 'id1',
      subject: 'Hi',
    })
    const { result } = renderHook(() => useDraftSync(), { wrapper })

    const res = await result.current.send(id, { undoMs: 10000 })

    expect(res).toEqual({ ok: false, reason: 'engineUnavailable' })
    // Must NOT mark the draft `sending` (restore skips those) — that would be a silent send loss.
    expect(await db.drafts.get(['a', id])).toBeUndefined()
    expect(dispatch).not.toHaveBeenCalled()
  })

  /**
   * The failure that used to be invisible. `dispatch` was fire-and-forget, so a rejecting
   * `enqueueAction` — a `QuotaExceededError` on the put that carries the whole body is the
   * realistic one — left the draft row durably `sending` (which `use-draft-restore` skips), this
   * returned `{ok: true}`, and `ComposerWindow` closed the window. No outbox row, no queued-sends
   * chip, no dead letter, nothing to reopen: the user saw "Sending…" and the mail existed nowhere.
   */
  it('reports a failed enqueue instead of claiming the message was sent', async () => {
    dispatch.mockRejectedValueOnce(new DOMException('quota', 'QuotaExceededError'))
    const id = open({
      to: [{ name: null, email: 'a@x.test' }],
      fromIdentityId: 'id1',
      subject: 'Hi',
    })
    const { result } = renderHook(() => useDraftSync(), { wrapper })

    const res = await result.current.send(id, { undoMs: 10000 })

    expect(res).toEqual({ ok: false, reason: 'queueFailed' })
    // And the row is one the composer can restore and the user can retry, not a stranded `sending`.
    const row = await db.drafts.get(['a', id])
    expect(row?.status).toBe('error')
    expect(row?.errorKind).toBe('send')
    expect(row?.lastError).toContain('quota')
  })

  it("applies the identity's replyTo + auto-bcc to the email and the SMTP envelope", async () => {
    await putIdentities(db, 'a', [
      {
        id: 'id2',
        name: 'Me2',
        email: 'me2@x.test',
        replyTo: [{ name: null, email: 'reply@x.test' }],
        bcc: [{ name: null, email: 'archive@x.test' }],
        textSignature: '',
        htmlSignature: '',
        mayDelete: true,
      },
    ])
    const id = open({
      to: [{ name: null, email: 'a@x.test' }],
      fromIdentityId: 'id2',
      subject: 'Hi',
    })
    const { result } = renderHook(() => useDraftSync(), { wrapper })

    await result.current.send(id, { undoMs: 0 })

    const intent = dispatch.mock.calls[0]?.[0] as {
      email: { replyTo: unknown; bcc: unknown }
      envelope: { rcptTo: unknown }
    }
    expect(intent.email.replyTo).toEqual([{ name: null, email: 'reply@x.test' }])
    expect(intent.email.bcc).toEqual([{ name: null, email: 'archive@x.test' }])
    expect(intent.envelope.rcptTo).toEqual([{ email: 'a@x.test' }, { email: 'archive@x.test' }])
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

/**
 * Send options on the wire (M-7, M-11).
 *
 * The envelope is where a delivery receipt and a TLS requirement actually live, and it is the one
 * place a unit test can see them before a server does. `sessionWrapper` adds what the plain
 * `wrapper` deliberately lacks — a connected session advertising the extensions — because the whole
 * gate under test is "only send what the account said it accepts".
 */
function sessionWrapper(submissionExtensions: Record<string, unknown> | null) {
  const session = {
    connected: {
      accountId: 'a',
      jmapSession: {
        accounts: {
          a: {
            accountCapabilities:
              submissionExtensions === null
                ? {}
                : { 'urn:ietf:params:jmap:submission': { submissionExtensions } },
          },
        },
      },
    },
  } as unknown as ComponentProps<typeof SessionContext.Provider>['value']
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <SessionContext.Provider value={session}>
        <ReplicaProvider accountId="a" db={db}>
          {children}
        </ReplicaProvider>
      </SessionContext.Provider>
    )
  }
}

/** Exactly what the fixture advertises. */
const FIXTURE_EXTENSIONS = {
  FUTURERELEASE: [],
  SIZE: [],
  DSN: [],
  DELIVERYBY: [],
  'MT-PRIORITY': ['MIXER'],
  REQUIRETLS: [],
}

const sentIntent = () =>
  dispatch.mock.calls[0]?.[0] as {
    email: Record<string, unknown>
    envelope: {
      mailFrom: { email: string; parameters?: Record<string, string | null> }
      rcptTo: { email: string; parameters?: Record<string, string | null> }[]
    }
  }

describe('useDraftSync.send — send options (M-7, M-11)', () => {
  it('asks for a delivery receipt PER RECIPIENT, and for headers-only in the report', async () => {
    const id = open({
      to: [{ name: null, email: 'a@x.test' }],
      cc: [{ name: null, email: 'b@x.test' }],
      fromIdentityId: 'id1',
      subject: 'Hi',
      sendOptions: { priority: 'normal', deliveryReceipt: true, requireTls: false },
    })
    const { result } = renderHook(() => useDraftSync(), {
      wrapper: sessionWrapper(FIXTURE_EXTENSIONS),
    })

    await result.current.send(id, { undoMs: 0 })

    const { envelope } = sentIntent()
    expect(envelope.mailFrom.parameters).toEqual({ RET: 'HDRS' })
    // NOTIFY/ORCPT are per-RCPT in SMTP — that is what lets a report name WHICH address failed.
    expect(envelope.rcptTo).toEqual([
      {
        email: 'a@x.test',
        parameters: { NOTIFY: 'SUCCESS,DELAY,FAILURE', ORCPT: 'rfc822;a@x.test' },
      },
      {
        email: 'b@x.test',
        parameters: { NOTIFY: 'SUCCESS,DELAY,FAILURE', ORCPT: 'rfc822;b@x.test' },
      },
    ])
  })

  it('writes priority as MESSAGE headers and, where advertised, MT-PRIORITY too', async () => {
    const id = open({
      to: [{ name: null, email: 'a@x.test' }],
      fromIdentityId: 'id1',
      subject: 'Hi',
      sendOptions: { priority: 'high', deliveryReceipt: false, requireTls: false },
    })
    const { result } = renderHook(() => useDraftSync(), {
      wrapper: sessionWrapper(FIXTURE_EXTENSIONS),
    })

    await result.current.send(id, { undoMs: 0 })

    const intent = sentIntent()
    // The headers are the part the RECIPIENT sees; MT-PRIORITY only orders the sending queue.
    expect(intent.email['header:X-Priority:asText']).toBe('1')
    expect(intent.email['header:Importance:asText']).toBe('high')
    expect(intent.envelope.mailFrom.parameters).toEqual({ 'MT-PRIORITY': '4' })
  })

  it('merges the scheduling parameter with the options rather than choosing between them', async () => {
    const id = open({
      to: [{ name: null, email: 'a@x.test' }],
      fromIdentityId: 'id1',
      subject: 'Hi',
      sendOptions: { priority: 'normal', deliveryReceipt: true, requireTls: true },
    })
    const { result } = renderHook(() => useDraftSync(), {
      wrapper: sessionWrapper(FIXTURE_EXTENSIONS),
    })

    await result.current.send(id, { undoMs: 0, scheduleAt: new Date('2026-09-01T08:00:00.000Z') })

    // An envelope carries all of its parameters or none — scheduling a receipted message is an
    // ordinary thing to want, and dropping either half would be a silent broken promise.
    expect(sentIntent().envelope.mailFrom.parameters).toEqual({
      HOLDUNTIL: '2026-09-01T08:00:00.000Z',
      RET: 'HDRS',
      REQUIRETLS: null,
    })
  })

  it('sends NO envelope parameters where the account advertises no extensions', async () => {
    const id = open({
      to: [{ name: null, email: 'a@x.test' }],
      fromIdentityId: 'id1',
      subject: 'Hi',
      sendOptions: { priority: 'high', deliveryReceipt: true, requireTls: true },
    })
    const { result } = renderHook(() => useDraftSync(), { wrapper: sessionWrapper(null) })

    await result.current.send(id, { undoMs: 0 })

    const intent = sentIntent()
    // Byte-for-byte the envelope this app sent before M-7 existed. A parameter the server would
    // reject must never reach it — that turns an unavailable feature into a failed send.
    expect(intent.envelope.mailFrom).toEqual({ email: 'me@x.test' })
    expect(intent.envelope.rcptTo).toEqual([{ email: 'a@x.test' }])
    // Priority still travels: headers need no extension at all.
    expect(intent.email['header:X-Priority:asText']).toBe('1')
  })

  it("lets the draft's own Reply-To beat the identity's", async () => {
    await putIdentities(db, 'a', [
      {
        id: 'id3',
        name: 'Me3',
        email: 'me3@x.test',
        replyTo: [{ name: null, email: 'always@x.test' }],
        bcc: null,
        textSignature: '',
        htmlSignature: '',
        mayDelete: true,
      },
    ])
    const id = open({
      to: [{ name: null, email: 'a@x.test' }],
      replyTo: [{ name: null, email: 'this-once@x.test' }],
      fromIdentityId: 'id3',
      subject: 'Hi',
    })
    const { result } = renderHook(() => useDraftSync(), { wrapper })

    await result.current.send(id, { undoMs: 0 })

    // An identity-wide Reply-To answers "always"; the field in this window answers "this once", and
    // the more specific answer is the one the writer just gave.
    expect(sentIntent().email.replyTo).toEqual([{ name: null, email: 'this-once@x.test' }])
    // And it is NOT a recipient — nothing was added to the SMTP envelope.
    expect(sentIntent().envelope.rcptTo).toEqual([{ email: 'a@x.test' }])
  })
})

/**
 * What happens to the coalesced `draft:<id>` autosave row when the user acts on the draft while it
 * is queued or on the wire (R-25, R-29).
 *
 * `pending` and `inflight` need OPPOSITE treatment, and conflating them is how a discarded draft
 * ends up on the server: a pending save is still stoppable, an in-flight one is not, and deleting
 * the latter only removes the record that the request it is executing ever existed.
 */
describe('useDraftSync — the queued autosave row (R-25, R-29)', () => {
  function queuedSave(localId: string, status: 'pending' | 'inflight') {
    return db.outbox.put({
      accountId: 'a',
      id: `draft:${localId}`,
      type: 'saveDraft',
      payload: { kind: 'saveDraft', localId, creationId: `draft-${localId}`, priorServerId: null },
      ifInState: null,
      status,
      attempts: 0,
      createdAt: 1,
      lastError: null,
      notBefore: null,
    })
  }

  it('discard cancels a pending save of a draft that has no server copy yet', async () => {
    const id = open({ subject: 'never mind' })
    await queuedSave(id, 'pending')
    const { result } = renderHook(() => useDraftSync(), { wrapper })

    await result.current.discard(id)

    // Offline / mid-backoff this row IS the draft: replaying it would create on the server exactly
    // the message the user just threw away, with nothing queued to take it back.
    expect(await db.outbox.get(['a', `draft:${id}`])).toBeUndefined()
    expect(dispatch).not.toHaveBeenCalled()
    expect(useComposerStore.getState().drafts.has(id)).toBe(false)
  })

  it('discard leaves an in-flight save alone (its reconcile queues the destroy)', async () => {
    const id = open({ subject: 'never mind' })
    await queuedSave(id, 'inflight')
    const { result } = renderHook(() => useDraftSync(), { wrapper })

    await result.current.discard(id)

    expect((await db.outbox.get(['a', `draft:${id}`]))?.status).toBe('inflight')
  })

  it('send leaves an in-flight save alone rather than losing track of the draft it creates', async () => {
    const id = open({
      to: [{ name: null, email: 'a@x.test' }],
      fromIdentityId: 'id1',
      subject: 'Hi',
    })
    await queuedSave(id, 'inflight')
    const { result } = renderHook(() => useDraftSync(), { wrapper })

    await result.current.send(id, { undoMs: 0 })

    expect((await db.outbox.get(['a', `draft:${id}`]))?.status).toBe('inflight')
    expect((dispatch.mock.calls[0]?.[1] as { id: string }).id).toBe(`send:${id}`)
  })
})

/**
 * What `flush`/`close` do with a draft that has NOTHING in it — the three-way answer (R-12, R-15).
 */
describe('useDraftSync.flush — an empty or unchanged draft (R-12, R-15)', () => {
  const signature = applySignature('', '<div>-- <br>Heiko</div>')

  it('does not save a draft whose only body is the seeded signature', async () => {
    const id = open({})
    // Exactly what `FromField` does once the identities load: seed the signature, NOT an edit.
    useComposerStore.getState().setFromIdentity(id, 'id1', signature, { markDirty: false })
    const { result } = renderHook(() => useDraftSync(), { wrapper })

    await result.current.close(id)

    expect(await db.drafts.get(['a', id])).toBeUndefined()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('deletes the local row and destroys the server copy when a saved draft is emptied', async () => {
    const id = open({ subject: 'Hallo' })
    const { result } = renderHook(() => useDraftSync(), { wrapper })
    await result.current.flush(id)
    // The server acknowledges the save, as the engine's reconcile would.
    await db.drafts.update(['a', id], { serverEmailId: 'srv-1', status: 'synced' })
    dispatch.mockClear()

    useComposerStore.getState().updateSubject(id, '')
    await result.current.close(id)

    // Neither the local row nor the server copy may keep the text the writer took back.
    expect(await db.drafts.get(['a', id])).toBeUndefined()
    const intent = dispatch.mock.calls[0]?.[0] as { kind: string; serverEmailId: string }
    expect(intent.kind).toBe('discardDraft')
    expect(intent.serverEmailId).toBe('srv-1')
  })

  it('saves a draft whose only content is an attachment', async () => {
    const id = open({ subject: '' })
    useComposerStore
      .getState()
      .addAttachments(id, [
        { blobId: 'b1', name: 'a.pdf', type: 'application/pdf', size: 20, cid: null },
      ])
    const { result } = renderHook(() => useDraftSync(), { wrapper })

    await result.current.close(id)

    expect((await db.drafts.get(['a', id]))?.content.attachments).toHaveLength(1)
    expect((dispatch.mock.calls[0]?.[0] as { kind: string }).kind).toBe('saveDraft')
  })

  it('skips the server save when nothing changed since the server acknowledged it', async () => {
    const id = open({ subject: 'Hallo' })
    const { result } = renderHook(() => useDraftSync(), { wrapper })
    await result.current.flush(id)
    await db.drafts.update(['a', id], { serverEmailId: 'srv-1', status: 'synced' })
    dispatch.mockClear()

    // Minimizing and restoring changes the store but not the message.
    useComposerStore.getState().setMode(id, 'minimized')
    useComposerStore.getState().setMode(id, 'docked')
    await result.current.flush(id)

    expect(dispatch).not.toHaveBeenCalled()
    expect((await db.drafts.get(['a', id]))?.status).toBe('synced')

    // …and a real edit still goes out.
    useComposerStore.getState().updateSubject(id, 'Hallo!')
    await result.current.flush(id)
    expect((dispatch.mock.calls[0]?.[0] as { kind: string }).kind).toBe('saveDraft')
  })
})
