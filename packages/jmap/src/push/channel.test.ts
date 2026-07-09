import { describe, expect, it } from 'vitest'
import { bearer } from '../auth'
import { makeSession } from '../test-support'
import type { Session } from '../types/core'
import { createPushChannel, PollingChannel, pickTransport } from './channel'
import { SseChannel } from './sse'
import { FakeScheduler, fakeWebSocketFactory, sseFetchMock, tick } from './test-support'
import { WebSocketChannel } from './websocket'

/** A session with the RFC 8887 WebSocket capability added. */
function withWebSocket(): Session {
  const session = makeSession()
  return {
    ...session,
    capabilities: {
      ...session.capabilities,
      'urn:ietf:params:jmap:websocket': { url: 'ws://mail.test/jmap/ws', supportsPush: true },
    },
  }
}

/** A session advertising the WebSocket capability but with push disabled (RFC 8887 §3). */
function withWebSocketNoPush(): Session {
  const session = makeSession()
  return {
    ...session,
    capabilities: {
      ...session.capabilities,
      'urn:ietf:params:jmap:websocket': { url: 'ws://mail.test/jmap/ws', supportsPush: false },
    },
  }
}

/** A session with neither a WebSocket capability nor an eventSource URL. */
function pollingOnly(): Session {
  return { ...makeSession(), eventSourceUrl: '' }
}

const auth = bearer('tok')

describe('pickTransport', () => {
  it('prefers WebSocket when advertised and a factory is available', () => {
    const { factory } = fakeWebSocketFactory()
    expect(pickTransport(withWebSocket(), { auth, WebSocket: factory })).toBe('websocket')
  })

  it('falls back to SSE when there is no WebSocket capability', () => {
    // makeSession() advertises core+mail (no websocket) but has an eventSourceUrl.
    expect(pickTransport(makeSession(), { auth })).toBe('sse')
  })

  it('falls back to polling when neither transport is eligible', () => {
    const { factory } = fakeWebSocketFactory()
    expect(pickTransport(pollingOnly(), { auth, WebSocket: factory })).toBe('polling')
  })

  it('honours an explicit prefer over the default order', () => {
    const { factory } = fakeWebSocketFactory()
    expect(pickTransport(withWebSocket(), { auth, WebSocket: factory, prefer: 'sse' })).toBe('sse')
  })

  it('does not auto-select WebSocket when the server advertises supportsPush:false', () => {
    // RFC 8887 §3: a WS capability with supportsPush:false pushes no StateChange ⇒ must fall
    // through to SSE (makeSession has an eventSourceUrl), not silently pick a dead push channel.
    const { factory } = fakeWebSocketFactory()
    expect(pickTransport(withWebSocketNoPush(), { auth, WebSocket: factory })).toBe('sse')
  })

  it('skips a supportsPush:false WebSocket even when explicitly preferred', () => {
    const { factory } = fakeWebSocketFactory()
    expect(
      pickTransport(withWebSocketNoPush(), { auth, WebSocket: factory, prefer: 'websocket' }),
    ).toBe('sse')
  })

  it('accepts a prefer list and skips ineligible entries', () => {
    // Prefer websocket then sse, but this session has no ws capability ⇒ sse.
    expect(pickTransport(makeSession(), { auth, prefer: ['websocket', 'sse'] })).toBe('sse')
  })
})

describe('createPushChannel', () => {
  it('builds a WebSocketChannel when WebSocket is selected', () => {
    const { factory } = fakeWebSocketFactory()
    const channel = createPushChannel(withWebSocket(), { auth, WebSocket: factory })
    expect(channel).toBeInstanceOf(WebSocketChannel)
    expect(channel.transport).toBe('websocket')
  })

  it('builds an SseChannel when SSE is selected', () => {
    const channel = createPushChannel(makeSession(), { auth, prefer: 'sse' })
    expect(channel).toBeInstanceOf(SseChannel)
    expect(channel.transport).toBe('sse')
  })

  it('builds a PollingChannel when nothing else is eligible', () => {
    const channel = createPushChannel(pollingOnly(), { auth })
    expect(channel).toBeInstanceOf(PollingChannel)
    expect(channel.transport).toBe('polling')
  })

  it('builds an SseChannel (not WebSocket) when the WS capability has supportsPush:false', () => {
    const { factory } = fakeWebSocketFactory()
    const channel = createPushChannel(withWebSocketNoPush(), { auth, WebSocket: factory })
    expect(channel).toBeInstanceOf(SseChannel)
    expect(channel.transport).toBe('sse')
  })

  it('maps dataTypes onto the SSE {types} template var', async () => {
    const { fetch, connections } = sseFetchMock()
    const channel = createPushChannel(makeSession(), {
      auth,
      prefer: 'sse',
      fetch,
      scheduler: new FakeScheduler(),
      dataTypes: ['Email', 'Mailbox'],
    })
    channel.open()
    await tick()
    expect(connections[0]?.url).toContain('types=Email%2CMailbox')
    channel.close()
  })
})

describe('PollingChannel (interface-only stub)', () => {
  it('reports a not-implemented error on open() and stays closed', () => {
    const errors: Error[] = []
    const channel = new PollingChannel({ onError: (e) => errors.push(e) })
    channel.open()
    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toMatch(/not implemented yet \(M1\.3\)/)
    expect(channel.status).toBe('closed')
  })

  it('supports subscribe/onStatus/onError registration and unsubscription', () => {
    const channel = new PollingChannel()
    const unsub = channel.subscribe(() => {})
    expect(typeof unsub).toBe('function')
    unsub()
    channel.close()
    expect(channel.status).toBe('closed')
  })
})
