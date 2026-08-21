/**
 * The probe that stops a shared CALENDAR from growing a mail section — and a shared MAILBOX from
 * growing a contacts one (S-4).
 *
 * The scenario every test here is built on was measured against the live Stalwart v0.16.18 fixture
 * on 2026-08-21, and it is the single most surprising fact in the whole sharing package:
 *
 *   carol shared ONE CALENDAR with alice, and nothing else.
 *   alice's session then listed carol's account `d` with **all seventeen** capabilities,
 *   `urn:ietf:params:jmap:mail` among them.
 *   `Mailbox/get { accountId: "d" }` → `error forbidden "You do not have access to account d"`.
 *
 * Re-measured the other way round on the same day, to check the rule generalises: alice shared ONE
 * ADDRESS BOOK with carol, and in a single batch `AddressBook/get` answered a list while
 * `Mailbox/get`, `FileNode/get` and `FileNode/query` all answered `forbidden`.
 *
 * `secondaryMailAccounts()` reads exactly that capability, and is documented at length as the
 * strictest test the session offers. It is still a false positive here — so the assertion "a
 * fully-capable account that refuses `AddressBook/get` gets no contacts section" cannot be checked
 * anywhere but against this probe.
 */

import type { Invocation, JmapClient } from '@waxwing/jmap'
import { describe, expect, it, vi } from 'vitest'
import {
  type AreaAccess,
  accountsWithArea,
  probeMailAccess,
  probeSharedAreas,
  SHARE_AREAS,
} from './probe'

const FORBIDDEN = { type: 'forbidden', description: 'You do not have access to account d' }

/** `accountId` → the METHOD NAMES that account will serve. Everything else answers `forbidden`. */
type Allowed = Readonly<Record<string, readonly string[]>>

/**
 * A client that serves only what `allowed` says it serves.
 *
 * Deliberately answers EVERY call in the batch, including the refused ones — that is what the server
 * does, and the whole one-batch design rests on it (measured: five calls, three `forbidden`, five
 * responses back). A fake that dropped the failures would let a broken implementation pass.
 */
function clientAllowing(allowed: Allowed): { client: JmapClient; calls: Invocation[][] } {
  const calls: Invocation[][] = []
  const client = {
    call: vi.fn(async (invocations: Invocation[]) => {
      calls.push(invocations)
      const responses: Invocation[] = invocations.map(([name, args, callId]) => {
        const accountId = (args as { accountId: string }).accountId
        return (allowed[accountId] ?? []).includes(name)
          ? [name, { accountId, state: 's', list: [], notFound: [] }, callId]
          : ['error', FORBIDDEN, callId]
      })
      // The real `MethodResponses`, so `get()` throws on an error entry exactly as it does live.
      const { MethodResponses } = await import('@waxwing/jmap')
      return new MethodResponses(responses, 's0', undefined)
    }),
  } as unknown as JmapClient
  return { client, calls }
}

const EVERYTHING = ['Mailbox/get', 'AddressBook/get', 'FileNode/get']

