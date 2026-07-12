import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LabelPref } from '../mail/labels/label-model'
import type { ReplicaDb } from './db'
import { distinctKeywords, labelUnreadCounts, putEmails, updateLabels } from './repo'
import { email, freshDb } from './test-utils'

let db: ReplicaDb

beforeEach(() => {
  db = freshDb()
})
afterEach(async () => {
  await db.delete()
})

describe('updateLabels', () => {
  it('is a read-modify-write: the second call sees the first call’s result', async () => {
    await updateLabels(db, 'a', () => [{ keyword: 'x', name: 'X', color: 'red' }])
    await updateLabels(db, 'a', (current) => [
      ...current,
      { keyword: 'y', name: 'Y', color: 'blue' },
    ])
    const row = await db.localPrefs.get(['a', 'labels'])
    expect(row?.value).toEqual([
      { keyword: 'x', name: 'X', color: 'red' },
      { keyword: 'y', name: 'Y', color: 'blue' },
    ])
  })

  it('is account-scoped (writing one account leaves the other untouched)', async () => {
    await updateLabels(db, 'a', () => [{ keyword: 'x', name: 'X', color: 'red' }])
    await updateLabels(db, 'b', () => [{ keyword: 'z', name: 'Z', color: 'green' }])
    expect((await db.localPrefs.get(['a', 'labels']))?.value).toEqual([
      { keyword: 'x', name: 'X', color: 'red' },
    ] satisfies LabelPref[])
    expect((await db.localPrefs.get(['b', 'labels']))?.value).toEqual([
      { keyword: 'z', name: 'Z', color: 'green' },
    ] satisfies LabelPref[])
  })
})

describe('distinctKeywords', () => {
  it('returns the account’s distinct keywords from the akw index', async () => {
    await putEmails(db, 'a', [
      email('e1', { keywords: { work: true, $seen: true } }),
      email('e2', { keywords: { work: true, urgent: true } }),
    ])
    await putEmails(db, 'b', [email('e3', { keywords: { other: true } })])
    const keywords = await distinctKeywords(db, 'a')
    expect(new Set(keywords)).toEqual(new Set(['work', 'urgent', '$seen']))
    expect(keywords).not.toContain('other')
  })

  it('does not bleed between accounts whose ids share a string prefix', async () => {
    await putEmails(db, 'a', [email('e1', { keywords: { alpha: true } })])
    await putEmails(db, 'ab', [email('e2', { keywords: { beta: true } })])
    expect(await distinctKeywords(db, 'a')).toEqual(['alpha'])
    expect(await distinctKeywords(db, 'ab')).toEqual(['beta'])
  })
})

describe('labelUnreadCounts', () => {
  it('counts only unread ($seen-absent) carriers per keyword', async () => {
    await putEmails(db, 'a', [
      email('e1', { keywords: { work: true } }),
      email('e2', { keywords: { work: true, $seen: true } }),
      email('e3', { keywords: { play: true } }),
    ])
    const counts = await labelUnreadCounts(db, 'a', ['work', 'play', 'empty'])
    expect(counts.get('work')).toBe(1)
    expect(counts.get('play')).toBe(1)
    expect(counts.get('empty')).toBe(0)
  })
})
