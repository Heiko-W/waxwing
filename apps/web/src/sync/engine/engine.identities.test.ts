/**
 * A DELEGATED MAIL account whose `Identity/get` the server refuses.
 *
 * Measured against the live Stalwart v0.16.18 fixture on 2026-09-05, with carol's inbox shared to
 * alice read-only — 15 s of the client's own traffic for carol's account:
 *
 * ```
 * Mailbox/get@d      -> Mailbox/get
 * Identity/get@d     -> ERROR:forbidden
 * Mailbox/changes@d  -> Mailbox/changes
 * Identity/get@d     -> ERROR:forbidden        (and so on, four times in fifteen seconds)
 * AddressBook/get@d  -> called ONCE, by the delegation probe, and never by a sync
 * ```
 *
 * The refusal is correct behaviour: ADR-020 records that send-as from a delegated account is
 * refused by the server, so there are no identities to hand out. But `syncIdentities` sat unguarded
 * in the MIDDLE of the mail leg, so it threw out of the delta block and the pass ended in `error`
 * before the contacts, calendar and files legs — every pass, for ever, on every delegated mailbox.
 * The account's MAIL synced fine, because the legs above it had already run, so nothing about the
 * symptom pointed at identities: it looked like the contacts rail was broken.
 *
 * Older than S-4 and independent of it. See ADR-046.
 */

import { JmapMethodError, type Session } from '@waxwing/jmap'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ReplicaDb } from '../db'
import { addressBook, freshDb } from '../test-utils'
import type { BroadcastChannelLike } from './bus'
import { SyncEngine, type SyncEngineDeps } from './engine'
import type { LockManagerLike } from './leader'
import type { ChangesResult, EngineClock, JmapPort } from './types'

const ACC = 'd'

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
async function waitFor(predicate: () => boolean | Promise<boolean>, tries = 80): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (await predicate()) return
    await flush()
  }
  throw new Error('waitFor timed out')
}

