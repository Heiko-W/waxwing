/**
 * JMAP Sharing (RFC 9670) against the live Stalwart fixture — M5.18.
 *
 * These exist because the unit tests cannot catch the thing that actually went wrong here. The
 * RFC defines a `name` filter for `Principal/query`; Stalwart answers it with an empty list and a
 * 200. A picker built on it would have shipped as a search box that finds nobody, with no error
 * anywhere to say why. The first test below is that measurement, written down so it stays true —
 * and so that the day Stalwart implements `name`, the change is visible rather than silent.
 *
 * The second reason is `shareWith` itself: the server normalises a partial grant into all six
 * rights. `sharing.ts` is built on that being true, and this is where it is checked against the
 * server rather than against a mock that agrees with us by construction.
 */

import {
  basic,
  Capabilities,
  getSession,
  JmapClient,
  Methods,
  principalSearchFilter,
} from '@waxwing/jmap'
import { beforeAll, describe, expect, it } from 'vitest'

const BASE = 'http://localhost:18080'
const PASSWORD = 'waxwing-e2e-Pw1!'
const auth = basic('alice@waxwing.test', PASSWORD)

const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
const FOLDER = `waxwing-share-${RUN_ID}`

let client: JmapClient
let accountId: string
let selfPrincipalId: string | null
let bobPrincipalId: string

beforeAll(async () => {
  const session = await getSession(BASE, auth)
  accountId = session.primaryAccounts[Capabilities.mail] ?? ''
  client = new JmapClient({ session, auth, sessionUrl: BASE })

  const capability = session.accounts?.[accountId]?.accountCapabilities?.[
    Capabilities.principals
  ] as { currentUserPrincipalId?: string } | undefined
  selfPrincipalId = capability?.currentUserPrincipalId ?? null

  const responses = await client.call([
    [Methods.principalQuery.name, { accountId, filter: { email: 'bob@waxwing.test' } }, 'p0'],
  ])
  bobPrincipalId = responses.get<{ ids: string[] }>('p0').ids[0] ?? ''
}, 30_000)

describe('M5.18 · finding someone to share with', () => {
  it('advertises the principals capability and the current user within it', () => {
    // Without `currentUserPrincipalId` a picker cannot tell which row is the user themself.
    expect(selfPrincipalId, 'currentUserPrincipalId').not.toBeNull()
  })

  it('finds a person by the `text` filter this client actually sends', async () => {
    const responses = await client.call([
      [Methods.principalQuery.name, { accountId, filter: principalSearchFilter('bob') }, 'p0'],
    ])
    expect(responses.get<{ ids: string[] }>('p0').ids).toContain(bobPrincipalId)
  })

  it('finds NOBODY by the RFC 9670 `name` filter — the measurement this client is built on', async () => {
    // If this ever starts returning bob, Stalwart has implemented `name` and
    // `principalSearchFilter` can be revisited. Until then it is why that function exists.
    const responses = await client.call([
      [Methods.principalQuery.name, { accountId, filter: { name: 'bob' } }, 'p0'],
    ])
    expect(responses.get<{ ids: string[] }>('p0').ids).toEqual([])
  })

  it('lists everyone for an empty query rather than nothing', async () => {
    const responses = await client.call([
      [Methods.principalQuery.name, { accountId, filter: principalSearchFilter('   ') }, 'p0'],
    ])
    // alice, bob, carol — the fixture's three accounts.
    expect(responses.get<{ ids: string[] }>('p0').ids.length).toBeGreaterThanOrEqual(3)
  })

  it('returns a name and an address to show for a found principal', async () => {
    const responses = await client.call([
      [Methods.principalGet.name, { accountId, ids: [bobPrincipalId] }, 'p0'],
    ])
    const principal = responses.get<{ list: { name?: string; email?: string }[] }>('p0').list[0]
    expect(principal?.email).toBe('bob@waxwing.test')
    expect(principal?.name).toBeTruthy()
  })
})

describe('M5.18 · granting access to a file node', () => {
  let nodeId = ''

  it('creates a folder to share', async () => {
    const responses = await client.call([
      [
        Methods.fileNodeSet.name,
        { accountId, create: { f: { name: FOLDER, nodeType: 'directory', parentId: null } } },
        'f0',
      ],
    ])
    nodeId = responses.get<{ created: Record<string, { id: string }> }>('f0').created?.f?.id ?? ''
    expect(nodeId).toBeTruthy()
  })

  it('fills a PARTIAL grant out to all six rights — which `sharing.ts` relies on', async () => {
    // Sent: mayRead alone. Expected back: every right, the rest explicitly false. A client that
    // assumed the server echoes what it sent would mis-read every grant it did not write itself.
    const responses = await client.call([
      [
        Methods.fileNodeSet.name,
        { accountId, update: { [nodeId]: { shareWith: { [bobPrincipalId]: { mayRead: true } } } } },
        'f0',
      ],
      [Methods.fileNodeGet.name, { accountId, ids: [nodeId], properties: ['shareWith'] }, 'f1'],
    ])
    const node = responses.get<{ list: { shareWith: Record<string, unknown> }[] }>('f1').list[0]
    expect(node?.shareWith[bobPrincipalId]).toEqual({
      mayRead: true,
      mayAddChildren: false,
      mayRename: false,
      mayDelete: false,
      mayModifyContent: false,
      mayShare: false,
    })
  })

  it('revokes by writing the map WITHOUT that principal', async () => {
    const responses = await client.call([
      [Methods.fileNodeSet.name, { accountId, update: { [nodeId]: { shareWith: {} } } }, 'f0'],
      [Methods.fileNodeGet.name, { accountId, ids: [nodeId], properties: ['shareWith'] }, 'f1'],
    ])
    const node = responses.get<{ list: { shareWith: Record<string, unknown> }[] }>('f1').list[0]
    expect(node?.shareWith).toEqual({})
  })

  it('cleans up after itself', async () => {
    const responses = await client.call([
      [Methods.fileNodeSet.name, { accountId, destroy: [nodeId] }, 'f0'],
    ])
    expect(responses.get<{ destroyed: string[] }>('f0').destroyed).toContain(nodeId)
  })
})
