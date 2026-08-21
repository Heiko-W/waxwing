import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type AccountRecord,
  clearAccount,
  ReplicaDb,
  scopeKey,
  toContactCardRow,
  toEmailRow,
  toMailboxRow,
  toThreadRow,
  wipeReplica,
} from './db'
import { contactCardsInBook, emailsInMailbox } from './repo'
import { addressBook, contactCard, email, freshDb, mailbox, thread } from './test-utils'

let db: ReplicaDb

beforeEach(() => {
  db = freshDb()
})

afterEach(async () => {
  await db.delete()
})

function account(id: string): AccountRecord {
  return {
    id,
    username: `${id}@waxwing.test`,
    name: id,
    issuer: null,
    isPrimary: true,
    addedAt: 1,
    lastSeenAt: 1,
  }
}

describe('ReplicaDb schema', () => {
  it('declares all replica tables', () => {
    const names = db.tables.map((table) => table.name).sort()
    expect(names).toEqual(
      [
        'accounts',
        'addressBooks',
        'addressStats',
        'blobsMeta',
        'calendarEvents',
        'calendarQueryCache',
        'calendars',
        'contactCards',
        'contactQueryCache',
        'drafts',
        'emailBodies',
        'emails',
        'identities',
        'localPrefs',
        'mailboxes',
        'outbox',
        'queryCache',
        'syncState',
        'threads',
      ].sort(),
    )
  })

  it('is at schema version 7 (the calendar migration is appended, v1–v6 untouched)', () => {
    // If this drops below 7, a later `.version()` was renumbered or the append-only chain was
    // rewritten — exactly what the migration policy forbids.
    expect(db.verno).toBe(7)
  })

  it('round-trips a mailbox on its compound key', async () => {
    await db.mailboxes.put(toMailboxRow('a', mailbox('mb1', { role: 'inbox' })))
    const got = await db.mailboxes.get(['a', 'mb1'])
    expect(got?.role).toBe('inbox')
    expect(got?.accountId).toBe('a')
  })

  it('round-trips a thread', async () => {
    await db.threads.put(toThreadRow('a', thread('t1', ['e1', 'e2'])))
    const got = await db.threads.get(['a', 't1'])
    expect(got?.emailIds).toEqual(['e1', 'e2'])
  })
})

describe('scopeKey', () => {
  it('pins the account-scoped NUL-separated membership format', () => {
    // The exact serialized shape the amb/akw multiEntry indexes and M1.3 depend on.
    expect(scopeKey('acc', 'inbox')).toBe('acc\u0000inbox')
  })
})

describe('toEmailRow', () => {
  it('derives account-scoped membership arrays from mailboxIds and keywords', () => {
    const row = toEmailRow(
      'acc',
      email('e1', { mailboxIds: { inbox: true, arch: true }, keywords: { $seen: true } }),
    )
    // Literal expected values (not scopeKey on both sides) so the stored format itself is pinned.
    expect(row.amb.sort()).toEqual(['acc\u0000arch', 'acc\u0000inbox'])
    expect(row.akw).toEqual(['acc\u0000$seen'])
  })
})

describe('account scoping', () => {
  it('keeps identical ids in different accounts isolated', async () => {
    await db.emails.bulkPut([
      toEmailRow('a', email('shared', { mailboxIds: { inbox: true } })),
      toEmailRow('b', email('shared', { mailboxIds: { inbox: true } })),
    ])

    const inA = await emailsInMailbox(db, 'a', 'inbox')
    const inB = await emailsInMailbox(db, 'b', 'inbox')

    expect(inA.map((row) => row.accountId)).toEqual(['a'])
    expect(inB.map((row) => row.accountId)).toEqual(['b'])
    expect(await db.emails.count()).toBe(2)
  })

  it('clearAccount removes only the target account across every table', async () => {
    for (const acc of ['a', 'b']) {
      await db.accounts.put(account(acc))
      await db.mailboxes.put(toMailboxRow(acc, mailbox('inbox', { role: 'inbox' })))
      await db.emails.put(toEmailRow(acc, email('e1')))
      await db.localPrefs.put({ accountId: acc, key: 'k', value: 1 })
    }

    await clearAccount(db, 'a')

    expect(await db.accounts.get('a')).toBeUndefined()
    expect(await db.emails.where('accountId').equals('a').count()).toBe(0)
    expect(await db.mailboxes.where('accountId').equals('a').count()).toBe(0)
    expect(await db.localPrefs.where('accountId').equals('a').count()).toBe(0)
    // Account b is untouched.
    expect(await db.accounts.get('b')).toBeDefined()
    expect(await db.emails.where('accountId').equals('b').count()).toBe(1)
  })

  it('keeps identical contact-card ids in different accounts isolated', async () => {
    await db.contactCards.bulkPut([
      toContactCardRow('a', contactCard('shared', { addressBookIds: { book1: true } })),
      toContactCardRow('b', contactCard('shared', { addressBookIds: { book1: true } })),
    ])

    const inA = await contactCardsInBook(db, 'a', 'book1')
    const inB = await contactCardsInBook(db, 'b', 'book1')

    expect(inA.map((row) => row.accountId)).toEqual(['a'])
    expect(inB.map((row) => row.accountId)).toEqual(['b'])
    expect(await db.contactCards.count()).toBe(2)
  })

  it('wipeReplica destroys the whole database', async () => {
    await db.emails.put(toEmailRow('a', email('e1')))
    await db.mailboxes.put(toMailboxRow('a', mailbox('inbox', { role: 'inbox' })))
    expect(await db.emails.count()).toBe(1)

    const name = db.name
    await wipeReplica(db)

    // The instance is closed; a fresh handle on the same database name sees an empty store.
    const fresh = new ReplicaDb(name)
    expect(await fresh.emails.count()).toBe(0)
    expect(await fresh.mailboxes.count()).toBe(0)
    await fresh.delete()
  })
})

