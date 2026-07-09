/**
 * Transport auto-selection (FR-NOTIF-01): {@link createPushChannel} inspects the Session's
 * advertised capabilities and the available runtime primitives and returns the best
 * {@link PushChannel} — preferring **WebSocket → SSE → polling** by default. Callers who want
 * a specific transport construct {@link SseChannel} / {@link WebSocketChannel} directly, or
 * pass `prefer`.
 *
 * Against Stalwart specifically, WebSocket is not browser-viable (SP.3 probe — the handshake
 * needs an `Authorization` header a browser cannot set), so a browser build should pass
 * `prefer: 'sse'`. The default order honours FR-NOTIF-01's "WebSocket preferred"; WebSocket is
 * only *eligible* when the capability is advertised and a `WebSocket` implementation resolves.
 */

import type { AuthProvider } from '../auth'
import { JmapError } from '../errors'
import type { FetchLike } from '../transport'
import type { Session } from '../types/core'
import type { BackoffOptions } from './backoff'
import type { SseAuthMode } from './sse'
import { SseChannel } from './sse'
import type {
  PushChannel,
  PushChannelEvents,
  PushErrorListener,
  PushStatus,
  PushTransport,
  SchedulerLike,
  StateChangeListener,
  StatusListener,
  Unsubscribe,
  WebSocketFactory,
} from './types'
import { getWebSocketCapability, WebSocketChannel } from './websocket'

/** Options for {@link createPushChannel}. */
export interface CreatePushChannelOptions {
  /** Auth provider injected into the chosen transport. */
  auth: AuthProvider
  /** Injectable fetch for the SSE transport (tests / SSR). */
  fetch?: FetchLike
  /** Injectable WebSocket factory (tests / header-capable Node impl). */
  WebSocket?: WebSocketFactory
  /** Preferred transport(s), tried before the default `websocket → sse → polling` order. */
  prefer?: PushTransport | PushTransport[]
  /** Types to receive: WS `WebSocketPushEnable.dataTypes` / SSE `{types}`. */
  dataTypes?: string[] | null
  /** SSE auth placement (`header` default; `query` for servers with `?access_token=`). */
  sseAuth?: SseAuthMode
  /** Backoff tuning shared by whichever transport is selected. */
  backoff?: BackoffOptions
  /** Injectable timer source (tests). */
  scheduler?: SchedulerLike
  /** Initial listeners. */
  events?: PushChannelEvents
}

/** The default transport preference order (FR-NOTIF-01). */
const DEFAULT_ORDER: readonly PushTransport[] = ['websocket', 'sse', 'polling']

/**
 * Chooses a transport for `session`: the first entry of the preference order that is
 * *eligible* (its capability is advertised and its runtime primitive resolves).
 */
export function pickTransport(session: Session, options: CreatePushChannelOptions): PushTransport {
  for (const transport of transportOrder(options.prefer)) {
    if (isEligible(transport, session, options)) return transport
  }
  return 'polling'
}

/**
 * Builds a {@link PushChannel} for `session` with the auto-selected (or `prefer`red)
 * transport. Does not open it — call {@link PushChannel.open}.
 */
export function createPushChannel(
  session: Session,
  options: CreatePushChannelOptions,
): PushChannel {
  const transport = pickTransport(session, options)
  const shared = pickShared(options)
  switch (transport) {
    case 'websocket': {
      const wsOptions: ConstructorParameters<typeof WebSocketChannel>[0] = {
        session,
        auth: options.auth,
        ...shared,
      }
      if (options.WebSocket !== undefined) wsOptions.WebSocket = options.WebSocket
      if (options.dataTypes !== undefined) wsOptions.dataTypes = options.dataTypes
      return new WebSocketChannel(wsOptions)
    }
    case 'sse': {
      const sseOptions: ConstructorParameters<typeof SseChannel>[0] = {
        session,
        auth: options.auth,
        ...shared,
      }
      if (options.fetch !== undefined) sseOptions.fetch = options.fetch
      if (options.sseAuth !== undefined) sseOptions.sseAuth = options.sseAuth
      if (options.dataTypes != null) sseOptions.types = options.dataTypes.join(',')
      return new SseChannel(sseOptions)
    }
    default:
      return new PollingChannel(shared.events)
  }
}

/** The subset of options shared by every concrete channel constructor. */
function pickShared(options: CreatePushChannelOptions): {
  backoff?: BackoffOptions
  scheduler?: SchedulerLike
  events?: PushChannelEvents
} {
  const shared: {
    backoff?: BackoffOptions
    scheduler?: SchedulerLike
    events?: PushChannelEvents
  } = {}
  if (options.backoff !== undefined) shared.backoff = options.backoff
  if (options.scheduler !== undefined) shared.scheduler = options.scheduler
  if (options.events !== undefined) shared.events = options.events
  return shared
}

function transportOrder(prefer: CreatePushChannelOptions['prefer']): PushTransport[] {
  if (prefer === undefined) return [...DEFAULT_ORDER]
  const preferred = Array.isArray(prefer) ? prefer : [prefer]
  return [...preferred, ...DEFAULT_ORDER.filter((transport) => !preferred.includes(transport))]
}

function isEligible(
  transport: PushTransport,
  session: Session,
  options: CreatePushChannelOptions,
): boolean {
  switch (transport) {
    case 'websocket':
      // RFC 8887 §3: a WebSocket capability with `supportsPush:false` is usable for
      // Request/Response but the server will NOT push StateChange over it — never auto-select
      // it as a push transport (fall through to SSE), or the channel would report 'open' yet
      // deliver zero events. Callers needing WS for Request/Response build WebSocketChannel
      // directly.
      return (
        getWebSocketCapability(session)?.supportsPush === true &&
        (options.WebSocket !== undefined || hasGlobalWebSocket())
      )
    case 'sse':
      return typeof session.eventSourceUrl === 'string' && session.eventSourceUrl !== ''
    case 'polling':
      return true
  }
}

function hasGlobalWebSocket(): boolean {
  return typeof (globalThis as { WebSocket?: unknown }).WebSocket === 'function'
}

/**
 * Interface-only polling transport (the M1.3 long-poll fallback lands later). It satisfies
 * {@link PushChannel} so auto-selection always returns *something*, but {@link PollingChannel.open}
 * reports a "not implemented" error rather than pretending to deliver events.
 */
export class PollingChannel implements PushChannel {
  readonly transport: PushTransport = 'polling'
  private currentStatus: PushStatus = 'closed'
  private readonly stateListeners = new Set<StateChangeListener>()
  private readonly statusListeners = new Set<StatusListener>()
  private readonly errorListeners = new Set<PushErrorListener>()

  constructor(events?: PushChannelEvents) {
    if (events?.onStateChange) this.stateListeners.add(events.onStateChange)
    if (events?.onStatus) this.statusListeners.add(events.onStatus)
    if (events?.onError) this.errorListeners.add(events.onError)
  }

  get status(): PushStatus {
    return this.currentStatus
  }

  open(): void {
    for (const listener of [...this.errorListeners]) {
      listener(new JmapError('Polling push transport is not implemented yet (M1.3)'))
    }
  }

  close(): void {
    this.currentStatus = 'closed'
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
}
