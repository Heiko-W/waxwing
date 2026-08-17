/**
 * Push transports (SP.3, FR-NOTIF-01): live JMAP `StateChange` delivery over WebSocket
 * (RFC 8887) and Server-Sent Events, with shared reconnect/backoff and capability-based
 * auto-selection. See the individual modules for the wire and auth details established by
 * the SP.3 probe.
 */

// Backoff (full jitter) — exported for advanced callers and tests.
export { Backoff, type BackoffOptions, DEFAULT_BACKOFF } from './backoff'
// Shared base (for anyone building a custom transport on the same lifecycle).
export { type BaseChannelConfig, BasePushChannel } from './base'
// Auto-selection + runtime failover facade + the polling stub.
export {
  type CreatePushChannelOptions,
  createPushChannel,
  DEFAULT_FAILOVER_AFTER_ATTEMPTS,
  eligibleTransports,
  FailoverPushChannel,
  PollingChannel,
  pickTransport,
} from './channel'
// Reconnect driver.
export {
  type ConnectionHandle,
  type ConnectionHandlers,
  type Connector,
  DEFAULT_STABLE_AFTER_MS,
  MAX_RETRY_HINT_MS,
  ReconnectLoop,
  type ReconnectLoopConfig,
} from './reconnect'
// SSE transport + parser.
export { type SseAuthMode, SseChannel, type SseChannelOptions } from './sse'
export { MAX_SSE_BUFFER_CHARS, type SseEvent, SseParser, type SseStreamState } from './sse-parser'
// Runtime types (channel/observable surface + injection points).
export {
  defaultScheduler,
  MAX_TIMEOUT_MS,
  type PushChannel,
  type PushChannelEvents,
  type PushErrorListener,
  type PushStatus,
  type PushTransport,
  type SchedulerLike,
  type StateChangeListener,
  type StatusListener,
  type Unsubscribe,
  type WebSocketConnectInfo,
  type WebSocketFactory,
  type WebSocketLike,
  WS_OPEN,
} from './types'
// WebSocket (RFC 8887) transport.
export {
  getWebSocketCapability,
  type WebSocketCapability,
  WebSocketChannel,
  type WebSocketChannelOptions,
} from './websocket'
