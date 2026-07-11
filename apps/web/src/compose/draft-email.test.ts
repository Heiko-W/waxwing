import { describe, expect, it } from 'vitest'
import type { DraftRow, EmailRow, SerializedDraft } from '../sync'
import { cleanOutgoingHtml } from './clean-html'
import type { DraftWindow } from './composer-store'
import {
  deserializeDraft,
  isEmptyDraft,
  serializeDraft,
  toDraftInit,
  toEmailCreate,
} from './draft-email'

function draftWindow(over: Partial<DraftWindow> = {}): DraftWindow {
  return {
    id: 'local-1',
    mode: 'docked',
    to: [],
    cc: [],
    bcc: [],
    subject: '',
    body: '',
    inReplyTo: null,
    references: null,
    fromIdentityHint: undefined,
    fromIdentityId: undefined,
    attachments: [],
    sourceEmailId: undefined,
    sourceFlag: undefined,
    dirty: false,
    createdAt: 0,
    ...over,
  }
}

function draftRow(content: SerializedDraft, over: Partial<DraftRow> = {}): DraftRow {
  return {
    accountId: 'a',
    localId: 'local-1',
    serverEmailId: null,
    status: 'pending',
    content,
    createdAt: 0,
    updatedAt: 0,
    lastError: null,
    ...over,
  }
}

describe('serializeDraft / deserializeDraft', () => {
  it('round-trips every persisted field and reopens under the same localId', () => {
    const draft = draftWindow({
      to: [{ name: 'A', email: 'a@x.test' }],
      cc: [{ name: null, email: 'c@x.test' }],
      bcc: [{ name: 'B', email: 'b@x.test' }],
      subject: 'Hello',
      body: '<p>hi</p>',
      inReplyTo: ['<m1>'],
      references: ['<m0>', '<m1>'],
      fromIdentityId: 'id-7',
      fromIdentityHint: 'me@x.test',
      attachments: [{ blobId: 'b1', name: 'a.pdf', type: 'application/pdf', size: 3, cid: null }],
    })
    const serialized = serializeDraft(draft)
    const init = deserializeDraft(draftRow(serialized, { localId: 'local-9' }))

    expect(init.id).toBe('local-9')
    expect(init.to).toEqual(draft.to)
    expect(init.cc).toEqual(draft.cc)
    expect(init.bcc).toEqual(draft.bcc) // bcc survives the local round-trip (not on the envelope)
    expect(init.subject).toBe('Hello')
    expect(init.body).toBe('<p>hi</p>')
    expect(init.inReplyTo).toEqual(['<m1>'])
    expect(init.references).toEqual(['<m0>', '<m1>'])
    expect(init.fromIdentityId).toBe('id-7')
    expect(init.fromIdentityHint).toBe('me@x.test')
    expect(init.attachments).toEqual(draft.attachments)
  })

  it('maps an unset From identity to null on serialize and back to undefined on deserialize', () => {
    const serialized = serializeDraft(draftWindow())
    expect(serialized.fromIdentityId).toBeNull()
    expect(serialized.fromIdentityHint).toBeNull()
    const init = deserializeDraft(draftRow(serialized))
    expect(init.fromIdentityId).toBeUndefined()
    expect(init.fromIdentityHint).toBeUndefined()
  })
})

describe('isEmptyDraft', () => {
  it('is empty with no recipients, blank subject and no body text', () => {
    expect(isEmptyDraft(draftWindow())).toBe(true)
    expect(isEmptyDraft(draftWindow({ body: '<p><br></p>' }))).toBe(true)
    expect(isEmptyDraft(draftWindow({ subject: '   ' }))).toBe(true)
  })

  it('is non-empty when any recipient, the subject or the body carries content', () => {
    expect(isEmptyDraft(draftWindow({ to: [{ name: null, email: 'a@x.test' }] }))).toBe(false)
    expect(isEmptyDraft(draftWindow({ bcc: [{ name: null, email: 'b@x.test' }] }))).toBe(false)
    expect(isEmptyDraft(draftWindow({ subject: 'Hi' }))).toBe(false)
    expect(isEmptyDraft(draftWindow({ body: '<p>text</p>' }))).toBe(false)
  })

  it('accepts a SerializedDraft too', () => {
    expect(isEmptyDraft(serializeDraft(draftWindow()))).toBe(true)
    expect(isEmptyDraft(serializeDraft(draftWindow({ subject: 'Hi' })))).toBe(false)
  })
})

