import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DraftRow, ReplicaDb, SerializedDraft } from './db'
import { deleteDraft, getDraft, getDraftByServerId, listDrafts, putDraft } from './repo'
import { freshDb } from './test-utils'

let db: ReplicaDb

beforeEach(() => {
  db = freshDb()
})

afterEach(async () => {
  await db.delete()
})

const content = (subject: string): SerializedDraft => ({
  to: [],
  cc: [],
  bcc: [],
  subject,
  body: '',
  inReplyTo: null,
  references: null,
  fromIdentityId: null,
  fromIdentityHint: null,
  attachments: [],
})

function row(over: Partial<DraftRow> & Pick<DraftRow, 'localId'>): DraftRow {
  return {
    accountId: 'a',
    serverEmailId: null,
    status: 'pending',
    content: content(over.localId),
    createdAt: 0,
    updatedAt: 0,
    lastError: null,
    ...over,
  }
}

describe('drafts repo', () => {
  it('round-trips a draft on its [accountId+localId] key', async () => {
    await putDraft(db, row({ localId: 'd1', updatedAt: 5 }))
    const got = await getDraft(db, 'a', 'd1')
    expect(got?.status).toBe('pending')
    expect(got?.content.subject).toBe('d1')
    expect(await getDraft(db, 'a', 'missing')).toBeUndefined()
  })

  it('scopes drafts by account', async () => {
    await putDraft(db, row({ localId: 'd1' }))
    await putDraft(db, row({ localId: 'd1', accountId: 'b' }))
    expect((await getDraft(db, 'a', 'd1'))?.accountId).toBe('a')
    expect(await listDrafts(db, 'b')).toHaveLength(1)
  })

  it('finds a draft by its server Email id (open-from-Drafts)', async () => {
    await putDraft(db, row({ localId: 'd1', serverEmailId: 'srv-1', status: 'synced' }))
    const got = await getDraftByServerId(db, 'a', 'srv-1')
    expect(got?.localId).toBe('d1')
    // A null serverEmailId is not addressable by this index (never collides across pending drafts).
    await putDraft(db, row({ localId: 'd2' }))
    expect(await getDraftByServerId(db, 'a', 'srv-missing')).toBeUndefined()
  })

  it('lists drafts most-recently-edited first', async () => {
    await putDraft(db, row({ localId: 'old', updatedAt: 1 }))
    await putDraft(db, row({ localId: 'new', updatedAt: 3 }))
    await putDraft(db, row({ localId: 'mid', updatedAt: 2 }))
    expect((await listDrafts(db, 'a')).map((d) => d.localId)).toEqual(['new', 'mid', 'old'])
  })

  it('deletes a draft', async () => {
    await putDraft(db, row({ localId: 'd1' }))
    await deleteDraft(db, 'a', 'd1')
    expect(await getDraft(db, 'a', 'd1')).toBeUndefined()
  })
})