describe('probeSharedAreas', () => {
  it('spends ONE request for every account × area, whatever the answers', async () => {
    const { client, calls } = clientAllowing({ b: EVERYTHING })
    await probeSharedAreas(client, ['b', 'c', 'd'])
    expect(calls).toHaveLength(1)
    expect(calls[0]).toHaveLength(3 * SHARE_AREAS.length)
  })

  it('THE ONE: a fully-capable account that refuses AddressBook/get has no contacts', async () => {
    // Carol advertises everything — she shared a calendar. She shared no address book and no files.
    const { client } = clientAllowing({ b: EVERYTHING, d: ['Mailbox/get'] })
    const verdicts = await probeSharedAreas(client, ['b', 'd'])
    expect(verdicts.get('d')).toEqual({
      mail: 'granted',
      contacts: 'denied',
      files: 'denied',
    } satisfies AreaAccess)
    expect(verdicts.get('b')?.contacts).toBe('granted')
  })

  it('reads each area on its own — a contacts-only share denies mail and files', async () => {
    // The measured alice→carol direction, exactly.
    const { client } = clientAllowing({ d: ['AddressBook/get'] })
    expect(await probeSharedAreas(client, ['d'])).toEqual(
      new Map([['d', { mail: 'denied', contacts: 'granted', files: 'denied' }]]),
    )
  })

  it('asks for no objects at all — the access check is the point', async () => {
    // `ids: []` is refused identically to `ids: null` (measured), so the probe costs the server the
    // lookup and nothing else.
    const { client, calls } = clientAllowing({ b: EVERYTHING })
    await probeSharedAreas(client, ['b'], ['contacts'])
    expect(calls[0]?.[0]?.[0]).toBe('AddressBook/get')
    const args = calls[0]?.[0]?.[1] as { ids: unknown; properties: unknown }
    expect(args.ids).toEqual([])
    expect(args.properties).toEqual(['id'])
  })

  it('sends nothing at all when there is nothing to probe', async () => {
    const { client, calls } = clientAllowing({})
    expect(await probeSharedAreas(client, [])).toEqual(new Map())
    expect(calls).toHaveLength(0)
  })

  it('treats a failed REQUEST as no evidence, not as a denial', async () => {
    /*
     * The asymmetry that matters. A false positive (a section that should not be there) is the
     * status quo and is corrected on the next probe. A false negative removes an account the user
     * may be reading right now — so an offline blip must never do it.
     */
    const client = {
      call: vi.fn(async () => {
        throw new Error('offline')
      }),
    } as unknown as JmapClient
    const verdicts = await probeSharedAreas(client, ['c', 'd'])
    expect(verdicts.get('c')).toEqual({ mail: 'granted', contacts: 'granted', files: 'granted' })
    expect(verdicts.get('d')?.files).toBe('granted')
  })
})

describe('probeMailAccess — the mail-only shorthand', () => {
  it('reads a `forbidden` as denied and a list as granted', async () => {
    const { client, calls } = clientAllowing({ c: EVERYTHING })
    const verdicts = await probeMailAccess(client, ['c', 'd'])
    expect(verdicts.get('c')).toBe('granted')
    expect(verdicts.get('d')).toBe('denied')
    // One call per account, and ONLY the mail one: asking about areas nobody is rendering would be
    // two thirds of a round trip spent on nothing.
    expect(calls[0]).toHaveLength(2)
    expect(calls[0]?.[0]?.[0]).toBe('Mailbox/get')
  })
})

describe('accountsWithArea — what a rail renders', () => {
  const accounts = [
    { id: 'b', name: 'alice@waxwing.test' },
    { id: 'd', name: 'carol@waxwing.test' },
  ]
  const access = (over: Partial<AreaAccess>): AreaAccess => ({
    mail: 'granted',
    contacts: 'granted',
    files: 'granted',
    ...over,
  })

  it('drops an account denied in THAT area and keeps it in the others', () => {
    const verdicts = new Map([['d', access({ contacts: 'denied' })]])
    expect(accountsWithArea(accounts, 'b', 'contacts', verdicts).map((a) => a.id)).toEqual(['b'])
    expect(accountsWithArea(accounts, 'b', 'files', verdicts).map((a) => a.id)).toEqual(['b', 'd'])
  })

  it('keeps everything while the probe has not answered', () => {
    // No flicker: the rail must not empty and refill on every reconnect.
    expect(accountsWithArea(accounts, 'b', 'mail', new Map()).map((a) => a.id)).toEqual(['b', 'd'])
  })

  it('never drops the user’s own account, even if the probe somehow refused it', () => {
    // The primary is where the user's own content is. A `denied` there means something is wrong
    // with the probe, not with the account, and blanking the rail is not the way to report it.
    const verdicts = new Map([
      ['b', access({ mail: 'denied' })],
      ['d', access({ mail: 'denied' })],
    ])
    expect(accountsWithArea(accounts, 'b', 'mail', verdicts).map((a) => a.id)).toEqual(['b'])
  })
})
