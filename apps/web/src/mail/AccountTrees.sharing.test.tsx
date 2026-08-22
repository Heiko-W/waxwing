/**
 * The mail rail against a server that ADVERTISES more than it will serve (S-4), and the incoming
 * share strip (S-1).
 *
 * Both suites exist because of one measurement against the live Stalwart v0.16.18 fixture on
 * 2026-08-21. carol shared a single CALENDAR with alice and nothing else; alice's session then
 * listed carol's account with **all seventeen** capabilities, `urn:ietf:params:jmap:mail` among
 * them, while `Mailbox/get { accountId: "d" }` answered
 * `error forbidden "You do not have access to account d"`.
 *
 * `secondaryMailAccounts()` reads that very capability and is documented as the strictest test the
 * session offers. So the sidebar grew a labelled "carol@waxwing.test" section over a folder tree
 * that could never fill — and this file is the only place that claim can be made, because in an
 * `AccountTrees` unit test without a session the probe does not run at all.
 */

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Invocation, JmapClient, MailAccount, ShareNotification } from '@waxwing/jmap'
import { MethodResponses } from '@waxwing/jmap'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '../app/config'
import { ConfigProvider } from '../app/config-context'
import { RouterProvider } from '../app/route'
import { SessionContext } from '../app/session/context'
import type { ConnectedSession, SessionContextValue } from '../app/session/types'
import { putMailboxes, type ReplicaDb, ReplicaProvider } from '../sync'
import { setActiveEngine } from '../sync/engine'
import { freshDb, mailbox } from '../sync/test-utils'
import { ToastProvider } from '../ui'
import { AccountTrees } from './AccountTrees'
import { useActiveAccountStore } from './active-account'
import { EMPTY_LIST_STATE, useListStore } from './list-store'
import { useReadingStore } from './reading-store'

const OWN: MailAccount = {
  id: 'b',
  name: 'alice@waxwing.test',
  isPersonal: true,
  isReadOnly: false,
}
/** Carol. In the session with the full capability set — because she shared a CALENDAR. */
const CAROL: MailAccount = {
  id: 'd',
  name: 'carol@waxwing.test',
  isPersonal: false,
  isReadOnly: false,
}

const FORBIDDEN = { type: 'forbidden', description: 'You do not have access to account d' }

interface FakeOptions {
  /** Accounts whose `Mailbox/get` the server will serve. */
  readonly mailFor?: readonly string[]
  readonly notifications?: readonly ShareNotification[]
}

const destroyed: string[] = []

function fakeClient({ mailFor = [], notifications = [] }: FakeOptions): JmapClient {
  return {
    // The measured shape: carol's account carries the FULL capability set — seventeen URNs on the
    // fixture — because she shared a calendar. The mail one is there and it is a lie.
    session: {
      username: 'alice@waxwing.test',
      accounts: {
        b: { name: 'alice@waxwing.test', isPersonal: true, accountCapabilities: {} },
        d: {
          name: 'carol@waxwing.test',
          isPersonal: false,
          accountCapabilities: {
            'urn:ietf:params:jmap:mail': {},
            'urn:ietf:params:jmap:calendars': {},
            'urn:ietf:params:jmap:principals': { currentUserPrincipalId: 'b' },
          },
        },
      },
    },
    call: async (invocations: Invocation[]) => {
      const responses: Invocation[] = invocations.map(([name, args, callId]) => {
        const accountId = (args as { accountId: string }).accountId
        if (name === 'Mailbox/get') {
          return mailFor.includes(accountId)
            ? ['Mailbox/get', { accountId, state: 's', list: [], notFound: [] }, callId]
            : ['error', FORBIDDEN, callId]
        }
        if (name === 'ShareNotification/get') {
          return [
            'ShareNotification/get',
            { accountId, state: 's', list: [...notifications], notFound: [] },
            callId,
          ]
        }
        if (name === 'ShareNotification/set') {
          destroyed.push(...((args as { destroy?: string[] }).destroy ?? []))
          return ['ShareNotification/set', { accountId, destroyed: [] }, callId]
        }
        return ['error', { type: 'unknownMethod' }, callId]
      })
      return new MethodResponses(responses, 's0', undefined)
    },
  } as unknown as JmapClient
}

function notification(overrides: Partial<ShareNotification> = {}): ShareNotification {
  return {
    id: 'n1',
    created: '2026-08-21T18:02:09Z',
    // What the fixture really sends for a mailbox ACL change — the granting user's own `Mailbox/set`
    // arrives attributed to the server's recovery admin. See `sharing/incoming.ts`.
    changedBy: { principalId: 'd333333', name: 'Recovery admin account', email: 'admin' },
    objectType: 'Mailbox',
    objectAccountId: 'd',
    objectId: 'a',
    oldRights: {},
    newRights: { mayReadItems: true },
    name: '',
    ...overrides,
  }
}

let db: ReplicaDb

beforeEach(async () => {
  db = freshDb()
  destroyed.length = 0
  setActiveEngine({ dispatch: vi.fn() } as unknown as Parameters<typeof setActiveEngine>[0])
  useActiveAccountStore.getState().reset()
  useListStore.setState(EMPTY_LIST_STATE)
  useReadingStore.setState({ handlers: null })
  await putMailboxes(db, 'b', [mailbox('a', { role: 'inbox', name: 'Inbox' })])
  await putMailboxes(db, 'd', [mailbox('a', { role: 'inbox', name: 'Inbox' })])
})

afterEach(async () => {
  setActiveEngine(null)
  useActiveAccountStore.getState().reset()
  await db.delete()
})

