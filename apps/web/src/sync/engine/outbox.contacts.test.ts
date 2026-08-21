/**
 * Contact CRUD outbox intents (M4.2, stage 5a) — the durable Offline-Outbox extended to ContactCards
 * and AddressBooks with the SAME optimistic-apply / persisted-undo / conflict-classification machinery
 * that mutates mailboxes. These tests pin the async-seam SEQUENCES, not just the end states: dispatch →
 * optimistic row visible → server ack finalizes (creation id → server id) OR server reject/conflict →
 * undo restores the pre-image with no data loss.
 */

import { JmapMethodError } from '@waxwing/jmap'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OutboxRow, ReplicaDb } from '../db'
import { pendingOutbox, putAddressBooks, putContactCards } from '../repo'
import { addressBook, contactCard, freshDb } from '../test-utils'
import {
  enqueueCreateAddressBook,
  enqueueCreateContactCard,
  enqueueDeleteAddressBook,
  enqueueDeleteContactCard,
  enqueueUpdateAddressBook,
  enqueueUpdateContactCard,
} from './contact-mutations'
import { enqueueAction, type OutboxIntent, replayOutbox } from './outbox'
import type { JmapPort, PortSetResult } from './types'

let db: ReplicaDb
const ACC = 'acc'
const NO_JITTER = () => 0

beforeEach(() => {
  db = freshDb()
})

afterEach(async () => {
  await db.delete()
})

function unused(): never {
  throw new Error('port method not used in this test')
}

function fakePort(overrides: Partial<JmapPort>): JmapPort {
  const base: JmapPort = {
    accountId: ACC,
    mailboxChanges: unused,
    threadChanges: unused,
    emailChanges: unused,
    getMailboxes: unused,
    getIdentities: unused,
    getThreads: unused,
    getEmailEnvelopes: unused,
    getEmailBodies: unused,
    queryEmails: unused,
    queryEmailChanges: unused,
    setEmails: unused,
    setMailboxes: unused,
    submitEmail: unused,
    getSearchSnippets: unused,
    getAddressBooks: unused,
    addressBookChanges: unused,
    setAddressBooks: unused,
    getContactCards: unused,
    contactCardChanges: unused,
    queryContactCards: unused,
    queryContactCardChanges: unused,
    setContactCards: unused,
    getCalendars: unused,
    calendarChanges: unused,
    getCalendarEvents: unused,
    calendarEventChanges: unused,
    queryCalendarEvents: unused,
    fileNodePage: unused,
    getFileNodes: unused,
    fileNodeChanges: unused,
  }
  return { ...base, ...overrides }
}

function setResult(over: Partial<PortSetResult> = {}): PortSetResult {
  return {
    oldState: null,
    newState: 's1',
    created: {},
    updated: [],
    destroyed: [],
    notCreated: {},
    notUpdated: {},
    notDestroyed: {},
    ...over,
  }
}

const row = (id: string): Promise<OutboxRow | undefined> => db.outbox.get([ACC, id])
const card = (id: string) => db.contactCards.get([ACC, id])
const book = (id: string) => db.addressBooks.get([ACC, id])

// ── createContactCard ──────────────────────────────────────────────────────────────────────────

