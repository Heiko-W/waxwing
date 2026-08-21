/**
 * RFC 9425 — JMAP Quotas. Read-only: a client may `get`/`changes`/`query` a Quota, never set one.
 *
 * A server may expose several (a byte quota for mail, an object-count quota for files, a
 * domain-wide one, …), so the client picks the one worth showing rather than assuming there is
 * exactly one. Capability: `urn:ietf:params:jmap:quota`.
 */

import type {
  ChangesRequest,
  ChangesResponse,
  GetRequest,
  GetResponse,
  Id,
  UnsignedInt,
} from './core'

/** `octets` = bytes stored; `count` = number of objects (RFC 9425 §1.4). */
export type QuotaResourceType = 'count' | 'octets'

/** Whose allowance this is: the account's own, the whole domain's, or the server's. */
export type QuotaScope = 'account' | 'domain' | 'global'

export interface Quota {
  id: Id
  resourceType: QuotaResourceType
  used: UnsignedInt
  /** The allowance. Exceeding it fails the operation (`overQuota`). */
  hardLimit: UnsignedInt
  scope: QuotaScope
  /** Human-readable name of the quota's subject (Stalwart sends the account's address). */
  name: string
  /** The JMAP data types this quota counts, e.g. `["Email"]`. */
  types: string[]
  /** The server's own "warn the user now" threshold; `null` = the server offers none. */
  warnLimit: UnsignedInt | null
  /** A limit above which the server may start refusing non-essential writes; `null` = none. */
  softLimit: UnsignedInt | null
  description: string | null
}

export type QuotaGetRequest = GetRequest
export type QuotaGetResponse = GetResponse<Quota>
/**
 * Reserved for a later freshness milestone; the app polls on a TTL today. Exists on v0.16.18
 * (measured) but has no {@link Methods} entry — see the deliberate-absence note there.
 */
export type QuotaChangesRequest = ChangesRequest
export type QuotaChangesResponse = ChangesResponse
