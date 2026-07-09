import { describe, expect, it } from 'vitest'
import type { AuthProvider } from '../auth'
import { bearer } from '../auth'
import { JmapError, JmapRequestError } from '../errors'
import type { StateChange } from '../types/push'
import { FakeScheduler, fakeWebSocketFactory, tick } from './test-support'
import type { PushStatus } from './types'
import { getWebSocketCapability, WebSocketChannel } from './websocket'

const session = {
  capabilities: {
    'urn:ietf:params:jmap:websocket': { url: 'ws://mail.test/jmap/ws', supportsPush: true },
  },
}

const STATE_CHANGE: StateChange = {
  '@type': 'StateChange',
  changed: { b: { Email: 's1', EmailDelivery: 's1' } },
}

function harness(overrides: Partial<ConstructorParameters<typeof WebSocketChannel>[0]> = {}) {
  const { factory, sockets } = fakeWebSocketFactory()
  const scheduler = new FakeScheduler()
  const statuses: PushStatus[] = []
  const errors: Error[] = []
  const changes: StateChange[] = []
  const channel = new WebSocketChannel({
    session,
    auth: bearer('tok'),
    WebSocket: factory,
    scheduler,
    backoff: { random: () => 1, initialDelay: 100 },
    events: {
      onStatus: (s) => statuses.push(s),
      onError: (e) => errors.push(e),
      onStateChange: (c) => changes.push(c),
    },
    ...overrides,
  })
  return { channel, sockets, scheduler, statuses, errors, changes }
}

describe('getWebSocketCapability', () => {
  it('reads the RFC 8887 capability', () => {
    expect(getWebSocketCapability(session)).toEqual({
      url: 'ws://mail.test/jmap/ws',
      supportsPush: true,
    })
  })

  it('returns null when unadvertised', () => {
    expect(getWebSocketCapability({ capabilities: {} })).toBeNull()
  })
})

