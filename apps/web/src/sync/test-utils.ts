/**
 * Shared fixtures for the replica tests (M1.2). Not a test file (no `.test` suffix) — it is
 * imported by the sync test suites, which run under the jsdom "web" project with
 * `fake-indexeddb/auto` preloaded, so `new ReplicaDb(name)` uses the in-memory IndexedDB.
 */

import type {
  AddressBook,
  ContactCard,
  EmailAddress,
  Mailbox,
  MailboxRights,
  Thread,
} from '@waxwing/jmap'
import { type EmailEnvelopeInput, ReplicaDb } from './db'

let seq = 0

/** A fresh, uniquely-named replica database. Delete it in `afterEach` (`await db.delete()`). */
export function freshDb(): ReplicaDb {
  seq += 1
  return new ReplicaDb(`test-replica-${seq}`)
}

export const FULL_RIGHTS: MailboxRights = {
  mayReadItems: true,
  mayAddItems: true,
  mayRemoveItems: true,
  maySetSeen: true,
  maySetKeywords: true,
  mayCreateChild: true,
  mayRename: true,
  mayDelete: true,
  maySubmit: true,
}

export function mailbox(id: string, over: Partial<Mailbox> = {}): Mailbox {
  return {
    id,
    name: id,
    parentId: null,
    role: null,
    sortOrder: 0,
    totalEmails: 0,
    unreadEmails: 0,
    totalThreads: 0,
    unreadThreads: 0,
    myRights: FULL_RIGHTS,
    isSubscribed: true,
    ...over,
  }
}

export function email(id: string, over: Partial<EmailEnvelopeInput> = {}): EmailEnvelopeInput {
  const from: EmailAddress[] = [{ name: 'Alice', email: 'alice@waxwing.test' }]
  return {
    id,
    blobId: `blob-${id}`,
    threadId: `t-${id}`,
    mailboxIds: { inbox: true },
    keywords: {},
    size: 100,
    receivedAt: '2026-07-01T00:00:00Z',
    sentAt: null,
    from,
    to: null,
    cc: null,
    replyTo: null,
    subject: `Subject ${id}`,
    messageId: [`<${id}@waxwing.test>`],
    inReplyTo: null,
    references: null,
    preview: 'preview',
    hasAttachment: false,
    ...over,
  }
}

export function thread(id: string, emailIds: string[]): Thread {
  return { id, emailIds }
}

// ── Contacts (M4.2) ──────────────────────────────────────────────────────────────────────────

export function addressBook(id: string, over: Partial<AddressBook> = {}): AddressBook {
  return {
    id,
    name: id,
    description: null,
    sortOrder: 0,
    isDefault: false,
    isSubscribed: true,
    myRights: { mayRead: true, mayWrite: true, mayShare: false, mayDelete: false },
    ...over,
  }
}

export function contactCard(id: string, over: Partial<ContactCard> = {}): ContactCard {
  return {
    '@type': 'Card',
    version: '1.0',
    uid: `uid-${id}`,
    id,
    addressBookIds: { book1: true },
    ...over,
  }
}
