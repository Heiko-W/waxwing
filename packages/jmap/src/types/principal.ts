/**
 * JMAP Sharing — `Principal` and `ShareNotification` (RFC 9670, M5.18).
 *
 * A principal is whoever a thing can be shared WITH: a person, a group, a room. The RFC defines it
 * generically so that mailboxes, calendars and file nodes all name their grantees the same way,
 * and `shareWith` on any of them is a map from principal id to the rights granted.
 *
 * **Measured against Stalwart 0.16, and the measurement changed the code.** RFC 9670 §2.3 defines
 * a `name` filter condition; Stalwart returns an EMPTY result for it. `text` and `email` both
 * work — `text` as a substring match, `email` as an exact one. A picker built on `name` because
 * the RFC lists it would look like a search box that finds nobody, with a 200 and no error to say
 * why. {@link principalSearchFilter} exists so that mistake has one place to not be made.
 */

import type {
  ChangesRequest,
  ChangesResponse,
  FilterOperator,
  GetRequest,
  GetResponse,
  Id,
  QueryRequest,
  QueryResponse,
  SetRequest,
  SetResponse,
  UTCDate,
} from './core'

/**
 * The account-level `urn:ietf:params:jmap:principals` object (measured against Stalwart 0.16).
 *
 * `currentUserPrincipalId` is how a picker knows which principal is the user themself. It happens
 * to equal the account id on Stalwart, and building on that coincidence would be a bug waiting for
 * a server that numbers them separately — the RFC gives this property for exactly this purpose.
 */
export interface PrincipalCapability {
  currentUserPrincipalId: Id | null
}

/** What kind of thing a principal is (RFC 9670 §2). Stalwart returns `individual` for accounts. */
export type PrincipalType = 'individual' | 'group' | 'resource' | 'location' | 'other'

/**
 * Someone a thing can be shared with.
 *
 * Only `id` and `type` are guaranteed; Stalwart also sends `name`, `description` and `email`, and
 * every one of those is optional in the RFC. A picker that assumes `email` is present would show
 * blanks against a group, which has no address.
 */
export interface Principal {
  id: Id
  type: PrincipalType
  /** The display name. Absent on a principal the server chooses not to name. */
  name?: string | null
  description?: string | null
  email?: string | null
  timeZone?: string | null
  /** Account ids this principal can reach, by capability URI. */
  accounts?: Record<Id, unknown> | null
}

export type PrincipalGetRequest = GetRequest
export type PrincipalGetResponse = GetResponse<Principal>
export type PrincipalChangesRequest = ChangesRequest
export type PrincipalChangesResponse = ChangesResponse
export type PrincipalSetRequest = SetRequest<Principal>
export type PrincipalSetResponse = SetResponse<Principal>

/**
 * RFC 9670 §2.3.
 *
 * `name` is listed here because the RFC defines it, NOT because it works — see the module note.
 * Use {@link principalSearchFilter} to build a filter from what a user typed.
 */
export interface PrincipalFilterCondition {
  accountIds?: readonly Id[]
  email?: string
  name?: string
  text?: string
  type?: PrincipalType
  timeZone?: string
}

export type PrincipalFilter = FilterOperator | PrincipalFilterCondition

export type PrincipalQueryRequest = Omit<QueryRequest, 'filter'> & {
  filter?: PrincipalFilter | null
}
export type PrincipalQueryResponse = QueryResponse

/**
 * The filter for a free-text principal search.
 *
 * `text` rather than `name`: measured against Stalwart 0.16, `name` matches only the FULL login
 * address (`{name:"bob@waxwing.test"}` → the hit, `{name:"alice"}` → nothing) while `text` searches
 * the name, the description and the address together. An empty query returns `null` — "no filter" —
 * which lists everyone the account may see, and is the right starting state for a picker.
 *
 * **It matches WHOLE WORDS, not prefixes, and a caller has to design around that** (re-measured
 * against v0.16.18 on 2026-08-21, correcting an earlier note here that called it a substring match):
 * ```
 * text:"Baker" → [c]     text:"bak"  → []      text:"bak*" → []
 * text:"alice" → [b]     text:"ali"  → []      text:"b*"   → []
 * text:"carol chen" → [d]   (several words AND together)
 * text:"bob@waxwing.test" → []   (the address is tokenised; the whole of it matches nothing)
 * ```
 * So an as-you-type search stays empty until a complete word has been typed, and then answers. No
 * wildcard syntax is accepted. `{email:"bob@waxwing.test"}` is an exact match and is the way to
 * find someone by an address typed in full.
 */
export function principalSearchFilter(query: string): PrincipalFilterCondition | null {
  const trimmed = query.trim()
  return trimmed === '' ? null : { text: trimmed }
}

/**
 * A notification that something was shared with, or unshared from, this account (RFC 9670 §3).
 *
 * Read-only: the server creates these, and a client destroys them once the user has seen them.
 */
export interface ShareNotification {
  id: Id
  created: string
  changedBy: {
    name?: string | null
    email?: string | null
    principalId?: Id | null
  }
  objectType: string
  objectAccountId: Id
  objectId: Id
  oldRights?: Record<string, boolean> | null
  newRights?: Record<string, boolean> | null
  name?: string | null
}

export type ShareNotificationGetRequest = GetRequest
export type ShareNotificationGetResponse = GetResponse<ShareNotification>
export type ShareNotificationChangesRequest = ChangesRequest
export type ShareNotificationChangesResponse = ChangesResponse
export type ShareNotificationSetRequest = SetRequest<ShareNotification>
export type ShareNotificationSetResponse = SetResponse<ShareNotification>

/**
 * RFC 9670 §3.3 filter conditions. `objectType` is measured — Stalwart v0.16.18 answers
 * `{ objectType: "Mailbox" }` with exactly the mailbox notifications and drops the calendar ones.
 *
 * `before`/`after` are the RFC's and are NOT measured here; a caller that needs "only since X"
 * should sort by `created` and stop reading rather than trust an untested condition.
 */
export interface ShareNotificationFilterCondition {
  before?: UTCDate
  after?: UTCDate
  objectType?: string
  objectAccountId?: Id
}

export type ShareNotificationFilter = FilterOperator | ShareNotificationFilterCondition

export type ShareNotificationQueryRequest = Omit<QueryRequest, 'filter'> & {
  filter?: ShareNotificationFilter | null
}
export type ShareNotificationQueryResponse = QueryResponse

/**
 * The RFC 8620 §7.1 `StateChange` type name for share notifications.
 *
 * **Measured, and the answer decides the whole design of an "incoming shares" surface.** Over a
 * WebSocket with `WebSocketPushEnable`, Stalwart v0.16.18 emits
 * `{"@type":"StateChange","changed":{"<own account>":{"ShareNotification":"<state>"}}}` the moment
 * someone else's `Mailbox/set … shareWith` names this user — a separate frame from the `Mailbox`
 * one the OWNER gets. So a client can LISTEN; it does not have to poll. The name has to be in the
 * push subscription's `types`, or the server filters the frame out before it is sent.
 */
export const SHARE_NOTIFICATION_TYPE = 'ShareNotification'