describe('outbox contacts — createContactCard', () => {
  it('writes the optimistic card at the temp id and enqueues a pending intent with its undo', async () => {
    await enqueueAction(
      db,
      ACC,
      { kind: 'createContactCard', creationId: 'tmp1', card: contactCard('tmp1') },
      { id: 'i1', now: 1 },
    )

    expect((await card('tmp1'))?.uid).toBe('uid-tmp1')
    expect((await pendingOutbox(db, ACC)).map((r) => r.id)).toEqual(['i1'])
    // The undo is DATA on the row (a create's undo is a plain delete — prior is null).
    expect((await row('i1'))?.undo).toEqual({ kind: 'contactCard', id: 'tmp1', prior: null })
  })

  it('optimistic → ack → finalize: swaps the creation id for the server id', async () => {
    await enqueueAction(
      db,
      ACC,
      { kind: 'createContactCard', creationId: 'tmp1', card: contactCard('tmp1') },
      { id: 'i1', now: 1 },
    )
    expect(await card('tmp1')).toBeDefined()
    const port = fakePort({
      setContactCards: async () => setResult({ created: { tmp1: { id: 'CC99' } } }),
    })

    await replayOutbox(port, db, ACC, { random: NO_JITTER })

    expect(await card('tmp1')).toBeUndefined()
    expect((await card('CC99'))?.uid).toBe('uid-tmp1')
    expect(await db.outbox.count()).toBe(0)
  })

  it('optimistic → reject → undo: removes the optimistic card, dead-letters the row', async () => {
    await enqueueAction(
      db,
      ACC,
      { kind: 'createContactCard', creationId: 'tmp1', card: contactCard('tmp1') },
      { id: 'i1', now: 1 },
    )
    const port = fakePort({
      setContactCards: async () =>
        setResult({ notCreated: { tmp1: { type: 'invalidProperties' } } }),
    })

    const summary = await replayOutbox(port, db, ACC, { random: NO_JITTER })

    expect(summary).toMatchObject({ replayed: 0, failed: 1 })
    expect(await card('tmp1')).toBeUndefined() // rolled back — no orphan row
    const dead = await row('i1')
    expect(dead?.status).toBe('error')
    expect(dead?.conflict?.code).toBe('invalid')
    expect(dead?.undo).toBeNull() // the rollback ran, so nothing is owed
  })

  it('strips the temp id from the ContactCard/set create payload', async () => {
    await enqueueAction(
      db,
      ACC,
      { kind: 'createContactCard', creationId: 'tmp1', card: contactCard('tmp1') },
      { id: 'i1', now: 1 },
    )
    let seen: Record<string, unknown> | undefined
    const port = fakePort({
      setContactCards: async (args) => {
        seen = args.create?.tmp1 as Record<string, unknown>
        return setResult({ created: { tmp1: { id: 'CC99' } } })
      },
    })

    await replayOutbox(port, db, ACC, { random: NO_JITTER })

    expect(seen).toBeDefined()
    expect('id' in (seen ?? {})).toBe(false) // the server assigns the id
    expect(seen?.uid).toBe('uid-tmp1')
  })
})

// ── updateContactCard ──────────────────────────────────────────────────────────────────────────

