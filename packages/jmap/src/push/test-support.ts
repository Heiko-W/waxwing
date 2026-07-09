/**
 * Hermetic test doubles for the push transports: a deterministic scheduler, a controllable
 * fake WebSocket, and a fetch mock that hands out drivable SSE streams. Not part of the
 * published surface (only `index.ts` is bundled).
 */

import type { FetchLike } from '../transport'
import type { SchedulerLike, WebSocketConnectInfo, WebSocketLike } from './types'

/** A `SchedulerLike` whose timers only fire when the test advances them. */
export class FakeScheduler implements SchedulerLike {
  private tasks: { handler: () => void; delay: number; cancelled: boolean }[] = []

  setTimeout(handler: () => void, ms: number): () => void {
    const task = { handler, delay: ms, cancelled: false }
    this.tasks.push(task)
    return () => {
      task.cancelled = true
    }
  }

  /** Delays of the still-live (uncancelled, unrun) timers, in scheduling order. */
  get delays(): number[] {
    return this.tasks.filter((task) => !task.cancelled).map((task) => task.delay)
  }

  /** Count of live timers. */
  get pending(): number {
    return this.tasks.filter((task) => !task.cancelled).length
  }

  /** Runs the oldest live timer (removing it first, so it may schedule a successor). */
  runNext(): boolean {
    const index = this.tasks.findIndex((task) => !task.cancelled)
    if (index === -1) return false
    const [task] = this.tasks.splice(index, 1)
    task?.handler()
    return true
  }

  /** Runs live timers until none remain (bounded, to avoid an accidental infinite loop). */
  flush(limit = 100): void {
    let count = 0
    while (this.runNext()) {
      if (++count >= limit) throw new Error('FakeScheduler.flush exceeded its iteration limit')
    }
  }
}

/** A controllable {@link WebSocketLike} whose server side is driven by the `simulate*` methods. */
export class FakeWebSocket implements WebSocketLike {
  readyState = 0 // CONNECTING
  readonly sent: string[] = []
  closedWith: { code?: number; reason?: string } | undefined
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null

  constructor(
    readonly url: string,
    readonly info: WebSocketConnectInfo,
  ) {}

  send(data: string): void {
    this.sent.push(data)
  }

  close(code?: number, reason?: string): void {
    this.closedWith = closeEvent(code, reason)
    this.readyState = 3 // CLOSED
  }

  /** The last frame `send()` received, parsed as JSON. */
  lastSent(): unknown {
    const raw = this.sent.at(-1)
    return raw === undefined ? undefined : JSON.parse(raw)
  }

  simulateOpen(): void {
    this.readyState = 1 // OPEN
    this.onopen?.(undefined)
  }

  simulateMessage(data: unknown): void {
    this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) })
  }

  simulateError(): void {
    this.onerror?.(undefined)
  }

  simulateClose(code?: number, reason?: string): void {
    this.readyState = 3
    this.onclose?.(closeEvent(code, reason))
  }
}

/** Builds a close-event object with only the defined fields (exactOptionalPropertyTypes). */
function closeEvent(code?: number, reason?: string): { code?: number; reason?: string } {
  const event: { code?: number; reason?: string } = {}
  if (code !== undefined) event.code = code
  if (reason !== undefined) event.reason = reason
  return event
}

/** A WebSocket factory that records every socket it creates. */
export function fakeWebSocketFactory(): {
  factory: (url: string, info: WebSocketConnectInfo) => WebSocketLike
  sockets: FakeWebSocket[]
} {
  const sockets: FakeWebSocket[] = []
  return {
    factory: (url, info) => {
      const socket = new FakeWebSocket(url, info)
      sockets.push(socket)
      return socket
    },
    sockets,
  }
}

/**
 * A WebSocket factory whose every socket fails the handshake — it fires `error` then an
 * abnormal `close(1006)` on the next microtask, mimicking a browser that cannot send the
 * `Authorization` header Stalwart requires. Used to drive the failover facade deterministically.
 */
export function failingWebSocketFactory(): {
  factory: (url: string, info: WebSocketConnectInfo) => WebSocketLike
  sockets: FakeWebSocket[]
} {
  const sockets: FakeWebSocket[] = []
  return {
    factory: (url, info) => {
      const socket = new FakeWebSocket(url, info)
      sockets.push(socket)
      queueMicrotask(() => {
        socket.simulateError()
        socket.simulateClose(1006)
      })
      return socket
    },
    sockets,
  }
}

/** One driveable SSE connection produced by {@link sseFetchMock}. */
export interface SseConnection {
  url: string
  headers: Record<string, string>
  /** Enqueue raw SSE bytes onto the stream. */
  push(text: string): void
  /** End the stream cleanly (reader sees `done`). */
  end(): void
  /** Error the stream (reader read() rejects). */
  fail(error: unknown): void
}

/** A fetch mock that returns a fresh, drivable `text/event-stream` Response per call. */
export function sseFetchMock(status = 200): { fetch: FetchLike; connections: SseConnection[] } {
  const connections: SseConnection[] = []
  const fetch: FetchLike = (url, init) => {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c
      },
    })
    const encoder = new TextEncoder()
    const connection: SseConnection = {
      url,
      headers: { ...(init?.headers ?? {}) },
      push: (text) => controller.enqueue(encoder.encode(text)),
      end: () => {
        controller.close()
      },
      fail: (error) => {
        controller.error(error)
      },
    }
    connections.push(connection)
    init?.signal?.addEventListener('abort', () => {
      try {
        controller.error(new DOMException('aborted', 'AbortError'))
      } catch {
        // stream already closed
      }
    })
    return Promise.resolve(
      new Response(status === 200 ? stream : null, {
        status,
        headers: { 'content-type': 'text/event-stream' },
      }),
    )
  }
  return { fetch, connections }
}

/** Resolves after pending microtasks (and a macrotask), letting async connectors settle. */
export function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}