function renderRail(client: JmapClient, accounts: readonly MailAccount[] = [OWN, CAROL]): void {
  const connected = {
    client,
    jmapSession: client.session,
    accountId: 'b',
    accounts,
    username: 'alice@waxwing.test',
    method: 'basic',
  } as unknown as ConnectedSession
  const value = { status: 'ready', connected } as unknown as SessionContextValue
  const wrap = (children: ReactNode) => (
    <RouterProvider>
      <ConfigProvider config={DEFAULT_CONFIG}>
        <SessionContext.Provider value={value}>
          <ToastProvider>
            <ReplicaProvider accountId="b" db={db}>
              {children}
            </ReplicaProvider>
          </ToastProvider>
        </SessionContext.Provider>
      </ConfigProvider>
    </RouterProvider>
  )
  render(wrap(<AccountTrees accounts={accounts} primaryAccountId="b" />))
}

describe('a shared account that has no mail in it', () => {
  /*
   * The probe MOVED (S-4). It used to run inside this rail, which narrowed what was on screen and
   * left the real damage in place: the engine fleet reads `connected.accounts` and renders nothing,
   * so it went on starting a sync engine for an account every request to which comes back
   * `forbidden`. It now runs once in `SessionProvider`, and `connected.accounts` arrives narrowed.
   *
   * So the claim itself lives in `app/session/delegation.test.ts` — including "and no sync engine
   * starts for it", which no assertion about a sidebar could ever have made. What is left to check
   * here is that the rail spends nothing asking the question a second time, and renders exactly the
   * accounts it is handed.
   */
  it('THE ONE: renders no section for an account the session already excluded', async () => {
    // The narrowed list: carol is in the SESSION (she shared a calendar) but not in `accounts`,
    // because the probe found her mail forbidden.
    renderRail(fakeClient({ mailFor: ['b'] }), [OWN])

    // The user's own folders are there — nothing about this may cost them their mail.
    expect(await screen.findByRole('treeitem', { name: /Inbox/ })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'carol@waxwing.test' })).not.toBeInTheDocument()

    // And with nothing shared left, the rail is back to the PASS-THROUGH: one ungrouped tree, no
    // account headings at all — byte-for-byte the single-account sidebar. A rail that had kept an
    // "alice@waxwing.test" heading over a lone tree would be a second regression hiding inside the
    // fix for the first.
    expect(screen.queryByRole('region', { name: 'alice@waxwing.test' })).not.toBeInTheDocument()
  })

  it('asks the server nothing of its own about which accounts have mail', async () => {
    // A rail that re-probed would spend a round trip per render of the sidebar. Every call this
    // component makes is a `ShareNotification` one (S-1).
    const client = fakeClient({ mailFor: ['b'] })
    const spy = vi.spyOn(client, 'call')
    renderRail(client, [OWN])
    expect(await screen.findByRole('treeitem', { name: /Inbox/ })).toBeInTheDocument()
    await waitFor(() => expect(spy).toHaveBeenCalled())
    for (const [invocations] of spy.mock.calls) {
      for (const [name] of invocations as Invocation[]) {
        expect(name).not.toBe('Mailbox/get')
      }
    }
  })

  it('renders a shared account the session did keep', async () => {
    renderRail(fakeClient({ mailFor: ['b', 'd'] }), [OWN, CAROL])
    expect(await screen.findByRole('region', { name: 'carol@waxwing.test' })).toBeInTheDocument()
  })
})

describe('the incoming-share strip (S-1)', () => {
  it('announces a share, naming the account rather than the server’s recovery admin', async () => {
    renderRail(fakeClient({ mailFor: ['b', 'd'], notifications: [notification()] }))
    const strip = await screen.findByRole('region', { name: 'New shares' })
    expect(strip).toHaveTextContent(/carol@waxwing\.test shared/i)
    // The attribution the wire really carried must never reach the screen.
    expect(strip).not.toHaveTextContent(/Recovery admin/i)
    // And the folder's NAME, which the server does not send (`name` is ""): it comes from the
    // replica row the fleet already synced for that account.
    await waitFor(() => expect(strip).toHaveTextContent(/Inbox/))
  })

  it('says a REVOKE is a revoke, and offers no Open button for it', async () => {
    renderRail(
      fakeClient({
        mailFor: ['b'],
        notifications: [
          notification({ oldRights: { mayReadItems: true }, newRights: { mayReadItems: false } }),
        ],
      }),
    )
    const strip = await screen.findByRole('region', { name: 'New shares' })
    expect(strip).toHaveTextContent(/withdrew/i)
    expect(within(strip).queryByRole('button', { name: 'Open' })).not.toBeInTheDocument()
  })

  it('destroys the notification server-side when hidden, not just locally', async () => {
    // RFC 9670 gives a notification no read flag: destroy IS "seen", and it is what makes the card
    // stay gone on the user's other devices.
    renderRail(fakeClient({ mailFor: ['b', 'd'], notifications: [notification()] }))
    const strip = await screen.findByRole('region', { name: 'New shares' })
    await userEvent.click(within(strip).getByRole('button', { name: 'Hide this notice' }))
    await waitFor(() => expect(destroyed).toEqual(['n1']))
    expect(screen.queryByRole('region', { name: 'New shares' })).not.toBeInTheDocument()
  })

  it('shows nothing at all when nothing was shared', async () => {
    renderRail(fakeClient({ mailFor: ['b'] }))
    await screen.findByRole('region', { name: 'alice@waxwing.test' })
    expect(screen.queryByRole('region', { name: 'New shares' })).not.toBeInTheDocument()
  })
})