describe('outbox contacts — updateContactCard', () => {
  beforeEach(async () => {
    await putContactCards(db, ACC, [contactCard('c1')])
  })

  it('optimistic → ack: applies the patch locally and drops the row on confirm', async () => {
    await enqueueAction(
      db,
      ACC,
      { kind: 'updateContactCard', id: 'c1', patch: { 'name/full': 'Ada Lovelace' } },
      { id: 'i1', now: 1 },
    )
    // The optimistic patch is visible immediately (pointer set into the card).
    expect((await card('c1'))?.name).toEqual({ full: 'Ada Lovelace' })
    // The undo captured the FULL prior row (an exact rollback, patch-fidelity aside).
    expect((await row('i1'))?.undo).toMatchObject({ kind: 'contactCard', id: 'c1' })

    const port = fakePort({ setContactCards: async () => setResult({ updated: ['c1'] }) })
    await replayOutbox(port, db, ACC, { random: NO_JITTER })

    expect((await card('c1'))?.name).toEqual({ full: 'Ada Lovelace' })
    expect(await db.outbox.count()).toBe(0)
  })

  it('optimistic → reject → undo: restores the exact pre-edit card', async () => {
    await putContactCards(db, ACC, [contactCard('c1', { name: { full: 'Original' } })])
    await enqueueAction(
      db,
      ACC,
      { kind: 'updateContactCard', id: 'c1', patch: { 'name/full': 'Edited' } },
      { id: 'i1', now: 1 },
    )
    expect((await card('c1'))?.name).toEqual({ full: 'Edited' })
    const port = fakePort({
      setContactCards: async () => setResult({ notUpdated: { c1: { type: 'forbidden' } } }),
    })

    await replayOutbox(port, db, ACC, { random: NO_JITTER })

    expect((await card('c1'))?.name).toEqual({ full: 'Original' }) // restored
    const dead = await row('i1')
    expect(dead?.status).toBe('error')
    expect(dead?.conflict?.code).toBe('forbidden')
  })

  it('a notFound on update classifies as contactGone (the card was deleted elsewhere)', async () => {
    await enqueueAction(
      db,
      ACC,
      { kind: 'updateContactCard', id: 'c1', patch: { 'name/full': 'X' } },
      { id: 'i1', now: 1 },
    )
    const port = fakePort({
      setContactCards: async () => setResult({ notUpdated: { c1: { type: 'notFound' } } }),
    })

    await replayOutbox(port, db, ACC, { random: NO_JITTER })

    expect((await row('i1'))?.conflict?.code).toBe('contactGone')
  })

  it('removes a property when the patch value is null', async () => {
    await putContactCards(db, ACC, [contactCard('c1', { name: { full: 'Has name' } })])
    await enqueueAction(
      db,
      ACC,
      { kind: 'updateContactCard', id: 'c1', patch: { name: null } },
      { id: 'i1', now: 1 },
    )
    expect((await card('c1'))?.name).toBeUndefined()
  })
})

// ── deleteContactCard ──────────────────────────────────────────────────────────────────────────

describe('outbox contacts — deleteContactCard', () => {
  beforeEach(async () => {
    await putContactCards(db, ACC, [contactCard('c1')])
  })

  it('optimistic → ack: removes the card and drops the row', async () => {
    await enqueueAction(db, ACC, { kind: 'deleteContactCard', id: 'c1' }, { id: 'i1', now: 1 })
    expect(await card('c1')).toBeUndefined() // optimistically gone
    expect((await row('i1'))?.undo).toMatchObject({ kind: 'contactCard', id: 'c1' })

    const port = fakePort({ setContactCards: async () => setResult({ destroyed: ['c1'] }) })
    const summary = await replayOutbox(port, db, ACC, { random: NO_JITTER })

    expect(summary).toMatchObject({ replayed: 1, failed: 0 })
    expect(await card('c1')).toBeUndefined()
    expect(await db.outbox.count()).toBe(0)
  })

  it('a notFound on delete is a SUCCESS, not a resurrection ("already gone")', async () => {
    await enqueueAction(db, ACC, { kind: 'deleteContactCard', id: 'c1' }, { id: 'i1', now: 1 })
    const port = fakePort({
      setContactCards: async () => setResult({ notDestroyed: { c1: { type: 'notFound' } } }),
    })

    const summary = await replayOutbox(port, db, ACC, { random: NO_JITTER })

    expect(summary).toMatchObject({ replayed: 1, failed: 0 })
    expect(await card('c1')).toBeUndefined() // stays deleted — never restored
    expect(await db.outbox.count()).toBe(0)
  })

  it('optimistic → reject → undo: restores the deleted card', async () => {
    await enqueueAction(db, ACC, { kind: 'deleteContactCard', id: 'c1' }, { id: 'i1', now: 1 })
    const port = fakePort({
      setContactCards: async () => setResult({ notDestroyed: { c1: { type: 'forbidden' } } }),
    })

    await replayOutbox(port, db, ACC, { random: NO_JITTER })

    expect((await card('c1'))?.uid).toBe('uid-c1') // brought back
    expect((await row('i1'))?.conflict?.code).toBe('forbidden')
  })
})

// ── createAddressBook ──────────────────────────────────────────────────────────────────────────

