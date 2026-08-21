/**
 * The sharing seam of `@waxwing/jmap` (S-1, S-3, S-7), and the two traps it exists to not fall into.
 *
 * Every assertion here is a measurement against the Stalwart v0.16.18 fixture on `:18080`, taken on
 * 2026-08-21 and written down as a test so a future edit has to argue with the server rather than
 * with an opinion.
 */

import { describe, expect, it } from 'vitest'
import { bearer } from './auth'
import { Capabilities, capabilityForMethod, usingForMethods } from './capabilities'
import { JmapClient } from './client'
import { Methods } from './methods'
import { at, jmapPostMock, makeSession } from './test-support'
import type { Mailbox, MailboxRights } from './types/mail'
import { SHARE_NOTIFICATION_TYPE } from './types/principal'

/**
 * The ten permission keys Stalwart v0.16.18 accepts inside `Mailbox.shareWith`.
 *
 * Measured, not copied from RFC 8621: the RFC lists nine and this server takes a tenth, `mayShare`.
 * An eleventh, invented key (`mayFlibber`) is refused PER OBJECT with
 * `invalidProperties: 'Invalid permission "mayFlibber"'` — the request survives, the grant does not.
 */
const MEASURED_RIGHT_KEYS = [
  'mayReadItems',
  'mayAddItems',
  'mayRemoveItems',
  'maySetSeen',
  'maySetKeywords',
  'mayCreateChild',
  'mayRename',
  'mayDelete',
  'maySubmit',
  'mayShare',
] as const satisfies readonly (keyof MailboxRights)[]

describe('S-7 — `Principal/set` must never reach a batch', () => {
  /*
   * Not a style rule. Measured: a request whose method list contains `Principal/set` comes back
   * HTTP 400 `urn:ietf:params:jmap:error:notRequest` with NO `methodResponses` at all — every other
   * call in the same batch is destroyed with it. `forbidden`, by contrast, is a per-call error and
   * leaves its siblings alone (see below). So there is no "just handle the error" version of this:
   * the only safe handling is not to have the method.
   *
   * The guard is on `Methods` rather than on a grep, because `Methods` is the only door: `call()`
   * takes raw invocations, but every caller in this repo builds them from this map, and a method
   * that is not in it cannot be typed into a `builder.invoke`.
   */
  it('has no `Principal/set` in the method map', () => {
    const names = Object.values(Methods).map((method) => method.name)
    expect(names).not.toContain('Principal/set')
  })

  it('has no `principalSet` entry to reach for', () => {
    expect(Methods).not.toHaveProperty('principalSet')
  })
})

describe('the mail-sharing URN is opt-in, never automatic', () => {
  /*
   * The trap: `urn:ietf:params:jmap:mail:share` looks like it belongs next to `Mailbox` in
   * `PREFIX_TO_CAPABILITY`. Putting it there would add it to the `using` of EVERY mailbox request —
   * and an unknown `using` entry is a REQUEST-level refusal on this server (measured: HTTP 400
   * `notRequest`, same shape as `Principal/set`). A server without the extension would lose its
   * whole mail sync to a URN sent on its behalf, so the constant exists and the mapping does not.
   */
  it('is not what a `Mailbox/*` call opts into', () => {
    expect(capabilityForMethod('Mailbox/get')).toBe(Capabilities.mail)
    expect(capabilityForMethod('Mailbox/set')).toBe(Capabilities.mail)
  })

  it('is absent from the derived `using` set of a mailbox batch', () => {
    expect(usingForMethods(['Mailbox/get', 'Mailbox/set'])).toEqual([
      Capabilities.core,
      Capabilities.mail,
    ])
  })

  it('can still be added per call, for a server that demands it', async () => {
    const mock = jmapPostMock(() => ({
      methodResponses: [
        ['Mailbox/get', { accountId: 'a', state: 's', list: [], notFound: [] }, '0'],
      ],
      sessionState: 's0',
    }))
    const client = new JmapClient({ session: makeSession(), auth: bearer('t'), fetch: mock.fetch })
    await client.call([[Methods.mailboxGet.name, { accountId: 'a', ids: null }, '0']], {
      using: [Capabilities.mailShare],
    })
    expect(at(mock.calls, 0).body.using).toContain(Capabilities.mailShare)
  })
})

