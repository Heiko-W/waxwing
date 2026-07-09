/**
 * {@link BasePushChannel} — the listener/status plumbing every transport shares, delegating
 * the connect/reconnect lifecycle to a {@link ReconnectLoop}. `SseChannel` and
 * `WebSocketChannel` extend it and implement only {@link BasePushChannel.connect}.
 */

import type { StateChange } from '../types/push'
import { Backoff, type BackoffOptions } from './backoff'
import { type ConnectionHandle, type ConnectionHandlers, ReconnectLoop } from './reconnect'
import {
  defaultScheduler,
  type PushChannel,
  type PushChannelEvents,
  type PushErrorListener,
  type PushStatus,
  type PushTransport,
  type SchedulerLike,
  type StateChangeListener,
  type StatusListener,
  type Unsubscribe,
} from './types'

/** Options common to every concrete channel. */
export interface BaseChannelConfig {
  /** Backoff tuning for reconnects. */
  backoff?: BackoffOptions
  /** Injectable timer source (tests). Defaults to {@link defaultScheduler}. */
  scheduler?: SchedulerLike
  /** Initial listeners. */
  events?: PushChannelEvents
}

export abstract class BasePushChannel implements PushChannel {
  abstract readonly transport: PushTransport

  private readonly stateListeners = new Set<StateChangeListener>()
  private readonly statusListeners = new Set<StatusListener>()
  private readonly errorListeners = new Set<PushErrorListener>()
  private currentStatus: PushStatus = 'closed'
  private readonly loop: ReconnectLoop

  protected constructor(config: BaseChannelConfig) {
    const events = config.events
    if (events?.onStateChange) this.stateListeners.add(events.onStateChange)
    if (events?.onStatus) this.statusListeners.add(events.onStatus)
    if (events?.onError) this.errorListeners.add(events.onError)
    this.loop = new ReconnectLoop({
      connect: (handlers) => this.connect(handlers),
      backoff: new Backoff(config.backoff),
      scheduler: config.scheduler ?? defaultScheduler,
      onStatus: (status) => this.setStatus(status),
      onError: (error) => this.emitError(error),
      retryHint: () => this.retryHint(),
    })
  }

  get status(): PushStatus {
    return this.currentStatus
  }

  open(): void {
    this.loop.start()
  }

  close(): void {
    this.loop.stop()
  }

  subscribe(listener: StateChangeListener): Unsubscribe {
    this.stateListeners.add(listener)
    return () => {
      this.stateListeners.delete(listener)
    }
  }

  onStatus(listener: StatusListener): Unsubscribe {
    this.statusListeners.add(listener)
    return () => {
      this.statusListeners.delete(listener)
    }
  }

  onError(listener: PushErrorListener): Unsubscribe {
    this.errorListeners.add(listener)
    return () => {
      this.errorListeners.delete(listener)
    }
  }

  /** Subclass hook: open one connection attempt wired to `handlers`. */
  protected abstract connect(handlers: ConnectionHandlers): ConnectionHandle

  /** Subclass hook: an optional floor (ms) for the next reconnect delay. Default: none. */
  protected retryHint(): number | undefined {
    return undefined
  }

  /** Fan out a {@link StateChange} to subscribers. */
  protected emitStateChange(change: StateChange): void {
    for (const listener of [...this.stateListeners]) listener(change)
  }

  /** Fan out a connection error to subscribers. */
  protected emitError(error: Error): void {
    for (const listener of [...this.errorListeners]) listener(error)
  }

  private setStatus(status: PushStatus): void {
    if (status === this.currentStatus) return
    this.currentStatus = status
    for (const listener of [...this.statusListeners]) listener(status)
  }
}