describe('outbox contacts — createAddressBook', () => {
  it('writes the optimistic book and, on ack, swaps the creation id for the server id', async () => {
    await enqueueAction(
      db,
      ACC,
      { kind: 'createAddressBook', creationId: 'tmpB', props: { name: 'Work' } },
      { id: 'i1', now: 1 },
    )
    expect((await book('tmpB'))?.name).toBe('Work')
    expect((await row('i1'))?.undo).toEqual({ kind: 'addressBook', id: 'tmpB', prior: null })

    const port = fakePort({
      setAddressBooks: async () => setResult({ created: { tmpB: { id: 'AB99' } } }),
    })
    await replayOutbox(port, db, ACC, { random: NO_JITTER })

    expect(await book('tmpB')).toBeUndefined()
    expect((await book('AB99'))?.name).toBe('Work')
  })

  it('re-files cards optimistically created in the temp book onto the server book id', async () => {
    // Create a book, then create a card into it — both offline, before any replay.
    await enqueueAction(
      db,
      ACC,
      { kind: 'createAddressBook', creationId: 'tmpB', props: { name: 'Work' } },
      { id: 'i1', now: 1 },
    )
    await enqueueAction(
      db,
      ACC,
      {
        kind: 'createContactCard',
        creationId: 'tmpC',
        card: contactCard('tmpC', { addressBookIds: { tmpB: true } }),
      },
      { id: 'i2', now: 2 },
    )
    const port = fakePort({
      setAddressBooks: async () => setResult({ created: { tmpB: { id: 'AB99' } } }),
      setContactCards: async () => {
        // Not reached in this test — the book create fails the pass first so we can inspect rewrites.
        throw new TypeError('fetch failed')
      },
    })

    await replayOutbox(port, db, ACC, { random: NO_JITTER })

    // The optimistic card is re-filed onto the server book id…
    expect((await card('tmpC'))?.addressBookIds).toEqual({ AB99: true })
    // …AND the still-queued createContactCard's payload now names the server book id.
    const queued = (await row('i2'))?.payload as Extract<
      OutboxIntent,
      { kind: 'createContactCard' }
    >
    expect(queued.card.addressBookIds).toEqual({ AB99: true })
  })

  it('optimistic → reject → undo: removes the optimistic book', async () => {
    await enqueueAction(
      db,
      ACC,
      { kind: 'createAddressBook', creationId: 'tmpB', props: { name: 'Work' } },
      { id: 'i1', now: 1 },
    )
    const port = fakePort({
      setAddressBooks: async () => setResult({ notCreated: { tmpB: { type: 'forbidden' } } }),
    })

    await replayOutbox(port, db, ACC, { random: NO_JITTER })

    expect(await book('tmpB')).toBeUndefined()
    expect((await row('i1'))?.conflict?.code).toBe('forbidden')
  })
})

// ── updateAddressBook / deleteAddressBook (JMAP gap analysis, B-5) ────────────────────────────

