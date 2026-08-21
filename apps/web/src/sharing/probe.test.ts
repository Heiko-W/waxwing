/**
 * The probe that stops a shared CALENDAR from growing a mail section (S-4, applied to the mail rail).
 *
 * The scenario every test here is built on was measured against the live Stalwart v0.16.18 fixture
 * on 2026-08-21, and it is the single most surprising fact in the whole sharing package:
 *
 *   carol shared ONE CALENDAR with alice, and nothing else.
 *   alice's session then listed carol's account `d` with **all seventeen** capabilities,
 *   `urn:ietf:params:jmap:mail` among them.
 *   `Mailbox/get { accountId: "d" }` → `error forbidden "You do not have access to account d"`.
 *
 * `secondaryMailAccounts()` reads exactly that capability, and is documented at length as the
 * strictest test the session offers. It is still a false positive here — so the rail's own
 * assertion, "a fully-capable account that refuses `Mailbox/get` produces no section", cannot be
 * checked anywhere but here.
 */

import type { Invocation, JmapClient } from '@waxwing/jmap'
import { describe, expect, it, vi } from 'vitest'
import { accountsWithMail, probeMailAccess } from './probe'

const FORBIDDEN = { type: 'forbidden', description: 'You do not have access to account d' }

/**
 * A client whose `Mailbox/get` succeeds only for the listed accounts.
 *
 * Deliberately answers EVERY call in the batch, including the refused ones — that is what the server
 * does, and the whole one-batch design rests on it (measured: five calls, three `forbidden`, five
 * responses back). A fake that dropped the failures would let a broken implementation pass.
 */
function clientAllowing(allowed: readonly string[]): { client: JmapClient; calls: Invocation[][] } {
  const calls: Invocation[][] = []
  const client = {
    call: vi.fn(async (invocations: Invocation[]) => {
      calls.push(invocations)
      const responses: Invocation[] = invocations.map(([, args, callId]) => {
        const accountId = (args as { accountId: string }).accountId
        return allowed.includes(accountId)
          ? ['Mailbox/get', { accountId, state: 's', list: [], notFound: [] }, callId]
          : ['error', FORBIDDEN, callId]
      })
      // The real `MethodResponses`, so `get()` throws on an error entry exactly as it does live.
      const { MethodResponses } = await import('@waxwing/jmap')
      return new MethodResponses(responses, 's0', undefined)
    }),
  } as unknown as JmapClient
  return { client, calls }
}

describe('probeMailAccess', () => {
  it('spends ONE request for every account, whatever the answers', async () => {
    const { client, calls } = clientAllowing(['b'])
    await probeMailAccess(client, ['b', 'c', 'd', 'e'])
    expect(calls).toHaveLength(1)
    expect(calls[0]).toHaveLength(4)
  })

  it('reads a `forbidden` as denied and a list as granted', async () => {
    const { client } = clientAllowing(['c'])
    const verdicts = await probeMailAccess(client, ['c', 'd'])
    expect(verdicts.get('c')).toBe('granted')
    expect(verdicts.get('d')).toBe('denied')
  })

  it('asks for no mailboxes at all — the access check is the point', async () => {
    // `ids: []` is refused identically to `ids: null` (measured), so the probe costs the server the
    // lookup and nothing else.
    const { client, calls } = clientAllowing(['b'])
    await probeMailAccess(client, ['b'])
    const args = calls[0]?.[0]?.[1] as { ids: unknown; properties: unknown }
    expect(args.ids).toEqual([])
    expect(args.properties).toEqual(['id'])
  })

  it('sends nothing at all when there is nothing to probe', async () => {
    const { client, calls } = clientAllowing([])
    expect(await probeMailAccess(client, [])).toEqual(new Map())
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
    const verdicts = await probeMailAccess(client, ['c', 'd'])
    expect(verdicts.get('c')).toBe('granted')
    expect(verdicts.get('d')).toBe('granted')
  })
})

describe('accountsWithMail — what the rail renders', () => {
  const accounts = [
    { id: 'b', name: 'alice@waxwing.test' },
    { id: 'd', name: 'carol@waxwing.test' },
  ]

  it('THE ONE: a fully-capable account that refuses Mailbox/get gets no section', () => {
    // carol advertises mail because she shared a calendar. She has not shared any mail.
    const verdicts = new Map([['d', 'denied' as const]])
    expect(accountsWithMail(accounts, 'b', verdicts).map((a) => a.id)).toEqual(['b'])
  })

  it('keeps an account the server did serve', () => {
    const verdicts = new Map([['d', 'granted' as const]])
    expect(accountsWithMail(accounts, 'b', verdicts).map((a) => a.id)).toEqual(['b', 'd'])
  })

  it('keeps everything while the probe has not answered', () => {
    // No flicker: the rail must not empty and refill on every reconnect.
    expect(accountsWithMail(accounts, 'b', new Map()).map((a) => a.id)).toEqual(['b', 'd'])
  })

  it('never drops the user’s own account, even if the probe somehow refused it', () => {
    // The primary is where the user's mail is. A `denied` there means something is wrong with the
    // probe, not with the account, and blanking the sidebar is not the way to report it.
    const verdicts = new Map([
      ['b', 'denied' as const],
      ['d', 'denied' as const],
    ])
    expect(accountsWithMail(accounts, 'b', verdicts).map((a) => a.id)).toEqual(['b'])
  })
})
