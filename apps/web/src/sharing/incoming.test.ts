/**
 * Reading a `ShareNotification` (S-1) — against the shapes the server really sends, not the ones
 * the RFC implies.
 *
 * Every fixture below is a real response from the Stalwart v0.16.18 fixture on 2026-08-21, and
 * three of them are the reason this module exists at all: `name` is empty, `changedBy` can name the
 * server's own recovery admin, and a REVOKE arrives on the same channel as a grant.
 */

import type { Invocation, JmapClient, ShareNotification } from '@waxwing/jmap'
import { MethodResponses } from '@waxwing/jmap'
import { describe, expect, it, vi } from 'vitest'
import { byNewestFirst, describeShare, makeIncomingSharesClient } from './incoming'

const FULL = {
  mayReadItems: true,
  mayAddItems: true,
  mayRemoveItems: true,
  maySetSeen: true,
  maySetKeywords: true,
  mayCreateChild: true,
  mayRename: true,
  maySubmit: true,
  mayDelete: true,
  mayShare: true,
}
const NONE = Object.fromEntries(Object.keys(FULL).map((key) => [key, false]))

/** Verbatim from the wire: a mailbox share, attributed by the server to its recovery admin. */
function mailboxGrant(overrides: Partial<ShareNotification> = {}): ShareNotification {
  return {
    id: 'ja7ashwaaoqa',
    name: '',
    changedBy: { principalId: 'd333333', name: 'Recovery admin account', email: 'admin' },
    created: '2026-08-21T18:02:09Z',
    objectAccountId: 'd',
    objectId: 'a',
    objectType: 'Mailbox',
    oldRights: NONE,
    newRights: { ...NONE, mayReadItems: true },
    ...overrides,
  }
}

/** Verbatim from the wire: a calendar share, where the attribution IS right. */
function calendarGrant(): ShareNotification {
  return {
    id: 'jaz1l11sadaa',
    name: '',
    changedBy: { principalId: 'd', name: 'Carol Chen (Waxwing e2e)', email: 'carol@waxwing.test' },
    created: '2026-08-21T17:42:57Z',
    objectAccountId: 'd',
    objectId: 'b',
    objectType: 'Calendar',
    oldRights: NONE,
    newRights: { mayReadItems: true },
  }
}

describe('who did it', () => {
  it('prefers the account name the caller resolved from the session', () => {
    // The only source here that is reliably right. `objectAccountId` is what the session lists by
    // name; `changedBy` is a guess the server sometimes gets wrong.
    const described = describeShare(mailboxGrant(), 'carol@waxwing.test')
    expect(described.who).toBe('carol@waxwing.test')
  })

  it('NEVER names the server’s recovery admin, even with nothing else to say', () => {
    /*
     * The measured defect. carol's own `Mailbox/set` arrived as
     * `{ principalId: "d333333", name: "Recovery admin account", email: "admin" }` — a `Calendar/set`
     * from the same account, in the same session, was attributed to Carol correctly. "Recovery admin
     * account shared a folder with you" tells the reader a person did something they did not do.
     */
    expect(describeShare(mailboxGrant()).who).toBeNull()
  })

  it('does use changedBy when it names a real person', () => {
    expect(describeShare(calendarGrant()).who).toBe('Carol Chen (Waxwing e2e)')
  })

  it('reads an empty name as nobody rather than as an empty card', () => {
    const anonymous = mailboxGrant({ changedBy: { principalId: 'x', name: '', email: '' } })
    expect(describeShare(anonymous).who).toBeNull()
  })
})

describe('what happened', () => {
  it('reads any right at all as a grant', () => {
    expect(describeShare(mailboxGrant()).change).toBe('granted')
  })

  it('reads all-false newRights as a REVOKE', () => {
    // Access being taken away arrives on the same channel as access being given. Announcing it as a
    // share, with an Open button that leads to `forbidden`, is the outcome worth branching for.
    const revoked = mailboxGrant({ oldRights: FULL, newRights: NONE })
    expect(describeShare(revoked).change).toBe('revoked')
  })

  it('reads an ABSENT newRights as a revoke too', () => {
    const revoked = mailboxGrant({ oldRights: FULL, newRights: null })
    expect(describeShare(revoked).change).toBe('revoked')
  })
})

describe('where it is', () => {
  it('carries both halves of the address — a mailbox id alone is ambiguous', () => {
    // Per-account short ids collide: `a` is the Inbox in nearly every account on this server, so a
    // card that carried only `objectId` would open the wrong folder as often as the right one.
    const described = describeShare(mailboxGrant())
    expect(described.accountId).toBe('d')
    expect(described.objectId).toBe('a')
  })
})

describe('order', () => {
  it('puts the newest first', () => {
    const older = describeShare(calendarGrant())
    const newer = describeShare(mailboxGrant())
    expect([older, newer].sort(byNewestFirst).map((entry) => entry.id)).toEqual([
      newer.id,
      older.id,
    ])
  })
})

describe('the client', () => {
  function recorder(list: ShareNotification[]) {
    const calls: Invocation[][] = []
    const client = {
      call: vi.fn(async (invocations: Invocation[]) => {
        calls.push(invocations)
        const responses: Invocation[] = invocations.map(([name, args, callId]) => [
          name,
          { accountId: (args as { accountId: string }).accountId, state: 's', list, notFound: [] },
          callId,
        ])
        return new MethodResponses(responses, 's0', undefined)
      }),
    } as unknown as JmapClient
    return { client, calls }
  }

  it('fetches from the user’s OWN account — notifications live with the grantee', async () => {
    // Not `objectAccountId`. The notification is addressed to the person who received the share, and
    // asking carol's account for it would be a `forbidden` at best.
    const { client, calls } = recorder([mailboxGrant()])
    await makeIncomingSharesClient(client, 'b').list()
    expect(calls[0]?.[0]?.[0]).toBe('ShareNotification/get')
    expect((calls[0]?.[0]?.[1] as { accountId: string }).accountId).toBe('b')
  })

  it('dismisses by DESTROYING — the RFC gives a notification no read flag', async () => {
    const { client, calls } = recorder([])
    await makeIncomingSharesClient(client, 'b').dismiss(['n1', 'n2'])
    expect(calls[0]?.[0]?.[0]).toBe('ShareNotification/set')
    expect((calls[0]?.[0]?.[1] as { destroy: string[] }).destroy).toEqual(['n1', 'n2'])
  })

  it('sends nothing for an empty dismiss', async () => {
    const { client, calls } = recorder([])
    await makeIncomingSharesClient(client, 'b').dismiss([])
    expect(calls).toHaveLength(0)
  })
})