describe('outbox contacts — updateAddressBook', () => {
  it('renames optimistically, guards on the AddressBook state, and sends a minimal patch', async () => {
    await putAddressBooks(db, ACC, [addressBook('B1', { name: 'Work' })])
    await enqueueAction(
      db,
      ACC,
      { kind: 'updateAddressBook', id: 'B1', props: { name: 'Office' } },
      { id: 'i1', now: 1, ifInState: 'ab-7' },
    )

    expect((await book('B1'))?.name).toBe('Office')
    // The undo is the WHOLE prior row, so a rejection restores the old name exactly.
    expect((await row('i1'))?.undo).toMatchObject({ kind: 'addressBook', id: 'B1' })

    let sent: Parameters<JmapPort['setAddressBooks']>[0] | null = null
    const port = fakePort({
      setAddressBooks: async (args) => {
        sent = args
        return setResult({ updated: ['B1'] })
      },
    })
    await replayOutbox(port, db, ACC, { random: NO_JITTER })

    expect(sent).toEqual({ update: { B1: { name: 'Office' } }, ifInState: 'ab-7' })
    expect(await db.outbox.count()).toBe(0)
  })

  it('optimistic → reject → undo: the old name comes back', async () => {
    await putAddressBooks(db, ACC, [addressBook('B1', { name: 'Work' })])
    await enqueueAction(
      db,
      ACC,
      { kind: 'updateAddressBook', id: 'B1', props: { name: 'Office' } },
      { id: 'i1', now: 1 },
    )
    const port = fakePort({
      setAddressBooks: async () => setResult({ notUpdated: { B1: { type: 'forbidden' } } }),
    })

    await replayOutbox(port, db, ACC, { random: NO_JITTER })

    expect((await book('B1'))?.name).toBe('Work')
    expect((await row('i1'))?.conflict?.code).toBe('forbidden')
  })

  it('a book deleted elsewhere is `folderGone`, not the mail-worded `messageGone`', async () => {
    await putAddressBooks(db, ACC, [addressBook('B1', { name: 'Work' })])
    await enqueueAction(
      db,
      ACC,
      { kind: 'updateAddressBook', id: 'B1', props: { name: 'Office' } },
      { id: 'i1', now: 1 },
    )
    const port = fakePort({
      setAddressBooks: async () => setResult({ notUpdated: { B1: { type: 'notFound' } } }),
    })

    await replayOutbox(port, db, ACC, { random: NO_JITTER })

    expect((await row('i1'))?.conflict?.code).toBe('folderGone')
  })
})

describe('outbox contacts — deleteAddressBook', () => {
  it('removes the book optimistically and destroys it WITH its contents', async () => {
    await putAddressBooks(db, ACC, [addressBook('B1', { name: 'Work' })])
    await putContactCards(db, ACC, [contactCard('c1', { addressBookIds: { B1: true } })])
    await enqueueAction(db, ACC, { kind: 'deleteAddressBook', id: 'B1' }, { id: 'i1', now: 1 })

    expect(await book('B1')).toBeUndefined()
    // The CARDS are left to the ContactCard delta — see the note on the optimistic apply.
    expect(await card('c1')).toBeDefined()

    let sent: Parameters<JmapPort['setAddressBooks']>[0] | null = null
    const port = fakePort({
      setAddressBooks: async (args) => {
        sent = args
        return setResult({ destroyed: ['B1'] })
      },
    })
    await replayOutbox(port, db, ACC, { random: NO_JITTER })

    // Without `onDestroyRemoveContents` the server refuses to destroy a book that still holds a
    // card — i.e. every book anyone actually keeps.
    expect(sent).toMatchObject({ destroy: ['B1'], onDestroyRemoveContents: true })
    expect(await db.outbox.count()).toBe(0)
  })

  it('optimistic → reject → undo: the book comes back', async () => {
    await putAddressBooks(db, ACC, [addressBook('B1', { name: 'Work' })])
    await enqueueAction(db, ACC, { kind: 'deleteAddressBook', id: 'B1' }, { id: 'i1', now: 1 })
    expect(await book('B1')).toBeUndefined()

    const port = fakePort({
      setAddressBooks: async () => setResult({ notDestroyed: { B1: { type: 'forbidden' } } }),
    })
    await replayOutbox(port, db, ACC, { random: NO_JITTER })

    expect((await book('B1'))?.name).toBe('Work')
    expect((await row('i1'))?.conflict?.code).toBe('forbidden')
  })

  it('a book already gone server-side is a SUCCESS, not a rollback', async () => {
    await putAddressBooks(db, ACC, [addressBook('B1', { name: 'Work' })])
    await enqueueAction(db, ACC, { kind: 'deleteAddressBook', id: 'B1' }, { id: 'i1', now: 1 })
    const port = fakePort({
      setAddressBooks: async () => setResult({ notDestroyed: { B1: { type: 'notFound' } } }),
    })

    await replayOutbox(port, db, ACC, { random: NO_JITTER })

    // Restoring it would resurrect a book the user (or another client) removed.
    expect(await book('B1')).toBeUndefined()
    expect(await db.outbox.count()).toBe(0)
  })

  it('rewrites a rename/delete queued against a book created in the same session', async () => {
    await enqueueAction(
      db,
      ACC,
      { kind: 'createAddressBook', creationId: 'tmpB', props: { name: 'Work' } },
      { id: 'i1', now: 1 },
    )
    await enqueueAction(
      db,
      ACC,
      { kind: 'updateAddressBook', id: 'tmpB', props: { name: 'Office' } },
      { id: 'i2', now: 2 },
    )
    await enqueueAction(db, ACC, { kind: 'deleteAddressBook', id: 'tmpB' }, { id: 'i3', now: 3 })

    let calls = 0
    const port = fakePort({
      setAddressBooks: async () => {
        calls += 1
        if (calls === 1) return setResult({ created: { tmpB: { id: 'AB99' } } })
        throw new TypeError('fetch failed') // stop the pass so the rewrites can be inspected
      },
    })
    await replayOutbox(port, db, ACC, { random: NO_JITTER })

    const rename = (await row('i2'))?.payload as Extract<
      OutboxIntent,
      { kind: 'updateAddressBook' }
    >
    const remove = (await row('i3'))?.payload as Extract<
      OutboxIntent,
      { kind: 'deleteAddressBook' }
    >
    expect(rename.id).toBe('AB99')
    expect(remove.id).toBe('AB99')
  })
})

