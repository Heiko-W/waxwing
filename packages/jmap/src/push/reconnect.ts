/**
 * The transport-agnostic reconnect driver shared by SSE and WebSocket. It owns the
 * connect → open → drop → back-off → reconnect state machine and the {@link Backoff}, so
 * each transport only implements "make one connection attempt" (a {@link Connector}).
 *
 * Race-free by generation-guarding: every attempt captures the generation it was started
 * with, and the guard rejects any `reportOpen`/`reportClosed` from a superseded attempt. A
 * single {@link Backoff.reset} happens once a connection has stayed open long enough to be
 * considered *stable* (not merely established), so a server that accepts then immediately
 * drops keeps escalating its backoff instead of hammering it at the base delay. Every
 * `onStatus` emission is re-entrancy-safe: a status listener may synchronously call
 * {@link ReconnectLoop.stop} mid-transition, and the loop re-checks `active` afterwards so it
 * never opens a socket or arms a timer after being stopped. {@link ReconnectLoop.stop} cancels
 * both timers and the live connection with no zombie left behind.
 */

import type { Backoff } from './backoff'
import type { PushStatus, SchedulerLike } from './types'

/** A handle to one in-flight or established connection attempt. Its `close` must be idempotent. */
export interface ConnectionHandle {
  close(): void
}

/**
 * The callbacks a {@link Connector} uses to report its attempt's outcome. Connectors MUST
 * invoke these asynchronously (from a socket/stream event or a microtask), never synchronously
 * within the {@link Connector} call itself.
 */
export interface ConnectionHandlers {
  /** The connection is healthy (SSE 200 headers received / WebSocket `open`). Resets backoff. */
  reportOpen(): void
  /** The connection ended. Pass an `Error` for an abnormal drop; omit it for a clean end. */
  reportClosed(error?: Error): void
}

/** Starts one connection attempt, wired to `handlers`, and returns its {@link ConnectionHandle}. */
export type Connector = (handlers: ConnectionHandlers) => ConnectionHandle

/** Construction config for {@link ReconnectLoop}. */
export interface ReconnectLoopConfig {
  connect: Connector
  backoff: Backoff
  scheduler: SchedulerLike
  onStatus: (status: PushStatus) => void
  onError: (error: Error) => void
  /** Optional floor (ms) for the next reconnect delay — e.g. an SSE `retry:` hint. */
  retryHint?: () => number | undefined
  /**
   * How long (ms) a connection must stay open before it is deemed stable and the backoff is
   * reset. Guards against a flapping server (accept → immediate drop) pinning the backoff at
   * the base delay. Defaults to {@link DEFAULT_STABLE_AFTER_MS}.
   */
  stableAfter?: number
}

/** Default {@link ReconnectLoopConfig.stableAfter}: 5s of uptime marks a connection stable. */
export const DEFAULT_STABLE_AFTER_MS = 5000

export class ReconnectLoop {
  private generation = 0
  private active = false
  private current: ConnectionHandle | undefined
  private cancelTimer: (() => void) | undefined
  private cancelStableTimer: (() => void) | undefined
  private readonly stableAfter: number

  constructor(private readonly config: ReconnectLoopConfig) {
    this.stableAfter = config.stableAfter ?? DEFAULT_STABLE_AFTER_MS
  }

  /** Begins connecting. Idempotent while already running. */
  start(): void {
    if (this.active) return
    this.active = true
    this.config.backoff.reset()
    this.attempt('connecting')
  }

  /** Stops for good: cancels the pending reconnect timer and tears down the live connection. */
  stop(): void {
    if (!this.active) return
    this.active = false
    this.generation++ // invalidate any callbacks still queued from the live attempt
    this.cancelTimer?.()
    this.cancelTimer = undefined
    this.cancelStableTimer?.()
    this.cancelStableTimer = undefined
    const handle = this.current
    this.current = undefined
    handle?.close()
    this.config.onStatus('closed')
  }

  private attempt(status: 'connecting' | 'reconnecting'): void {
    this.config.onStatus(status)
    // A status listener may have re-entrantly stopped the loop during that emission. If so,
    // do not open a connection: `stop()` has already run and could never tear this one down
    // (a later `stop()` is a no-op while inactive), leaving a permanent zombie socket.
    if (!this.active) return
    const gen = this.generation
    const handlers: ConnectionHandlers = {
      reportOpen: () => {
        if (gen !== this.generation || !this.active) return
        this.config.onStatus('open')
        // A listener may have stopped us during the 'open' emission — don't arm a timer then.
        if (gen !== this.generation || !this.active) return
        this.armStableReset(gen)
      },
      reportClosed: (error) => {
        if (gen !== this.generation || !this.active) return
        this.generation++ // consume this attempt; further callbacks from it are ignored
        this.current = undefined
        this.cancelStableTimer?.() // dropped before proving stable ⇒ keep escalating backoff
        this.cancelStableTimer = undefined
        if (error) this.config.onError(error)
        this.scheduleReconnect()
      },
    }
    const handle = this.config.connect(handlers)
    // Store as the live connection only if this attempt is still current AND the loop was not
    // stopped meanwhile — synchronously by a misbehaving connector (against the contract) or
    // re-entrantly by a status listener. Otherwise drop the now-dead/orphaned handle.
    if (gen === this.generation && this.active) this.current = handle
    else handle.close()
  }

  /**
   * Arms a one-shot timer that resets the backoff once the connection has stayed open for
   * {@link ReconnectLoop.stableAfter} ms. Generation-guarded so a stale attempt's timer can
   * never reset the backoff of a superseded one.
   */
  private armStableReset(gen: number): void {
    this.cancelStableTimer?.()
    this.cancelStableTimer = this.config.scheduler.setTimeout(() => {
      this.cancelStableTimer = undefined
      if (gen !== this.generation || !this.active) return
      this.config.backoff.reset()
    }, this.stableAfter)
  }

  private scheduleReconnect(): void {
    if (!this.active) return
    this.config.onStatus('reconnecting')
    // A status listener may have re-entrantly stopped the loop during that emission. If so,
    // do not arm a reconnect timer: `stop()` has already run and would not cancel it, so it
    // would fire against a reopened loop and start a second concurrent connection.
    if (!this.active) return
    let delay = this.config.backoff.next()
    const hint = this.config.retryHint?.()
    if (hint !== undefined) delay = Math.max(delay, hint)
    this.cancelTimer = this.config.scheduler.setTimeout(() => {
      this.cancelTimer = undefined
      if (!this.active) return
      this.attempt('reconnecting')
    }, delay)
  }
}