const immediateLock: LockManagerLike = {
  request(_name, options, callback) {
    if (options.signal?.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'))
    return callback(undefined)
  },
}

const noopBus = (): BroadcastChannelLike => ({ postMessage() {}, close() {}, onmessage: null })

const emptyChanges = (state: string): ChangesResult => ({
  newState: state,
  hasMoreChanges: false,
  created: [],
  updated: [],
  destroyed: [],
})

/**
 * Stalwart's answer for an account the reader may not read mail in — the exact shape measured
 * above: HTTP 200 with a method-level `forbidden`, NOT a 401/403. That distinction is load-bearing.
 * A 401/403 is an auth expiry and routes to the re-auth funnel (FR-AUTH-06); this one must not, and
 * a fake that threw a bare `Error` would let a fix that only handles bare errors pass.
 */
function forbidden(method: string): never {
  throw new JmapMethodError(
    { type: 'forbidden', description: `You do not have access to account ${ACC}` },
    '0',
    method,
  )
}

/**
 * A port for a contacts-and-calendar-only account: every MAIL method refuses exactly as the server
 * does, everything else answers.
 *
 * A Proxy rather than a literal so the refusal is the DEFAULT. A hand-written fake has to remember
 * to refuse each new mail method, and a forgotten one turns this file green for the wrong reason —
 * the failure mode is silent, which is what the test is about in the first place.
 */
function pimOnlyPort(): JmapPort & { readonly calls: string[] } {
  const calls: string[] = []
  const answered: Partial<Record<keyof JmapPort, unknown>> = {
    accountId: ACC,
    getAddressBooks: async () => ({
      list: [addressBook('book-1', { name: 'Stalwart Address Book (carol@waxwing.test)' })],
      notFound: [],
      state: 'ab1',
    }),
    addressBookChanges: async (s: string) => emptyChanges(s),
    getContactCards: async () => ({ list: [], notFound: [], state: 'cc1' }),
    contactCardChanges: async (s: string) => emptyChanges(s),
    queryContactCards: async () => ({
      ids: [],
      queryState: 'q',
      canCalculateChanges: false,
      position: 0,
    }),
    getCalendars: async () => ({ list: [], notFound: [], state: 'cal1' }),
    calendarChanges: async (s: string) => emptyChanges(s),
    calendarEventChanges: async (s: string) => emptyChanges(s),
    queryCalendarEvents: async () => ({
      ids: [],
      queryState: 'q',
      canCalculateChanges: false,
      position: 0,
    }),
    getCalendarEvents: async () => ({ list: [], notFound: [], state: 'cev1' }),
  }
  const port = new Proxy(answered, {
    get(target, prop: string) {
      if (prop === 'calls') return calls
      if (prop === 'accountId') return ACC
      const own = target[prop as keyof JmapPort]
      return (...args: unknown[]) => {
        calls.push(prop)
        if (own === undefined) return forbidden(prop)
        return (own as (...a: unknown[]) => unknown)(...args)
      }
    },
  })
  return port as unknown as JmapPort & { readonly calls: string[] }
}

/** A push channel whose `fireStateChange()` drives a second pass — how a real sweep arrives. */
class FakePush {
  readonly transport = 'sse' as const
  status = 'closed' as const
  private listener: ((change: unknown) => void) | undefined
  open(): void {}
  close(): void {}
  subscribe(listener: (change: unknown) => void) {
    this.listener = listener
    return () => {
      this.listener = undefined
    }
  }
  onStatus() {
    return () => {}
  }
  onError() {
    return () => {}
  }
  fireStateChange(): void {
    this.listener?.({ '@type': 'StateChange', changed: { [ACC]: {} } })
  }
}

function makeDeps(
  db: ReplicaDb,
  port: JmapPort,
  over: Partial<SyncEngineDeps> = {},
  push: FakePush = new FakePush(),
) {
  let t = 1000
  const clock: EngineClock = {
    now: () => t++,
    setTimeout: () => 0,
    clearTimeout: () => {},
  }
  return {
    db,
    port,
    session: {} as Session,
    auth: { scheme: 'bearer' as const, authorization: () => 'x' },
    config: () => ({ cacheDays: 30, maxStorageMB: 512 }),
    clock,
    locks: immediateLock,
    createBus: noopBus,
    createPush: () => push,
    isOnline: () => true,
    onOnlineChange: () => () => {},
    foregroundAckMs: 10,
    ...over,
  } as unknown as SyncEngineDeps
}

let db: ReplicaDb

beforeEach(() => {
  db = freshDb()
})

describe('a delegated MAIL account whose identities the server refuses', () => {
  /*
   * The second half of the same measurement, and the one that is not S-4's fault at all.
   *
   * With carol's INBOX shared to alice read-only — the fixture's own delegation setup — carol is a
   * mail account by every test the client has, so she gets a full engine. Stalwart then answers
   * `Identity/get` on her account with `forbidden`, which is not a malfunction: ADR-020 records
   * that send-as from a delegated account is refused, so there are no identities to hand out.
   *
   * That refusal sat in the MIDDLE of the mail leg, so the pass died there — after the mailboxes,
   * before the address books. Measured over 15 s in the browser: `Mailbox/changes@d` and
   * `Identity/get@d -> ERROR:forbidden` alternating four times, and `AddressBook/get@d` called
   * exactly once (the delegation probe) and never by a sync. The account's MAIL worked, so nothing
   * about it looked broken; its contacts and calendar simply never arrived.
   */
  function mailAccountRefusingIdentities(): JmapPort & { readonly calls: string[] } {
    const port = pimOnlyPort()
    const withMail = new Proxy(port, {
      get(target, prop: string) {
        if (prop === 'getMailboxes') {
          return async () => {
            target.calls.push('getMailboxes')
            return { list: [], notFound: [], state: 'mb1' }
          }
        }
        if (prop === 'mailboxChanges' || prop === 'threadChanges' || prop === 'emailChanges') {
          return async (state: string) => {
            target.calls.push(prop)
            return emptyChanges(state)
          }
        }
        if (prop === 'queryEmails' || prop === 'queryEmailsWithEnvelopes') {
          return async () => {
            target.calls.push(prop)
            return {
              query: { ids: [], queryState: 'q', canCalculateChanges: false, position: 0 },
              envelopes: { list: [], notFound: [], state: 'e1' },
            }
          }
        }
        return Reflect.get(target, prop) as unknown
      },
    })
    return withMail as JmapPort & { readonly calls: string[] }
  }

  it('THE ONE: a forbidden Identity/get does not cost the account its contacts', async () => {
    const port = mailAccountRefusingIdentities()
    const engine = new SyncEngine(makeDeps(db, port))

    engine.start()
    await waitFor(() => engine.getStatus().phase === 'idle' && engine.getStatus().isLeader)

    // Past the refusal, all the way to the leg that was unreachable.
    expect(await db.addressBooks.get([ACC, 'book-1'])).toBeDefined()
    expect(engine.getStatus().error).toBeNull()

    await engine.stop()
  })

  it('asks once and lets it go — a permanent refusal is not retried every sweep', async () => {
    const port = mailAccountRefusingIdentities()
    const push = new FakePush()
    const engine = new SyncEngine(makeDeps(db, port, {}, push))

    engine.start()
    await waitFor(() => engine.getStatus().phase === 'idle')
    const afterFirst = port.calls.filter((call) => call === 'getIdentities').length

    // Two more passes, the way they really arrive.
    push.fireStateChange()
    await waitFor(() => engine.getStatus().phase === 'idle')
    push.fireStateChange()
    await waitFor(() => engine.getStatus().phase === 'idle')

    expect(afterFirst).toBe(1)
    expect(port.calls.filter((call) => call === 'getIdentities')).toHaveLength(1)

    await engine.stop()
  })
})