describe('`Mailbox` carries the sharing properties it is sent', () => {
  /*
   * A type test with teeth: before this, `myRights.mayShare` and `shareWith` were absent from the
   * interface while arriving on every wire response, so the one right that decides whether a
   * "Share…" affordance may be offered could not be read without a cast.
   */
  it('types every measured permission key on `myRights`', () => {
    const rights: MailboxRights = {
      mayReadItems: true,
      mayAddItems: false,
      mayRemoveItems: false,
      maySetSeen: false,
      maySetKeywords: false,
      mayCreateChild: false,
      mayRename: false,
      mayDelete: false,
      maySubmit: false,
      mayShare: false,
    }
    expect(Object.keys(rights).sort()).toEqual([...MEASURED_RIGHT_KEYS].sort())
  })

  it('types `shareWith` as principal id → the full rights map', () => {
    const shared: Pick<Mailbox, 'shareWith'> = {
      shareWith: {
        b: {
          mayReadItems: true,
          mayAddItems: false,
          mayRemoveItems: false,
          maySetSeen: false,
          maySetKeywords: false,
          mayCreateChild: false,
          mayRename: false,
          mayDelete: false,
          maySubmit: false,
          mayShare: false,
        },
      },
    }
    expect(shared.shareWith?.b?.mayReadItems).toBe(true)
  })
})

describe('S-1 — the ShareNotification methods a client actually needs', () => {
  it('offers get, changes, query and set', () => {
    expect(Methods.shareNotificationGet.name).toBe('ShareNotification/get')
    expect(Methods.shareNotificationChanges.name).toBe('ShareNotification/changes')
    expect(Methods.shareNotificationQuery.name).toBe('ShareNotification/query')
    expect(Methods.shareNotificationSet.name).toBe('ShareNotification/set')
  })

  it('opts every one of them into the principals capability, not mail', () => {
    for (const verb of ['get', 'changes', 'query', 'set']) {
      expect(capabilityForMethod(`ShareNotification/${verb}`)).toBe(Capabilities.principals)
    }
  })

  /*
   * Measured over a WebSocket against v0.16.18: carol's `Mailbox/set … shareWith` produced
   * `{"@type":"StateChange","changed":{"b":{"ShareNotification":"sqcwidwels9imcba"}}}` on ALICE's
   * connection — her own account id, a type name of its own, arriving without any poll. That is why
   * the incoming-shares surface listens instead of polling, and why this name has to be in the push
   * subscription's `types` (a server filters out what was not asked for).
   */
  it('names the push type the server really sends', () => {
    expect(SHARE_NOTIFICATION_TYPE).toBe('ShareNotification')
  })
})

describe('`forbidden` is local — the whole probe design rests on it', () => {
  /*
   * The measurement that makes one probe batch enough: five calls, three of them refused with
   * `forbidden`, returned ALL FIVE method responses. If the refusal were request-level (as
   * `Principal/set` and an unknown `using` URN both are) a client would have to spend one round
   * trip per account per type to find out what is shared.
   */
  it('returns a response for every call, refused or not', async () => {
    const mock = jmapPostMock(() => ({
      methodResponses: [
        ['Mailbox/get', { accountId: 'd', state: 's', list: [{ id: 'a' }], notFound: [] }, '0'],
        ['error', { type: 'forbidden', description: 'You do not have access to account d' }, '1'],
        ['error', { type: 'forbidden', description: 'You do not have access to account d' }, '2'],
      ],
      sessionState: 's0',
    }))
    const client = new JmapClient({ session: makeSession(), auth: bearer('t'), fetch: mock.fetch })
    const responses = await client.call([
      [Methods.mailboxGet.name, { accountId: 'd', ids: null }, '0'],
      [Methods.addressBookGet.name, { accountId: 'd', ids: null }, '1'],
      [Methods.calendarGet.name, { accountId: 'd', ids: null }, '2'],
    ])
    expect(() => responses.get<{ list: unknown[] }>('0')).not.toThrow()
    expect(() => responses.get('1')).toThrow()
    expect(() => responses.get('2')).toThrow()
  })
})
