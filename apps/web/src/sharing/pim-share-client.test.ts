/**
 * The wire shape of an address-book and a calendar share (S-2).
 *
 * Two seams, one file, because the interesting thing about them is the CONTRAST — and it is a
 * contrast about where the grant map comes from:
 *
 *  - an **address book** is fetched with an explicit `properties: [id, shareWith]`, because the sync
 *    engine names no properties at all and whether this server volunteers `shareWith` in that answer
 *    has never been measured. Reading it off a replica row could mean reading `undefined`, showing
 *    "Only you" over a shared book, and writing `{}` back on the first edit.
 *  - a **calendar** has no `load` here at all, because `calendar/calendar-client.ts` already names
 *    `shareWith` on every `Calendar/get`. The test for that lives with the property list.
 *
 * Both writes send the WHOLE map, and both classify `notUpdated` per object rather than treating a
 * refusal as a dead request.
 */

import type { Invocation, JmapClient } from '@waxwing/jmap'
import { MethodResponses } from '@waxwing/jmap'
import { describe, expect, it, vi } from 'vitest'
import { AddressBookShareError, makeAddressBookSharingClient } from './addressbook-client'
import { addressBookRoles } from './addressbook-roles'
import { calendarRoles } from './calendar-roles'
import { CalendarShareError, makeCalendarSharingClient } from './calendar-share-client'

interface Recorder {
  readonly client: JmapClient
  readonly calls: Invocation[][]
}

function recorder(respond: (name: string, args: Record<string, unknown>) => unknown): Recorder {
  const calls: Invocation[][] = []
  const client = {
    call: vi.fn(async (invocations: Invocation[]) => {
      calls.push(invocations)
      const responses: Invocation[] = invocations.map(([name, args, callId]) => [
        name,
        respond(name, (args ?? {}) as Record<string, unknown>) as never,
        callId,
      ])
      return new MethodResponses(responses, 's0', undefined)
    }),
  } as unknown as JmapClient
  return { client, calls }
}

describe('AddressBook — load', () => {
  it('NAMES shareWith in `properties`, because a bare get has never been proved to send it', () => {
    const { client, calls } = recorder(() => ({ list: [{ id: 'a', shareWith: {} }], notFound: [] }))
    void makeAddressBookSharingClient(client, 'b').load('a')
    const [name, args] = calls[0]?.[0] ?? []
    expect(name).toBe('AddressBook/get')
    expect((args as { properties: string[] }).properties).toContain('shareWith')
  })

  it('answers `{}` for a book nobody has access to', async () => {
    const { client } = recorder(() => ({ list: [{ id: 'a' }], notFound: [] }))
    expect(await makeAddressBookSharingClient(client, 'b').load('a')).toEqual({})
  })

  it('answers `{}` rather than throwing when the book is not there at all', async () => {
    const { client } = recorder(() => ({ list: [], notFound: ['a'] }))
    expect(await makeAddressBookSharingClient(client, 'b').load('a')).toEqual({})
  })

  it('returns the grant map the server holds', async () => {
    const viewer = addressBookRoles.rightsFor('viewer')
    const { client } = recorder(() => ({
      list: [{ id: 'a', shareWith: { 'p-bob': viewer } }],
      notFound: [],
    }))
    expect(await makeAddressBookSharingClient(client, 'b').load('a')).toEqual({ 'p-bob': viewer })
  })
})

describe('AddressBook — write', () => {
  it('sends the whole map to `AddressBook/set update`, scoped to the account', async () => {
    const { client, calls } = recorder(() => ({ updated: { a: null } }))
    const shareWith = { 'p-bob': addressBookRoles.rightsFor('editor') }
    await makeAddressBookSharingClient(client, 'b').setShareWith('a', shareWith)
    const [name, args] = calls[0]?.[0] ?? []
    expect(name).toBe('AddressBook/set')
    expect(args).toEqual({ accountId: 'b', update: { a: { shareWith } } })
  })

  it('reports an unknown rights key as `invalidRights` — the measured refusal for this type', async () => {
    const { client } = recorder(() => ({
      notUpdated: {
        a: { type: 'invalidProperties', description: 'Invalid permission "mayReadItems".' },
      },
    }))
    await expect(
      makeAddressBookSharingClient(client, 'b').setShareWith('a', {}),
    ).rejects.toMatchObject({ failure: 'invalidRights' })
  })

  it('reports a refusal to share at all as `forbidden`', async () => {
    const { client } = recorder(() => ({ notUpdated: { a: { type: 'forbidden' } } }))
    await expect(
      makeAddressBookSharingClient(client, 'b').setShareWith('a', {}),
    ).rejects.toBeInstanceOf(AddressBookShareError)
  })

  it('is silent on success', async () => {
    const { client } = recorder(() => ({ updated: { a: null } }))
    await expect(
      makeAddressBookSharingClient(client, 'b').setShareWith('a', {}),
    ).resolves.toBeUndefined()
  })
})

describe('Calendar — write', () => {
  it('sends the whole map to `Calendar/set update`, scoped to the account', async () => {
    const { client, calls } = recorder(() => ({ updated: { c1: null } }))
    const shareWith = { 'p-bob': calendarRoles.rightsFor('freeBusy') }
    await makeCalendarSharingClient(client, 'd').setShareWith('c1', shareWith)
    const [name, args] = calls[0]?.[0] ?? []
    expect(name).toBe('Calendar/set')
    expect(args).toEqual({ accountId: 'd', update: { c1: { shareWith } } })
  })

  /*
   * The end-to-end version of `calendar.test.ts`'s central claim: what actually reaches the wire for
   * "availability only" is one `true`. A regression in the spec would show up here as extra keys in
   * a request body, which is where it would really do the damage.
   */
  it('puts exactly `mayReadFreeBusy: true` on the wire for "availability only"', async () => {
    const { client, calls } = recorder(() => ({ updated: { c1: null } }))
    await makeCalendarSharingClient(client, 'd').setShareWith('c1', {
      'p-bob': calendarRoles.rightsFor('freeBusy'),
    })
    const args = calls[0]?.[0]?.[1] as {
      update: Record<string, { shareWith: Record<string, Record<string, boolean>> }>
    }
    const granted = args.update.c1?.shareWith['p-bob'] ?? {}
    expect(Object.entries(granted).filter(([, value]) => value)).toEqual([
      ['mayReadFreeBusy', true],
    ])
  })

  it('reports an unknown rights key as `invalidRights`', async () => {
    const { client } = recorder(() => ({
      notUpdated: {
        c1: { type: 'invalidProperties', description: 'Invalid permission "mayFlibber".' },
      },
    }))
    await expect(
      makeCalendarSharingClient(client, 'd').setShareWith('c1', {}),
    ).rejects.toMatchObject({ failure: 'invalidRights' })
  })

  it('reports anything else as `rejected`, with the server’s own words kept', async () => {
    const { client } = recorder(() => ({
      notUpdated: { c1: { type: 'somethingElse', description: 'No.' } },
    }))
    await expect(
      makeCalendarSharingClient(client, 'd').setShareWith('c1', {}),
    ).rejects.toMatchObject({ failure: 'rejected', message: 'No.' })
  })

  it('is a CalendarShareError, so a caller can tell it from a calendar EDIT failure', async () => {
    const { client } = recorder(() => ({ notUpdated: { c1: { type: 'forbidden' } } }))
    await expect(
      makeCalendarSharingClient(client, 'd').setShareWith('c1', {}),
    ).rejects.toBeInstanceOf(CalendarShareError)
  })
})
