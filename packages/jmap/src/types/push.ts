/**
 * Push + WebSocket wire types (RFC 8620 §7 "The JMAP Session Resource" push model and
 * RFC 8887 "JMAP over WebSocket").
 *
 * These model the JSON exactly as it appears on the SSE `event: state` / WebSocket frames.
 * The runtime transports that produce and consume them live in `../push/`.
 */

import type { CreationId, Id, Invocation, PatchObject, SetError, UTCDate } from './core'

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
 * The RFC 8620 §7 type name that means **mail arrived**, as opposed to `Email`, which also moves
 * when another client merely reads or files a message.
 *
 * It is the only reason a contentless push banner can be honest (ADR-017): a `StateChange` carries
 * no sender, subject or id, so "something in Email changed" would buzz for a message the user just
 * read on their phone. Verified against Stalwart v0.16.14, which sends
 * `{"changed":{"b":{"Thread":…,"Mailbox":…,"EmailDelivery":…,"Email":…}}}` on delivery.
 */
export const EMAIL_DELIVERY_TYPE = 'EmailDelivery'

/**
 * RFC 8620 §7.2 — a Web Push subscription this client has registered with the server.
 *
 * **It has no `accountId`, and neither do its methods.** A subscription belongs to the
 * *credentials*, not to one account: the server pushes state changes for every account those
 * credentials can see. `PushSubscription/get` and `/set` are therefore the only `get`/`set` pair in
 * JMAP that neither takes nor returns an `accountId` — which is why they get their own request and
 * response types below instead of reusing {@link GetRequest}/{@link SetRequest}.
 *
 * `keys` is **write-only**: the server never echoes it back (a subscription's encryption keys leaving
 * the server would defeat the point of RFC 8291), so a `get` returns `null` there even right after a
 * successful create.
 */
export interface PushSubscription {
  id: Id
  /**
   * A stable per-device, per-app identifier the CLIENT invents and persists. Re-using it lets a
   * server replace a stale subscription instead of accumulating one per launch; RFC 8620 §7.2 asks
   * for something no other client would collide with.
   */
  deviceClientId: string
  /** The push service endpoint from `PushManager.subscribe()`. Write-only in practice. */
  url: string
  /** RFC 8291 encryption material. Write-only — see the note above. */
  keys: PushSubscriptionKeys | null
  /**
   * Set by the CLIENT, echoing the code from the {@link PushVerification} the server pushed. Until
   * it matches, the server sends nothing but the verification itself — a subscription stuck at
   * `null` is silent, not broken-looking, so it must be surfaced rather than assumed to work.
   */
  verificationCode: string | null
  /**
   * When the server will stop pushing. The client may ask for a value; **the server may shorten it
   * and does** — Stalwart v0.16.14 grants 7 days whether 90 days are requested or nothing is
   * (RFC 8620 §7.2 permits this). Renewal only happens while a client runs, so this is a real
   * product limit, not a formality.
   */
  expires: UTCDate | null
  /** The data types to push, e.g. `["EmailDelivery"]`. `null` = every type. */
  types: string[] | null
}

/** RFC 8291 §4 — the browser subscription's public key and auth secret, base64url, unpadded. */
export interface PushSubscriptionKeys {
  p256dh: string
  auth: string
}

/**
 * RFC 8620 §7.2.2 — the first thing a server pushes after a subscription is created. The client
 * proves it can receive by writing `verificationCode` back with `PushSubscription/set`.
 */
export interface PushVerification {
  '@type': 'PushVerification'
  pushSubscriptionId: Id
  verificationCode: string
}

/**
 * `PushSubscription/get` (RFC 8620 §7.2.1) — no `accountId`.
 *
 * The response types below carry `accountId` and `state` as OPTIONAL, which is deliberate and is
 * measured rather than assumed: the RFC says neither is returned, and Stalwart v0.16.14 returns
 * `accountId` and omits `state`. Typing them as required would break against the server we ship
 * against; typing them as absent would break against a server that follows the standard get-response
 * shape. Optional is the only reading that survives both.
 */
export interface PushSubscriptionGetRequest {
  ids?: Id[] | null
  properties?: string[] | null
}

export interface PushSubscriptionGetResponse {
  accountId?: Id
  state?: string
  list: PushSubscription[]
  notFound: Id[]
}

/** `PushSubscription/set` (RFC 8620 §7.2.1) — no `accountId`, and no `ifInState`. */
export interface PushSubscriptionSetRequest {
  create?: Record<CreationId, Partial<PushSubscription>> | null
  update?: Record<Id, PatchObject> | null
  destroy?: Id[] | null
}

export interface PushSubscriptionSetResponse {
  accountId?: Id
  oldState?: string | null
  newState?: string
  created: Record<CreationId, PushSubscription> | null
  updated: Record<Id, PushSubscription | null> | null
  destroyed: Id[] | null
  notCreated: Record<CreationId, SetError> | null
  notUpdated: Record<Id, SetError> | null
  notDestroyed: Record<Id, SetError> | null
}

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
