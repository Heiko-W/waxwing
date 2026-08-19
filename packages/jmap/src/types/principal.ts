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
 * `text` rather than `name`: measured against Stalwart 0.16, `name` matches nothing while `text`
 * matches substrings of both the name and the address. An empty query returns `null` — "no filter"
 * — which lists everyone the account may see, and is the right starting state for a picker.
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
export type ShareNotificationQueryRequest = QueryRequest
export type ShareNotificationQueryResponse = QueryResponse