// ── creation-id rewrite of chained card intents ──────────────────────────────────────────────────

describe('outbox contacts — creation-id rewrite', () => {
  it('rewrites a queued update/delete of a card created in the same session', async () => {
    await enqueueAction(
      db,
      ACC,
      { kind: 'createContactCard', creationId: 'tmpC', card: contactCard('tmpC') },
      { id: 'i1', now: 1 },
    )
    await enqueueAction(
      db,
      ACC,
      { kind: 'updateContactCard', id: 'tmpC', patch: { 'name/full': 'Renamed' } },
      { id: 'i2', now: 2 },
    )
    await enqueueAction(db, ACC, { kind: 'deleteContactCard', id: 'tmpC' }, { id: 'i3', now: 3 })
    const port = fakePort({
      setContactCards: async (args) => {
        if (args.create) return setResult({ created: { tmpC: { id: 'CC99' } } })
        throw new TypeError('fetch failed') // stop the pass to inspect the rewrites
      },
    })

    await replayOutbox(port, db, ACC, { random: NO_JITTER })

    const update = (await row('i2'))?.payload as Extract<
      OutboxIntent,
      { kind: 'updateContactCard' }
    >
    const remove = (await row('i3'))?.payload as Extract<
      OutboxIntent,
      { kind: 'deleteContactCard' }
    >
    expect(update.id).toBe('CC99')
    expect(remove.id).toBe('CC99')
  })
})

// ── state-conflict classification (ifInState / stateMismatch) ────────────────────────────────────

