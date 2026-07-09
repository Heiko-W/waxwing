/**
 * Push + WebSocket wire types (RFC 8620 §7 "The JMAP Session Resource" push model and
 * RFC 8887 "JMAP over WebSocket").
 *
 * These model the JSON exactly as it appears on the SSE `event: state` / WebSocket frames.
 * The runtime transports that produce and consume them live in `../push/`.
 */

import type { CreationId, Id, Invocation } from './core'

/**
 * A `StateChange` object (RFC 8620 §7.1): the server's signal that one or more data types
 * changed. `changed` maps each affected accountId to a map of `typeName` → the new state
 * string for that type (usable directly as the `sinceState` of a `Foo/changes` call).
 *
 * Delivered verbatim over WebSocket, and wrapped in an SSE `event: state` frame's `data:`
 * for the EventSource transport.
 */
export interface StateChange {
  '@type': 'StateChange'
  changed: Record<Id, TypeStateMap>
}

/** `typeName` (e.g. `"Email"`, `"Mailbox"`, `"EmailDelivery"`) → new state string. */
export type TypeStateMap = Record<string, string>

/**
 * RFC 8887 §4 — client → server frame carrying a batch of method calls over an open
 * WebSocket, correlated to its {@link WsResponse} by the optional `id`.
 */
export interface WsRequest {
  '@type': 'Request'
  /** Echoed back as {@link WsResponse.requestId}; used to correlate the response. */
  id?: string
  using: string[]
  methodCalls: Invocation[]
  createdIds?: Record<CreationId, Id>
}

/** RFC 8887 §4 — server → client frame answering a {@link WsRequest}. */
export interface WsResponse {
  '@type': 'Response'
  methodResponses: Invocation[]
  createdIds?: Record<CreationId, Id>
  sessionState: string
  /** Echoes the request's `id`. */
  requestId?: string
}

/**
 * RFC 8887 §4.2 — server → client error for a malformed/rejected {@link WsRequest}. Shaped
 * like an RFC 8620 §3.6.1 request-level problem document plus the correlating `requestId`.
 */
export interface WsRequestError {
  '@type': 'RequestError'
  /** Echoes the request's `id`, when the server could parse it. */
  requestId?: string
  type: string
  status?: number
  detail?: string
  limit?: string
  [k: string]: unknown
}

/**
 * RFC 8887 §5 — client → server frame turning server-initiated {@link StateChange} push
 * on for this socket. `dataTypes: null` (or omitted) means "all types"; `pushState` resumes
 * from a previously observed state where the server supports it.
 */
export interface WebSocketPushEnable {
  '@type': 'WebSocketPushEnable'
  dataTypes?: string[] | null
  pushState?: string
}

/** RFC 8887 §5 — client → server frame turning push off for this socket. */
export interface WebSocketPushDisable {
  '@type': 'WebSocketPushDisable'
}

/** Any frame the client may send over the JMAP WebSocket subprotocol. */
export type WsClientFrame = WsRequest | WebSocketPushEnable | WebSocketPushDisable

/** Any frame the server may send over the JMAP WebSocket subprotocol. */
export type WsServerFrame = WsResponse | WsRequestError | StateChange
