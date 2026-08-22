/**
 * Push + WebSocket wire types (RFC 8620 §7 "The JMAP Session Resource" push model and
 * RFC 8887 "JMAP over WebSocket").
 *
 * These model the JSON exactly as it appears on the SSE `event: state` / WebSocket frames.
 * The runtime transports that produce and consume them live in `../push/`.
 */

import type { CreationId, Id, Invocation, PatchObject, SetError, UTCDate } from './core'
import type { EmailAddress, EmailFilter } from './mail'

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
  /**
   * `draft-ietf-jmap-emailpush-03` — ask the server to put the MESSAGE in the push instead of a bare
   * {@link StateChange}, per account. Absent/`null` = the RFC 8620 behaviour, which is what every
   * server without {@link Capabilities.emailPush} does and the only thing they may be sent.
   *
   * Keyed by accountId, and only accounts these credentials can see: Stalwart v0.16.18 answers a
   * foreign one with `invalidProperties` — *"No access to one of the accounts in the emailPush map."*
   *
   * **Configuring this changes what the server sends, it does not add to it.** See {@link EmailPush}:
   * a delivery matching an account's config arrives as an `EmailPush` and the `StateChange` for that
   * delivery is not sent at all.
   */
  emailPush?: Record<Id, EmailPushConfig> | null
}

/**
 * `draft-ietf-jmap-emailpush-03` — one account's entry in {@link PushSubscription.emailPush}.
 *
 * Measured against Stalwart v0.16.18 (`docs/jmap-gap-2026-08-21/berichte/E-emailpush.md`): the
 * server stores what it is given, fills in `urgency: "normal"` itself when it is omitted, and
 * rejects an unknown entry in `properties` with `invalidProperties` — *"Unknown email property."*
 */
export interface EmailPushConfig {
  /**
   * An ordinary RFC 8621 `Email` filter, or `null` for "every delivery".
   *
   * **A non-matching delivery produces NO push at all — not even a `StateChange`** (measured). A
   * client that also uses this channel to learn that something changed therefore loses that signal
   * for every filtered-out message, which is why Waxwing sends `null` here; see the ADR-017
   * amendment of 2026-08-21.
   */
  filter?: EmailFilter | null
  /**
   * Which `Email` properties to include, e.g. `["from","subject","preview","receivedAt"]`. `null`
   * or absent leaves the choice to the server.
   *
   * Keep it short. The whole push body is capped at 4096 bytes (`WEBPUSH_MAX_BODY_SIZE`), less once
   * RFC 8291 encryption overhead is counted, and Stalwart truncates the property set or the
   * `emails` array itself when the budget runs out — silently, from the client's point of view.
   */
  properties?: string[] | null
  /** RFC 8030 §5.3 urgency, verbatim in the push service's `Urgency` header. Stalwart defaults to `"normal"`. */
  urgency?: 'very-low' | 'low' | 'normal' | 'high' | null
}

/**
 * `draft-ietf-jmap-emailpush-03` — the push frame that carries the mail itself.
 *
 * **It REPLACES the {@link StateChange} for that delivery; the two never both arrive.** Stalwart
 * v0.16.18 builds exactly one notification per delivery and downgrades it to a `StateChange` only
 * when no {@link EmailPushConfig} matches (`crates/services/src/state_manager/push.rs:332`,
 * confirmed on the wire). Anything that reacted to a `StateChange` on the Web Push channel must
 * therefore react to this too, or it stops reacting at all the day `emailPush` is configured.
 *
 * `state` is the change id for `accountId` — the same string a `StateChange` would have carried, and
 * enough to drive a `Foo/changes` sync.
 *
 * Only the Web Push channel is affected. The RFC 8887 WebSocket and the RFC 8620 EventSource channel
 * have no `emailPush` configuration and keep delivering plain `StateChange` frames (measured on the
 * same delivery), which is what keeps Waxwing's sync engine unaffected by any of this.
 */
export interface EmailPush {
  '@type': 'EmailPush'
  accountId: Id
  emails: PushedEmail[]
  /** The account's new state — usable as the `sinceState` of a `Foo/changes` call. */
  state: string
}

/** The `@type` of an {@link EmailPush} frame, so a classifier does not restate the literal. */
export const EMAIL_PUSH_TYPE = 'EmailPush'

/**
 * One message inside an {@link EmailPush}, carrying exactly the properties the subscription asked
 * for — so **every field is optional**, and a client must read it as such rather than as an `Email`.
 *
 * The `emails` array may hold several messages: Stalwart bundles arrivals inside its `push_throttle`
 * window. (Bundling was not provoked in the probe; every observed push held one.)
 */
export interface PushedEmail {
  id?: Id
  blobId?: Id
  threadId?: Id
  mailboxIds?: Record<Id, boolean>
  keywords?: Record<string, boolean>
  size?: number
  receivedAt?: UTCDate
  from?: EmailAddress[] | null
  to?: EmailAddress[] | null
  subject?: string | null
  sentAt?: UTCDate | null
  preview?: string | null
  hasAttachment?: boolean
  [k: string]: unknown
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