describe('outbox contacts — stateMismatch on a guarded update', () => {
  beforeEach(async () => {
    await putContactCards(db, ACC, [contactCard('c1', { name: { full: 'Old' } })])
  })
  const guarded = { kind: 'updateContactCard', id: 'c1', patch: { 'name/full': 'New' } } as const

  it('re-syncs the ContactCard state and re-executes once, then succeeds', async () => {
    await enqueueAction(db, ACC, guarded, { id: 'i1', now: 0, ifInState: 'stale' })
    const seen: (string | null)[] = []
    let first = true
    const port = fakePort({
      setContactCards: async (args) => {
        seen.push(args.ifInState ?? null)
        if (first) {
          first = false
          throw new JmapMethodError({ type: 'stateMismatch' }, 'c1')
        }
        return setResult({ updated: ['c1'] })
      },
    })
    const refreshedTypes: string[] = []

    await replayOutbox(port, db, ACC, {
      random: NO_JITTER,
      refreshState: async (type) => {
        refreshedTypes.push(type)
        return 'fresh'
      },
    })

    expect(refreshedTypes).toEqual(['ContactCard']) // the CONTACT state, not Mailbox
    expect(seen).toEqual(['stale', 'fresh'])
    expect(await row('i1')).toBeUndefined()
    expect((await card('c1'))?.name).toEqual({ full: 'New' })
  })

  it('gives up after MAX_REFRESHES and dead-letters as stateConflict, rolling back', async () => {
    await enqueueAction(db, ACC, guarded, { id: 'i1', now: 0, ifInState: 'stale' })
    const port = fakePort({
      setContactCards: async () => {
        throw new JmapMethodError({ type: 'stateMismatch' }, 'c1')
      },
    })

    await replayOutbox(port, db, ACC, {
      random: NO_JITTER,
      refreshState: async () => 's',
    })

    const dead = await row('i1')
    expect(dead?.status).toBe('error')
    expect(dead?.conflict?.code).toBe('stateConflict')
    expect((await card('c1'))?.name).toEqual({ full: 'Old' }) // rolled back
  })
})

// ── the enqueue helper API (stage 5b's seam) ─────────────────────────────────────────────────────

describe('outbox contacts — enqueue helpers', () => {
  /** A minimal dispatcher that runs the real enqueue path against the test replica. */
  const dispatcher = {
    dispatch: (intent: OutboxIntent, options: { id: string }) =>
      enqueueAction(db, ACC, intent, { ...options, now: 1 }).then(() => undefined),
  }
  let n = 0
  const ids = () => {
    n += 1
    return `id-${n}`
  }

  it('enqueueCreateContactCard forces the card id to the creation id and applies optimistically', async () => {
    const { id, creationId } = await enqueueCreateContactCard(
      dispatcher,
      contactCard('ignored'),
      ids,
    )
    expect(id).toBe('id-2')
    expect(creationId).toBe('id-1')
    // The optimistic row lives at the creation id, NOT the card's original id.
    expect(await card('id-1')).toBeDefined()
    expect(await card('ignored')).toBeUndefined()
  })

  it('enqueueCreateAddressBook / update / delete enqueue the right intents', async () => {
    await putContactCards(db, ACC, [contactCard('c1')])
    await putAddressBooks(db, ACC, [addressBook('book1')])

    const b = await enqueueCreateAddressBook(dispatcher, { name: 'Fam' }, ids)
    const u = await enqueueUpdateContactCard(dispatcher, 'c1', { 'name/full': 'Z' }, ids)
    const d = await enqueueDeleteContactCard(dispatcher, 'c1', ids)

    expect((await row(b.id))?.type).toBe('createAddressBook')
    expect((await row(u.id))?.type).toBe('updateContactCard')
    expect((await row(d.id))?.type).toBe('deleteContactCard')
    expect(await card('c1')).toBeUndefined() // the delete applied last, optimistically
  })

  it('enqueueUpdateAddressBook / enqueueDeleteAddressBook enqueue the right intents (B-5)', async () => {
    await putAddressBooks(db, ACC, [addressBook('book1', { name: 'Work' })])

    const r = await enqueueUpdateAddressBook(dispatcher, 'book1', { name: 'Office' }, ids)
    expect((await row(r.id))?.type).toBe('updateAddressBook')
    expect((await book('book1'))?.name).toBe('Office')

    const x = await enqueueDeleteAddressBook(dispatcher, 'book1', ids)
    expect((await row(x.id))?.type).toBe('deleteAddressBook')
    expect(await book('book1')).toBeUndefined()
  })
})