describe('contacts schema (M4.2, v6)', () => {
  it('round-trips an address book on its compound key', async () => {
    await db.addressBooks.put({ ...addressBook('book1', { name: 'Personal' }), accountId: 'a' })
    const got = await db.addressBooks.get(['a', 'book1'])
    expect(got?.name).toBe('Personal')
    expect(got?.accountId).toBe('a')
  })

  it('round-trips a full contact card losslessly (JSContact + JMAP layer)', async () => {
    const card = contactCard('c1', {
      addressBookIds: { book1: true, book2: true },
      kind: 'individual',
      // An unmapped vCard property must survive the round-trip untouched (the whole point of the row).
      vCardProps: [['x-custom', {}, 'text', 'kept']],
    })
    await db.contactCards.put(toContactCardRow('a', card))

    const got = await db.contactCards.get(['a', 'c1'])
    expect(got?.uid).toBe('uid-c1')
    expect(got?.kind).toBe('individual')
    expect(got?.addressBookIds).toEqual({ book1: true, book2: true })
    expect(got?.vCardProps).toEqual([['x-custom', {}, 'text', 'kept']])
  })

  it('toContactCardRow derives the account-scoped book-membership array from addressBookIds', () => {
    const row = toContactCardRow(
      'acc',
      contactCard('c1', { addressBookIds: { book1: true, biz: true } }),
    )
    // Literal expected values (not scopeKey on both sides) so the stored `abk` format itself is pinned.
    expect(row.abk.sort()).toEqual(['acc\u0000biz', 'acc\u0000book1'])
  })

  it('serves book membership through the abk multiEntry index', async () => {
    await db.contactCards.bulkPut([
      toContactCardRow('a', contactCard('c1', { addressBookIds: { book1: true } })),
      toContactCardRow('a', contactCard('c2', { addressBookIds: { book1: true, book2: true } })),
      toContactCardRow('a', contactCard('c3', { addressBookIds: { book2: true } })),
    ])
    expect((await contactCardsInBook(db, 'a', 'book1')).map((r) => r.id).sort()).toEqual([
      'c1',
      'c2',
    ])
    expect((await contactCardsInBook(db, 'a', 'book2')).map((r) => r.id).sort()).toEqual([
      'c2',
      'c3',
    ])
  })

  it('clearAccount removes the contact tables too (auto-iterated over every table)', async () => {
    for (const acc of ['a', 'b']) {
      await db.accounts.put({
        id: acc,
        username: acc,
        name: acc,
        issuer: null,
        isPrimary: true,
        addedAt: 1,
        lastSeenAt: 1,
      })
      await db.addressBooks.put({ ...addressBook('book1'), accountId: acc })
      await db.contactCards.put(toContactCardRow(acc, contactCard('c1')))
    }

    await clearAccount(db, 'a')

    expect(await db.addressBooks.where('accountId').equals('a').count()).toBe(0)
    expect(await db.contactCards.where('accountId').equals('a').count()).toBe(0)
    // Account b is untouched.
    expect(await db.addressBooks.where('accountId').equals('b').count()).toBe(1)
    expect(await db.contactCards.where('accountId').equals('b').count()).toBe(1)
  })
})
