/**
 * An engine for an account that shares CONTACTS OR A CALENDAR BUT NO MAIL (S-4).
 *
 * The measurement this file defends, taken against the live Stalwart v0.16.18 fixture on
 * 2026-09-05 with carol's address book shared to alice and nothing else:
 *
 * ```
 * AddressBook/get  200 list=1 ["Stalwart Address Book (carol@waxwing.test)"]
 * Calendar/get     200 list=1 ["Stalwart Calendar (carol@waxwing.test)"]
 * Mailbox/get      200 ERROR {"type":"forbidden","description":"You do not have access to account d"}
 * ```
 *
 * The whole client reads its PIM data out of the replica (M4.2 for contacts, K-8 for the calendar),
 * and only an engine writes there. So the S-4 rails — which list a delegated account's books and
 * calendars — could show a section for carol and never a row inside it, because no engine ran for
 * her account at all. Measured in the browser before this existed: the section rendered in under a
 * second and still said "No address books." thirty seconds later, while the request above was
 * returning the book to the very same session.
 *
 * Starting an engine is not enough on its own, and that is what the second test is for: the mail
 * legs OPEN the delta block, so an engine that runs them dies on the `forbidden` above before it
 * reaches the contacts leg — every pass, for ever. That is the mutation probe for
 * {@link SyncEngineDeps.syncMail}: remove the flag and this file goes red on the assertion that the
 * books arrived.
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

describe('a delegated account that serves contacts but no mail (S-4)', () => {
  it('THE ONE: its address books reach the replica, and the pass reports success', async () => {
    const port = pimOnlyPort()
    const engine = new SyncEngine(makeDeps(db, port, { syncMail: false }))

    engine.start()
    await waitFor(() => engine.getStatus().phase === 'idle' && engine.getStatus().isLeader)

    // The row the rail draws. Without an engine this table stayed empty and the section read
    // "No address books." for as long as the reader cared to look.
    expect(await db.addressBooks.get([ACC, 'book-1'])).toBeDefined()
    expect(engine.getStatus().error).toBeNull()
    // And the mail legs never even asked — the point of the flag, not a side effect of it.
    expect(port.calls).not.toContain('getMailboxes')
    expect(port.calls).not.toContain('getIdentities')
    expect(port.calls).toContain('getAddressBooks')

    await engine.stop()
  })

  it('MUTATION PROBE: with the mail legs on, the same account syncs NOTHING', async () => {
    /*
     * Drop `syncMail: false` — i.e. undo the fix — and this is what the account gets. It is the
     * behaviour that shipped: `Mailbox/get` throws, `runSyncPass` catches it as an ordinary
     * `deltaError`, sets `phase: 'error'` and schedules a retry that fails identically. The
     * contacts leg sits at the bottom of the same method and is never reached.
     */
    const port = pimOnlyPort()
    const engine = new SyncEngine(makeDeps(db, port))

    engine.start()
    await waitFor(() => engine.getStatus().phase === 'error')

    expect(await db.addressBooks.get([ACC, 'book-1'])).toBeUndefined()
    expect(port.calls).toContain('getMailboxes')
    expect(port.calls).not.toContain('getAddressBooks')

    await engine.stop()
  })
})
