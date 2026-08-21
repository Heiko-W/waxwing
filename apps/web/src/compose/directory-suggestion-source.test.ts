/**
 * The organisation directory as a recipient source (S-5).
 *
 * Everything asserted here is a measurement against the live Stalwart v0.16.18 fixture on
 * 2026-08-21, taken as alice with no share of any kind in place:
 *
 *   Principal/get  {accountId:"b", ids:null}  → alice, bob, carol, imip1, imip2
 *   Principal/query {text:"Baker"}            → [c]        {text:"bak"}  → []
 *   Principal/query {text:"alice"}            → [b]        {text:"ali"}  → []
 *   Principal/query {text:"carol chen"}       → [d]        {text:"b*"}   → []
 *
 * The whole-word behaviour is the reason for the two-character floor and the 250 ms wait: a
 * per-keystroke search against a server that cannot answer a prefix is a round trip spent on
 * nothing. And the reason the failure path has a test of its own is that the local sources work
 * offline and this one does not — a directory that is down must cost the writer nothing.
 */

import type { Invocation, JmapClient, Principal } from '@waxwing/jmap'
import { MethodResponses, RequestBuilder } from '@waxwing/jmap'
import { describe, expect, it, vi } from 'vitest'
import {
  createDirectorySuggestionSource,
  DIRECTORY_MIN_CHARS,
  directorySuggestion,
  principalOrganization,
} from './directory-suggestion-source'
import type { RecipientSuggestion } from './recipient-suggestions'

function principal(over: Partial<Principal> & { id: string }): Principal {
  return {
    type: 'individual',
    name: `${over.id}@waxwing.test`,
    description: null,
    email: `${over.id}@waxwing.test`,
    ...over,
  } as Principal
}

/**
 * A client that answers `Principal/query` with every id and `Principal/get` with `list`.
 *
 * `request()`, not just `call()`: `searchPrincipals` builds one batch with a `#ids` back-reference,
 * which is what makes the whole search a single round trip.
 */
function fakeClient(list: readonly Principal[]) {
  const sent: Invocation[][] = []
  const handle = (invocations: Invocation[]): MethodResponses => {
    sent.push(invocations)
    const responses = invocations.map(
      ([name, , callId]): Invocation =>
        name === 'Principal/query'
          ? [
              'Principal/query',
              { accountId: 'b', queryState: 'q', ids: list.map((p) => p.id) },
              callId,
            ]
          : [
              'Principal/get',
              { accountId: 'b', state: 's', list: [...list], notFound: [] },
              callId,
            ],
    )
    return new MethodResponses(responses, 's0', undefined)
  }
  const client = {
    request: () => new RequestBuilder(async (builder) => handle(builder.invocations)),
    call: async (calls: Invocation[]) => handle(calls),
  } as unknown as JmapClient
  return { client, sent }
}

/** The addresses of a result list — the directory yields only addresses, never groups. */
const addresses = (results: readonly RecipientSuggestion[]): string[] =>
  results.map((entry) => (entry.kind === 'group' ? `group:${entry.uid}` : entry.email))

const ALICE = principal({ id: 'b', description: 'Alice Anderson' })
const BOB = principal({ id: 'c', description: 'Bob Baker' })

describe('createDirectorySuggestionSource', () => {
  it('turns a principal into an option with a name, an address and an organisation', async () => {
    const { client } = fakeClient([BOB])
    const source = createDirectorySuggestionSource({ client, accountId: 'b' })
    expect(await source.query('Baker', 6)).toEqual([
      { name: 'Bob Baker', email: 'c@waxwing.test', organization: 'waxwing.test' },
    ])
  })

  it('asks nothing below the two-character floor', async () => {
    const { client, sent } = fakeClient([BOB])
    const source = createDirectorySuggestionSource({ client, accountId: 'b' })
    expect(await source.query('b', 6)).toEqual([])
    expect(sent).toHaveLength(0)
    // …and does ask at exactly the floor, so the constant and the guard cannot drift apart.
    await source.query('b'.repeat(DIRECTORY_MIN_CHARS), 6)
    expect(sent).toHaveLength(1)
    // One batch, not two: the `Principal/get` addresses the query's answer by back-reference.
    expect(sent[0]).toHaveLength(2)
  })

  it('THE RULE: a failure answers empty and never throws', async () => {
    // The local sources are a replica read and work offline; this one is a round trip. If a
    // rejection escaped here it would take the whole listbox down with it — including the recents
    // and contacts the writer already had on screen.
    const client = {
      call: vi.fn(async () => {
        throw new Error('offline')
      }),
    } as unknown as JmapClient
    const source = createDirectorySuggestionSource({ client, accountId: 'b' })
    await expect(source.query('Baker', 6)).resolves.toEqual([])
  })

  it('answers empty without a session rather than pretending to search', async () => {
    const source = createDirectorySuggestionSource({ client: null, accountId: null })
    expect(await source.query('Baker', 6)).toEqual([])
  })

  it('excludes the writer themselves', async () => {
    const { client } = fakeClient([ALICE, BOB])
    const source = createDirectorySuggestionSource({
      client,
      accountId: 'b',
      selfPrincipalId: 'b',
    })
    expect(addresses(await source.query('waxwing', 6))).toEqual(['c@waxwing.test'])
  })

  it('honours the limit and drops duplicates by address', async () => {
    const twin = principal({ id: 'c2', email: 'c@waxwing.test', description: 'Bob again' })
    const { client } = fakeClient([BOB, twin, ALICE])
    const source = createDirectorySuggestionSource({ client, accountId: 'b' })
    expect(addresses(await source.query('waxwing', 2))).toEqual([
      'c@waxwing.test',
      'b@waxwing.test',
    ])
  })
})

describe('what a principal may become', () => {
  it('drops a group', () => {
    // Whether a grant to a group reaches its members is still unmeasured, and a distribution
    // address is exactly the recipient a writer cannot check after the fact.
    expect(directorySuggestion(principal({ id: 'e', type: 'group' }))).toBeUndefined()
  })

  it('drops a principal with no address — it can never become a recipient', () => {
    expect(directorySuggestion(principal({ id: 'f', email: null }))).toBeUndefined()
  })

  it('falls back to the address when the directory holds no display name', () => {
    const suggestion = directorySuggestion(principal({ id: 'g', description: null }))
    expect(suggestion?.name).toBeNull()
    expect(suggestion?.email).toBe('g@waxwing.test')
  })

  it('reads the organisation off the address, which is all a Principal carries', () => {
    // Stalwart's `Principal` has no `organization` property — measured. The mail domain is the
    // affiliation that exists.
    expect(principalOrganization('bob@waxwing.test')).toBe('waxwing.test')
    expect(principalOrganization('nonsense')).toBeUndefined()
  })
})
