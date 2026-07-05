import { describe, expect, it, vi } from 'vitest'
import { bearer } from './auth'
import { JmapClient } from './client'
import { at, autoRespond, jmapPostMock, makeSession } from './test-support'
import type { FetchLike } from './transport'
import type {
  GetResponse,
  Invocation,
  JmapRequest,
  JmapResponse,
  QueryResponse,
} from './types/core'

describe('JmapClient — envelope, auth and using', () => {
  it('POSTs to apiUrl with the auth header and an auto-derived using set', async () => {
    const { fetch, calls } = jmapPostMock((body) => autoRespond(body))
    const client = new JmapClient({ session: makeSession(), auth: bearer('tok-123'), fetch })

    const builder = client.request()
    builder.call('Email/query', { accountId: 'a' })
    await builder.send()

    const recorded = at(calls, calls.length - 1)
    expect(recorded.url).toBe('https://mail.waxwing.test/jmap/api')
    expect(recorded.headers.Authorization).toBe('Bearer tok-123')
    expect(recorded.headers['Content-Type']).toBe('application/json')
    expect(recorded.body.using).toEqual(['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'])
  })

  it('Core/echo round-trips its arguments', async () => {
    const { fetch } = jmapPostMock((body) => autoRespond(body))
    const client = new JmapClient({ session: makeSession(), auth: bearer('t'), fetch })
    const echoed = await client.echo({ hello: 'world', n: 42 })
    expect(echoed).toEqual({ hello: 'world', n: 42 })
  })
})

describe('JmapClient — back-references', () => {
  it('chains Email/query → Email/get in one request with a correct ResultReference', async () => {
    const { fetch, calls } = jmapPostMock((body) => autoRespond(body))
    const client = new JmapClient({ session: makeSession(), auth: bearer('t'), fetch })

    const builder = client.request()
    const query = builder.call('Email/query', { accountId: 'a', filter: { inMailbox: 'inbox' } })
    const get = builder.call('Email/get', {
      accountId: 'a',
      '#ids': query.ref('/ids'),
      properties: ['subject'],
    })
    const result = await builder.send()

    // Single round-trip.
    expect(calls).toHaveLength(1)
    const sent = at(calls, 0).body.methodCalls
    expect(at(sent, 1)[1]).toMatchObject({
      '#ids': { resultOf: query.callId, name: 'Email/query', path: '/ids' },
    })

    // Both logical results are addressable by their handles and reassembled.
    expect(result.get<QueryResponse>(query).ids).toEqual(['e1', 'e2'])
    expect(result.get<GetResponse<{ id: string }>>(get).list).toEqual([{ id: 'e1' }, { id: 'e2' }])
  })
})

describe('JmapClient — transparent auto-chunking', () => {
  it('splits an over-limit /get across HTTP requests and reassembles as one result', async () => {
    const { fetch, calls } = jmapPostMock((body) => autoRespond(body))
    // 5 ids, max 2 per get, max 2 calls per request → 3 gets over 2 HTTP requests.
    const session = makeSession({ maxObjectsInGet: 2, maxCallsInRequest: 2 })
    const client = new JmapClient({ session, auth: bearer('t'), fetch })

    const ids = ['e0', 'e1', 'e2', 'e3', 'e4']
    const builder = client.request()
    const get = builder.call('Email/get', { accountId: 'a', ids })
    const result = await builder.send()

    expect(calls).toHaveLength(2)
    expect(at(calls, 0).body.methodCalls).toHaveLength(2)
    expect(at(calls, 1).body.methodCalls).toHaveLength(1)

    const merged = result.get<GetResponse<{ id: string }>>(get)
    expect(merged.list).toEqual(ids.map((id) => ({ id })))
    expect(merged.notFound).toEqual([])
  })
})

describe('JmapClient — createdIds threading', () => {
  it('forwards server-assigned createdIds from an earlier physical request into the next', async () => {
    const bodies: JmapRequest[] = []
    const fetch: FetchLike = async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as JmapRequest
      bodies.push(body)
      const methodResponses = body.methodCalls.map(
        ([name, args, id]) => [name, args, id] as Invocation,
      )
      // Only the first physical request produces a server-assigned creation id.
      const payload: JmapResponse =
        bodies.length === 1
          ? { methodResponses, sessionState: 's0', createdIds: { draft: 'srv-draft-1' } }
          : { methodResponses, sessionState: 's0' }
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    // maxCallsInRequest 1 forces the two calls into two separate physical requests.
    const session = makeSession({ maxCallsInRequest: 1 })
    const client = new JmapClient({ session, auth: bearer('t'), fetch })

    const builder = client.request()
    builder.call('Core/echo', { a: 1 })
    builder.call('Core/echo', { b: 2 })
    const result = await builder.send()

    expect(bodies).toHaveLength(2)
    // The first request seeded no createdIds…
    expect(at(bodies, 0).createdIds).toBeUndefined()
    // …the second forwards the id the server assigned in the first (RFC 8620 §5.8).
    expect(at(bodies, 1).createdIds).toEqual({ draft: 'srv-draft-1' })
    // And the merged map is surfaced on the response view.
    expect(result.createdIds).toEqual({ draft: 'srv-draft-1' })
  })
})

describe('JmapClient — session state', () => {
  it('invokes onSessionStateChange when the response reports a new state', async () => {
    const onSessionStateChange = vi.fn()
    const { fetch } = jmapPostMock((body) => autoRespond(body, 's1'))
    const client = new JmapClient({
      session: makeSession(),
      auth: bearer('t'),
      fetch,
      onSessionStateChange,
    })

    await client.echo({ x: 1 })

    expect(onSessionStateChange).toHaveBeenCalledWith('s1', 's0')
  })

  it('does not invoke the callback when the state is unchanged', async () => {
    const onSessionStateChange = vi.fn()
    const { fetch } = jmapPostMock((body) => autoRespond(body, 's0'))
    const client = new JmapClient({
      session: makeSession(),
      auth: bearer('t'),
      fetch,
      onSessionStateChange,
    })
    await client.echo({ x: 1 })
    expect(onSessionStateChange).not.toHaveBeenCalled()
  })
})

describe('JmapClient — empty batch', () => {
  it('makes no HTTP call for an empty request', async () => {
    const fetch = vi.fn()
    const client = new JmapClient({ session: makeSession(), auth: bearer('t'), fetch })
    const result = await client.call([] as Invocation[])
    expect(fetch).not.toHaveBeenCalled()
    expect(result.responses).toEqual([])
  })
})

// Belt-and-braces: the mock's response contract matches what the client expects.
it('autoRespond returns a well-formed JmapResponse', () => {
  const response: JmapResponse = autoRespond({
    using: [],
    methodCalls: [['Core/echo', { a: 1 }, 'c0']],
  })
  expect(at(response.methodResponses, 0)).toEqual(['Core/echo', { a: 1 }, 'c0'])
})