describe('toEmailCreate', () => {
  const draft = serializeDraft(
    draftWindow({
      to: [{ name: 'A', email: 'a@x.test' }],
      cc: [{ name: null, email: 'c@x.test' }],
      bcc: [{ name: null, email: 'b@x.test' }],
      subject: 'Hello',
      body: '<p>hi</p><script>alert(1)</script>',
      inReplyTo: ['<m1>'],
      references: ['<m0>'],
    }),
  )

  it('targets the Drafts mailbox with the $draft/$seen keywords', () => {
    const email = toEmailCreate({ draft, draftsMailboxId: 'mb-drafts', from: null })
    expect(email.mailboxIds).toEqual({ 'mb-drafts': true })
    expect(email.keywords).toEqual({ $draft: true, $seen: true })
    expect(email.from).toBeNull()
  })

  it('carries the From identity address when resolved', () => {
    const from = { name: 'Me', email: 'me@x.test' }
    const email = toEmailCreate({ draft, draftsMailboxId: 'mb-drafts', from })
    expect(email.from).toEqual([from])
  })

  it('sanitizes the outgoing body and mirrors the recipients/threading', () => {
    const email = toEmailCreate({ draft, draftsMailboxId: 'mb-drafts', from: null })
    expect(email.htmlBody).toEqual([{ partId: 'html', type: 'text/html' }])
    expect(email.bodyValues?.html?.value).toBe(cleanOutgoingHtml(draft.body))
    expect(email.to).toEqual(draft.to)
    expect(email.cc).toEqual(draft.cc)
    expect(email.bcc).toEqual(draft.bcc)
    expect(email.inReplyTo).toEqual(['<m1>'])
    expect(email.references).toEqual(['<m0>'])
  })
})

describe('toEmailCreate — attachments (M2.7)', () => {
  it('maps regular attachments + referenced inline images, pruning an orphaned inline', () => {
    const draft = serializeDraft(
      draftWindow({
        body: '<p><img src="cid:inline-1"></p>',
        attachments: [
          { blobId: 'b1', name: 'a.pdf', type: 'application/pdf', size: 10, cid: null },
          { blobId: 'b2', name: 'img.png', type: 'image/png', size: 20, cid: 'inline-1' },
          { blobId: 'b3', name: 'gone.png', type: 'image/png', size: 5, cid: 'orphan' },
        ],
      }),
    )
    const email = toEmailCreate({ draft, draftsMailboxId: 'mb', from: null })
    expect(email.attachments).toEqual([
      { blobId: 'b1', type: 'application/pdf', name: 'a.pdf', size: 10, disposition: 'attachment' },
      {
        blobId: 'b2',
        type: 'image/png',
        name: 'img.png',
        size: 20,
        cid: 'inline-1',
        disposition: 'inline',
      },
    ])
  })

  it('omits the attachments key when there are none', () => {
    const email = toEmailCreate({
      draft: serializeDraft(draftWindow()),
      draftsMailboxId: 'mb',
      from: null,
    })
    expect(email.attachments).toBeUndefined()
  })

  it('strips a body cid: reference with no backing attachment (upload in flight / errored)', () => {
    const draft = serializeDraft(
      draftWindow({ body: '<p><img src="cid:pending-1">text</p>', attachments: [] }),
    )
    const email = toEmailCreate({ draft, draftsMailboxId: 'mb', from: null })
    expect(email.bodyValues?.html?.value).toBe('<p>text</p>') // dangling inline img removed
    expect(email.attachments).toBeUndefined()
  })
})

describe('toDraftInit', () => {
  it('seeds an init from a synced envelope + fetched body (no bcc on the envelope)', () => {
    const email = {
      to: [{ name: 'A', email: 'a@x.test' }],
      cc: [{ name: null, email: 'c@x.test' }],
      subject: 'Re: Hi',
      inReplyTo: ['<m1>'],
      references: ['<m0>'],
    } as unknown as EmailRow
    const init = toDraftInit(email, '<p>body</p>')
    expect(init.to).toEqual(email.to)
    expect(init.cc).toEqual(email.cc)
    expect(init.subject).toBe('Re: Hi')
    expect(init.body).toBe('<p>body</p>')
    expect(init.inReplyTo).toEqual(['<m1>'])
    expect(init.references).toEqual(['<m0>'])
    expect(init.bcc).toBeUndefined()
  })
})