describe('WebSocketChannel', () => {
  it('throws if the session has no WebSocket capability and no url override', () => {
    expect(
      () => new WebSocketChannel({ session: { capabilities: {} }, auth: bearer('t') }),
    ).toThrow(/does not advertise/)
  })

  it('negotiates the jmap subprotocol and forwards the Authorization header', async () => {
    const { channel, sockets } = harness()
    channel.open()
    await tick()
    expect(sockets).toHaveLength(1)
    expect(sockets[0]?.info.protocols).toEqual(['jmap'])
    expect(sockets[0]?.info.headers.Authorization).toBe('Bearer tok')
    channel.close()
  })

  it('sends WebSocketPushEnable and reports open on socket open', async () => {
    const { channel, sockets, statuses } = harness({ dataTypes: ['Email', 'Mailbox'] })
    channel.open()
    await tick()
    sockets[0]?.simulateOpen()
    expect(statuses).toEqual(['connecting', 'open'])
    expect(sockets[0]?.lastSent()).toEqual({
      '@type': 'WebSocketPushEnable',
      dataTypes: ['Email', 'Mailbox'],
    })
    channel.close()
  })

  it('delivers StateChange frames to subscribers', async () => {
    const { channel, sockets, changes } = harness()
    channel.open()
    await tick()
    sockets[0]?.simulateOpen()
    sockets[0]?.simulateMessage(STATE_CHANGE)
    expect(changes).toEqual([STATE_CHANGE])
    channel.close()
  })

  it('round-trips a Request/Response correlated by id', async () => {
    const { channel, sockets } = harness()
    channel.open()
    await tick()
    sockets[0]?.simulateOpen()

    const builder = channel.request()
    const handle = builder.call('Core/echo', { hello: 'world' })
    const promise = builder.send()

    const sent = sockets[0]?.lastSent() as { '@type': string; id: string; methodCalls: unknown[] }
    expect(sent['@type']).toBe('Request')
    expect(sent.methodCalls).toEqual([['Core/echo', { hello: 'world' }, 'c0']])

    sockets[0]?.simulateMessage({
      '@type': 'Response',
      requestId: sent.id,
      methodResponses: [['Core/echo', { hello: 'world' }, 'c0']],
      sessionState: 'abc',
    })
    const responses = await promise
    expect(responses.get(handle)).toEqual({ hello: 'world' })
    expect(responses.sessionState).toBe('abc')
    channel.close()
  })

  it('rejects a pending request with JmapRequestError on a correlated RequestError', async () => {
    const { channel, sockets } = harness()
    channel.open()
    await tick()
    sockets[0]?.simulateOpen()
    const builder = channel.request()
    builder.call('Email/get', { accountId: 'b' })
    const promise = builder.send()
    const sent = sockets[0]?.lastSent() as { id: string }
    sockets[0]?.simulateMessage({
      '@type': 'RequestError',
      requestId: sent.id,
      type: 'urn:ietf:params:jmap:error:notRequest',
      status: 400,
      detail: 'nope',
    })
    await expect(promise).rejects.toBeInstanceOf(JmapRequestError)
    channel.close()
  })

  it('emits an uncorrelated RequestError on the error channel', async () => {
    const { channel, sockets, errors } = harness()
    channel.open()
    await tick()
    sockets[0]?.simulateOpen()
    sockets[0]?.simulateMessage({
      '@type': 'RequestError',
      type: 'urn:ietf:params:jmap:error:limit',
      detail: 'too big',
    })
    expect(errors[0]).toBeInstanceOf(JmapRequestError)
    channel.close()
  })

  it('rejects request() when the socket is not open', async () => {
    const { channel } = harness()
    channel.open()
    await tick() // socket exists but is still CONNECTING (never simulateOpen'd)
    const builder = channel.request()
    builder.call('Core/echo', {})
    await expect(builder.send()).rejects.toThrow(/not open/)
    channel.close()
  })

  it('reconnects with an error on an abnormal close (1006)', async () => {
    const { channel, sockets, scheduler, statuses, errors } = harness()
    channel.open()
    await tick()
    sockets[0]?.simulateOpen()
    sockets[0]?.simulateError()
    sockets[0]?.simulateClose(1006)
    expect(errors).toHaveLength(1)
    expect(statuses.at(-1)).toBe('reconnecting')
    expect(scheduler.pending).toBe(1)
    scheduler.runNext()
    await tick()
    expect(sockets).toHaveLength(2)
    channel.close()
  })

  it('reconnects without an error on a clean close (1000)', async () => {
    const { channel, sockets, scheduler, errors } = harness()
    channel.open()
    await tick()
    sockets[0]?.simulateOpen()
    sockets[0]?.simulateClose(1000)
    expect(errors).toHaveLength(0)
    expect(scheduler.pending).toBe(1)
    channel.close()
  })

  it('fails pending requests when the socket closes', async () => {
    const { channel, sockets } = harness()
    channel.open()
    await tick()
    sockets[0]?.simulateOpen()
    const builder = channel.request()
    builder.call('Core/echo', {})
    const promise = builder.send()
    sockets[0]?.simulateClose(1006)
    await expect(promise).rejects.toBeInstanceOf(JmapError)
    channel.close()
  })

  it('does not create a socket when close() lands before the auth handshake resolves', async () => {
    // Locks the in-flight `disposed` guard after `await auth.authorization()`: a close()
    // between open() and the auth promise resolving (e.g. React StrictMode mount/unmount) must
    // abort before the socket is constructed, or nothing can ever close the leaked socket.
    let release!: () => void
    const gate = new Promise<string>((resolve) => {
      release = () => resolve('Bearer tok')
    })
    const deferredAuth: AuthProvider = { scheme: 'bearer', authorization: () => gate }
    const { factory, sockets } = fakeWebSocketFactory()
    const channel = new WebSocketChannel({
      session,
      auth: deferredAuth,
      WebSocket: factory,
      scheduler: new FakeScheduler(),
    })
    channel.open()
    channel.close() // before authorization() resolves
    release()
    await tick()
    expect(sockets).toHaveLength(0)
  })

  it('close() tears down the socket and schedules no reconnect', async () => {
    const { channel, sockets, scheduler, statuses } = harness()
    channel.open()
    await tick()
    sockets[0]?.simulateOpen()
    channel.close()
    expect(sockets[0]?.closedWith).toEqual({ code: 1000 })
    expect(statuses.at(-1)).toBe('closed')
    // A close event arriving after our own close() must not trigger a reconnect.
    sockets[0]?.simulateClose(1006)
    expect(scheduler.pending).toBe(0)
  })
})
