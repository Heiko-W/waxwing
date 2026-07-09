/**
 * Runtime types shared by the push transports (SP.3). Wire-format frames live in
 * `../types/push.ts`; this module is the injectable-dependency + observable-channel surface.
 */

import type { StateChange } from '../types/push'

/** Which transport a {@link PushChannel} is running. */
export type PushTransport = 'websocket' | 'sse' | 'polling'

/**
 * Lifecycle status of a {@link PushChannel}:
 *  - `connecting`   — first connection attempt in flight.
 *  - `open`         — connected and receiving (SSE 200 headers / WS `open`).
 *  - `reconnecting` — a previous connection dropped; backing off before the next attempt.
 *  - `closed`       — {@link PushChannel.close} was called (terminal).
 */
export type PushStatus = 'connecting' | 'open' | 'reconnecting' | 'closed'

/** Notified with each {@link StateChange} the server pushes. */
export type StateChangeListener = (change: StateChange) => void
/** Notified on every {@link PushStatus} transition. */
export type StatusListener = (status: PushStatus) => void
/** Notified when a connection attempt fails (the channel keeps retrying regardless). */
export type PushErrorListener = (error: Error) => void

/** Unregisters a listener registered with `subscribe`/`onStatus`/`onError`. */
export type Unsubscribe = () => void

/** Initial listeners passed at construction time (equivalent to calling the `on*` methods). */
export interface PushChannelEvents {
  onStateChange?: StateChangeListener
  onStatus?: StatusListener
  onError?: PushErrorListener
}

/**
 * A live push channel delivering JMAP {@link StateChange} events (FR-NOTIF-01). Obtain one
 * from {@link createPushChannel} (auto-selected transport) or construct a `SseChannel` /
 * `WebSocketChannel` directly. All `on*`/`subscribe` methods return an {@link Unsubscribe}.
 */
export interface PushChannel {
  /** The concrete transport in use. */
  readonly transport: PushTransport
  /** Current lifecycle status. */
  readonly status: PushStatus
  /** Starts connecting (idempotent — a second call while open is a no-op). */
  open(): void
  /** Closes the channel and releases every socket/reader/timer. Idempotent and terminal. */
  close(): void
  /** Subscribes to {@link StateChange} events. */
  subscribe(listener: StateChangeListener): Unsubscribe
  /** Subscribes to status transitions. */
  onStatus(listener: StatusListener): Unsubscribe
  /** Subscribes to connection errors. */
  onError(listener: PushErrorListener): Unsubscribe
}

/**
 * Minimal timer surface, injectable so unit tests stay deterministic (no real `setTimeout`).
 * `setTimeout` returns a cancel function rather than an opaque id, sidestepping the
 * browser (`number`) vs Node (`Timeout`) handle-type split.
 */
export interface SchedulerLike {
  setTimeout(handler: () => void, ms: number): () => void
}

/** Default scheduler backed by the host `setTimeout`/`clearTimeout`. */
export const defaultScheduler: SchedulerLike = {
  setTimeout(handler, ms) {
    const id = setTimeout(handler, ms)
    return () => {
      clearTimeout(id)
    }
  },
}

/**
 * The subset of the WHATWG `WebSocket` interface the {@link WebSocketChannel} relies on.
 * Injectable so unit tests can supply a fake and Node can supply a header-capable impl.
 */
export interface WebSocketLike {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: ((event: unknown) => void) | null
  onclose: ((event: { code?: number; reason?: string }) => void) | null
}

/** Connection context handed to a {@link WebSocketFactory}. */
export interface WebSocketConnectInfo {
  /** Subprotocols to negotiate (always `['jmap']` for RFC 8887). */
  protocols: string[]
  /**
   * The `Authorization` header the JMAP WebSocket handshake requires. Browsers cannot set
   * this on a `WebSocket` (SP.3 probe: Stalwart accepts only header auth), so the default
   * factory forwards it only where the runtime supports it (Node/undici).
   */
  headers: Record<string, string>
}

/** Constructs a {@link WebSocketLike}. Injected for tests and for header-capable Node impls. */
export type WebSocketFactory = (url: string, info: WebSocketConnectInfo) => WebSocketLike

/** `WebSocket.OPEN` — the numeric ready state indicating an open socket. */
export const WS_OPEN = 1
