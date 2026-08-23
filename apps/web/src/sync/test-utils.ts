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
import type { JmapPort } from './engine/types'

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
  mayShare: false,
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

/**
 * Give a fake port the batched `Email/query` + `Email/get` pair (B55) for free.
 *
 * Real batching is one REQUEST; here it is the two calls the fake already answers, which is exactly
 * right — what a unit test controls is the two ANSWERS, not the transport that carries them. A fake
 * that wants to observe the batched call itself simply defines the method and this leaves it alone.
 *
 * Typed against `Omit<JmapPort, …>` rather than a loose record so the object literal at the call
 * site still gets its contextual types: without that, every `async (ids) => …` in a fake port loses
 * its parameter types and `noImplicitAny` fails the file.
 */
export function withBatchedQuery<P extends Omit<JmapPort, 'queryEmailsWithEnvelopes'>>(
  port: P,
): JmapPort {
  const own = (port as Partial<JmapPort>).queryEmailsWithEnvelopes
  if (own !== undefined) return port as unknown as JmapPort
  return {
    ...port,
    queryEmailsWithEnvelopes: async (spec: Parameters<JmapPort['queryEmails']>[0]) => {
      const query = await port.queryEmails(spec)
      const envelopes = await port.getEmailEnvelopes(query.ids)
      return { query, envelopes }
    },
  } as unknown as JmapPort
}
