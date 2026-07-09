import { describe, expect, it } from 'vitest'
import type { AuthProvider } from '../auth'
import { basic, bearer } from '../auth'
import type { StateChange } from '../types/push'
import { SseChannel } from './sse'
import { FakeScheduler, sseFetchMock, tick } from './test-support'
import type { PushStatus } from './types'

/** An auth provider whose `authorization()` resolves only when the test releases it. */
function deferredAuth(): { auth: AuthProvider; release: () => void } {
  let release!: () => void
  const gate = new Promise<string>((resolve) => {
    release = () => resolve('Bearer tok')
  })
  return { auth: { scheme: 'bearer', authorization: () => gate }, release }
}

const EVENT_SOURCE_URL =
  'http://mail.test/jmap/eventsource/?types={types}&closeafter={closeafter}&ping={ping}'
const session = { eventSourceUrl: EVENT_SOURCE_URL }

const STATE_FRAME =
  'event: state\ndata: {"@type":"StateChange","changed":{"b":{"Email":"s1","Mailbox":"s1"}}}\n\n'

function harness(overrides: Partial<ConstructorParameters<typeof SseChannel>[0]> = {}) {
  const { fetch, connections } = sseFetchMock()
  const scheduler = new FakeScheduler()
  const statuses: PushStatus[] = []
  const errors: Error[] = []
  const changes: StateChange[] = []
  const channel = new SseChannel({
    session,
    auth: bearer('tok'),
    fetch,
    scheduler,
    backoff: { random: () => 1, initialDelay: 100 },
    events: {
      onStatus: (status) => statuses.push(status),
      onError: (error) => errors.push(error),
      onStateChange: (change) => changes.push(change),
    },
    ...overrides,
  })
  return { channel, connections, scheduler, statuses, errors, changes }
}

describe('SseChannel', () => {
  it('expands the eventSource URI template and sends the Authorization header', async () => {
    const { channel, connections } = harness()
    channel.open()
    await tick()
    expect(connections).toHaveLength(1)
    const url = connections[0]?.url ?? ''
    expect(url).toContain('types=%2A') // '*' percent-encoded per RFC 6570
    expect(url).toContain('closeafter=no')
    expect(url).toContain('ping=30')
    expect(connections[0]?.headers.Authorization).toBe('Bearer tok')
    expect(connections[0]?.headers.Accept).toBe('text/event-stream')
    channel.close()
  })

  it('transitions connecting → open and delivers StateChange events', async () => {
    const { channel, connections, statuses, changes } = harness()
    channel.open()
    await tick()
    expect(statuses).toEqual(['connecting', 'open'])
    connections[0]?.push(STATE_FRAME)
    await tick()
    expect(changes).toHaveLength(1)
    expect(changes[0]?.changed).toEqual({ b: { Email: 's1', Mailbox: 's1' } })
    channel.close()
  })

  it('ignores non-StateChange keep-alive (ping) frames', async () => {
    const { channel, connections, changes } = harness()
    channel.open()
    await tick()
    connections[0]?.push('event: ping\ndata: {"interval":30000}\n\n')
    await tick()
    expect(changes).toHaveLength(0)
    channel.close()
  })

  it('reconnects (no error) when the server ends the stream', async () => {
    const { channel, connections, scheduler, statuses } = harness()
    channel.open()
    await tick()
    connections[0]?.end()
    await tick()
    expect(statuses).toEqual(['connecting', 'open', 'reconnecting'])
    expect(scheduler.pending).toBe(1)
    scheduler.runNext()
    await tick()
    expect(connections).toHaveLength(2)
    expect(statuses.at(-1)).toBe('open')
    channel.close()
  })

  it('emits an error and reconnects on a non-200 response', async () => {
    const { fetch } = sseFetchMock(401)
    const scheduler = new FakeScheduler()
    const errors: Error[] = []
    const statuses: PushStatus[] = []
    const channel = new SseChannel({
      session,
      auth: bearer('tok'),
      fetch,
      scheduler,
      backoff: { random: () => 1, initialDelay: 100 },
      events: { onError: (e) => errors.push(e), onStatus: (s) => statuses.push(s) },
    })
    channel.open()
    await tick()
    expect(errors).toHaveLength(1)
    expect(statuses.at(-1)).toBe('reconnecting')
    expect(scheduler.pending).toBe(1)
    channel.close()
  })

  it('sends Last-Event-ID on reconnect once an id was seen', async () => {
    const { channel, connections, scheduler } = harness()
    channel.open()
    await tick()
    connections[0]?.push('id: 99\ndata: {"@type":"StateChange","changed":{}}\n\n')
    await tick()
    connections[0]?.end()
    await tick()
    scheduler.runNext()
    await tick()
    expect(connections[1]?.headers['Last-Event-ID']).toBe('99')
    channel.close()
  })

  it('applies a server retry: field as the reconnect-delay floor', async () => {
    // Locks the SSE-specific glue: parser retry: → serverRetryMs → retryHint() → delay floor.
    const { fetch, connections } = sseFetchMock()
    const scheduler = new FakeScheduler()
    const channel = new SseChannel({
      session,
      auth: bearer('tok'),
      fetch,
      scheduler,
      backoff: { random: () => 0, initialDelay: 100 }, // jitter window → 0, so the floor wins
    })
    channel.open()
    await tick()
    connections[0]?.push('retry: 2500\ndata: {"@type":"StateChange","changed":{}}\n\n')
    await tick()
    connections[0]?.end()
    await tick()
    expect(scheduler.delays).toEqual([2500])
    channel.close()
  })

  it('does not issue the fetch when close() lands before the auth handshake resolves', async () => {
    // Locks the in-flight `isDisposed()` guard in run(): a close() between open() and the auth
    // promise resolving must abort the connect before any fetch/stream is created.
    const { auth, release } = deferredAuth()
    const { fetch, connections } = sseFetchMock()
    const channel = new SseChannel({ session, auth, fetch, scheduler: new FakeScheduler() })
    channel.open()
    channel.close() // before authorization() resolves
    release()
    await tick()
    expect(connections).toHaveLength(0)
  })

  it('close() stops the channel with no reconnect scheduled', async () => {
    const { channel, scheduler, statuses } = harness()
    channel.open()
    await tick()
    channel.close()
    await tick()
    expect(statuses.at(-1)).toBe('closed')
    expect(scheduler.pending).toBe(0)
  })

  it('carries the credential as a query param in sseAuth: "query" mode', async () => {
    const { fetch, connections } = sseFetchMock()
    const channel = new SseChannel({
      session,
      auth: bearer('qtok'),
      fetch,
      sseAuth: 'query',
      scheduler: new FakeScheduler(),
    })
    channel.open()
    await tick()
    const url = connections[0]?.url ?? ''
    expect(url).toContain('access_token=qtok')
    expect(connections[0]?.headers.Authorization).toBeUndefined()
    channel.close()
  })

  it('errors in query mode when the auth scheme has no token form (Basic)', async () => {
    const { fetch } = sseFetchMock()
    const errors: Error[] = []
    const channel = new SseChannel({
      session,
      auth: basic('user', 'pass'),
      fetch,
      sseAuth: 'query',
      scheduler: new FakeScheduler(),
      events: { onError: (e) => errors.push(e) },
    })
    channel.open()
    await tick()
    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toContain('no query-param token form')
    channel.close()
  })
})
