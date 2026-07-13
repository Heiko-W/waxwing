/**
 * RFC 8620 (JMAP Core) wire types.
 *
 * These model the JSON exactly as it appears on the wire, so absent-but-nullable
 * fields are `T | null` (not optional) while genuinely optional request fields use `?`.
 * Servers may add unknown properties; readers must ignore them (hence the index
 * signatures on {@link Session} and {@link Account}).
 */

/** Server-assigned, immutable identifier. 1–255 chars of `[A-Za-z0-9_-]` (RFC 8620 §1.2). */
export type Id = string

/** Client-chosen temporary id for a record created in a `/set`; referenced elsewhere as `#<creationId>`. */
export type CreationId = string

/** Signed integer in the range −(2^53−1) … (2^53−1). */
export type Int = number

/** Non-negative {@link Int} (≥ 0). */
export type UnsignedInt = number

/** RFC 3339 date-time that MAY carry a numeric UTC offset (e.g. `2014-10-30T14:12:00+08:00`). */
export type JmapDate = string

/** RFC 3339 date-time normalised to UTC (`Z` offset), e.g. `2014-10-30T06:12:00Z`. */
export type UTCDate = string

/**
 * RFC 6901 JSON Pointer extended (RFC 8620 §3.7) so `*` maps over an array and
 * flattens the result. Always begins with `/`.
 */
export type ExtendedJSONPointer = `/${string}`

/**
 * The JMAP Session object, fetched from `/.well-known/jmap` (RFC 8620 §2).
 *
 * The four `*Url` fields MAY be relative and are resolved against the session
 * resource URL by {@link getSession}. Unknown properties are preserved via the
 * index signature.
 */
export interface Session {
  /** Capability URI → capability object. MUST contain `urn:ietf:params:jmap:core`. */
  capabilities: Record<string, unknown>
  /** accountId → {@link Account} the user has access to. */
  accounts: Record<Id, Account>
  /** Capability URI → default accountId for that capability. */
  primaryAccounts: Record<string, Id>
  /** Username used to authenticate, or `""` if none. */
  username: string
  /** Endpoint the JMAP API Request is POSTed to. */
  apiUrl: string
  /** URI Template (RFC 6570 L1) with vars `{accountId} {blobId} {type} {name}`. */
  downloadUrl: string
  /** URI Template with var `{accountId}`. */
  uploadUrl: string
  /** URI Template with vars `{types} {closeafter} {ping}`. */
  eventSourceUrl: string
  /** Opaque state string; changes whenever any Session property changes. Equals `JmapResponse.sessionState`. */
  state: string
  [k: string]: unknown
}

/** An account exposed in {@link Session.accounts} (RFC 8620 §2). */
export interface Account {
  /** Human-readable label, e.g. the account's email address. */
  name: string
  /** `true` if the account belongs to the authenticated user. */
  isPersonal: boolean
  /** `true` if the whole account is read-only. */
  isReadOnly: boolean
  /** Capability URI → per-account capability object (methods usable on this account). */
  accountCapabilities: Record<string, unknown>
  [k: string]: unknown
}

/**
 * The value stored under `session.capabilities["urn:ietf:params:jmap:core"]`
 * (RFC 8620 §2). The RFC defines no defaults or minimums for these limits — always
 * read the actual numbers from the Session.
 */
export interface CoreCapability {
  /** Max bytes of a single blob upload. */
  maxSizeUpload: UnsignedInt
  /** Max simultaneous uploads. */
  maxConcurrentUpload: UnsignedInt
  /** Max bytes of one API request body. */
  maxSizeRequest: UnsignedInt
  /** Max simultaneous API requests. */
  maxConcurrentRequests: UnsignedInt
  /** Max method calls in one `Request.methodCalls`. */
  maxCallsInRequest: UnsignedInt
  /** Max ids passed to a single `/get`. */
  maxObjectsInGet: UnsignedInt
  /** Max create + update + destroy records in a single `/set`. */
  maxObjectsInSet: UnsignedInt
  /** RFC 4790 collation identifiers the server supports. */
  collationAlgorithms: string[]
}

/**
 * The value stored under `session.capabilities["urn:ietf:params:jmap:webpush-vapid"]`
 * (RFC 9749 §3).
 *
 * Its presence is the ONLY way a browser client can learn the key that
 * `PushManager.subscribe()` requires — Chromium and Safari refuse to subscribe without one, and the
 * push service then rejects any POST the server did not sign with the matching private key
 * (RFC 8292 §4.2). A server that omits this capability therefore cannot reach a browser with Web
 * Push at all. No JMAP server implements it today; see ADR-010.
 */
export interface WebPushVapidCapability {
  /** The server's ECDSA P-256 public key, uncompressed and base64url-encoded (RFC 8292 §3.2). */
  applicationServerKey: string
}

/**
 * A single method call or response: the readonly 3-tuple `[name, args, methodCallId]`
 * (RFC 8620 §3.2). A method MAY emit more than one response invocation, all echoing
 * the same `methodCallId`.
 */
export type Invocation<A = unknown> = readonly [name: string, args: A, methodCallId: string]

/** The JSON body POSTed to `apiUrl` (RFC 8620 §3.3). */
export interface JmapRequest {
  /** Capability URNs the client opts into; the server behaves as if it implements only these. */
  using: string[]
  /** Method calls, processed strictly sequentially in order. */
  methodCalls: Invocation[]
  /** Optional seed map creationId → real id (RFC 8620 §5.8). */
  createdIds?: Record<CreationId, Id>
}

/** The JSON body returned from `apiUrl` (RFC 8620 §3.4). */
export interface JmapResponse {
  /** Responses in the order the methods were processed (one method may emit several). */
  methodResponses: Invocation[]
  /** Present iff the request sent `createdIds`; includes seeded + newly created ids. */
  createdIds?: Record<CreationId, Id>
  /** Current `Session.state`; refetch the Session if it changed. */
  sessionState: string
}

/**
 * A back-reference (RFC 8620 §3.7): used as the value of a `#`-prefixed argument name,
 * resolved by the server against an earlier call's response before the method runs.
 */
export interface ResultReference {
  /** `methodCallId` of an earlier call in the same request. */
  resultOf: string
  /** Expected response name of that call. */
  name: string
  /** Pointer into that response; `*` maps over arrays and flattens. */
  path: ExtendedJSONPointer
}

/**
 * A `PatchObject` for `/set` updates (RFC 8620 §5.3): a map of implicit-`/`-prefixed
 * JSON Pointer paths to values (`null` removes / resets to default). A whole record is
 * itself a valid PatchObject.
 */
export type PatchObject = Record<string, unknown>

// ── Standard method argument / response shapes (RFC 8620 §5) ────────────────────────

/** Arguments for `Foo/get` (RFC 8620 §5.1). `ids: null` means "all records". */
export interface GetRequest {
  accountId: Id
  ids?: Id[] | null
  properties?: string[] | null
}

/** Response for `Foo/get` (RFC 8620 §5.1). */
export interface GetResponse<T> {
  accountId: Id
  /** State string for the record type; usable as `sinceState` for `/changes`. */
  state: string
  list: T[]
  notFound: Id[]
}

/** Arguments for `Foo/changes` (RFC 8620 §5.2). */
export interface ChangesRequest {
  accountId: Id
  sinceState: string
  maxChanges?: UnsignedInt | null
}

/** Response for `Foo/changes` (RFC 8620 §5.2). Loop while `hasMoreChanges` using `newState`. */
export interface ChangesResponse {
  accountId: Id
  oldState: string
  newState: string
  hasMoreChanges: boolean
  created: Id[]
  updated: Id[]
  destroyed: Id[]
}

/** Arguments for `Foo/set` (RFC 8620 §5.3). At least one of create/update/destroy is required. */
export interface SetRequest<T> {
  accountId: Id
  ifInState?: string | null
  create?: Record<CreationId, Partial<T>> | null
  update?: Record<Id, PatchObject> | null
  destroy?: Id[] | null
}

/** Response for `Foo/set` (RFC 8620 §5.3). */
export interface SetResponse<T> {
  accountId: Id
  oldState: string | null
  newState: string
  created: Record<CreationId, T> | null
  updated: Record<Id, T | null> | null
  destroyed: Id[] | null
  notCreated: Record<CreationId, SetError> | null
  notUpdated: Record<Id, SetError> | null
  notDestroyed: Record<Id, SetError> | null
}

/** A comparator for `/query` sorting (RFC 8620 §5.5). */
export interface Comparator {
  property: string
  /** Defaults to `true`. */
  isAscending?: boolean
  /** RFC 4790 collation identifier. */
  collation?: string
}

/** A boolean filter group (RFC 8620 §5.5). */
export interface FilterOperator {
  operator: 'AND' | 'OR' | 'NOT'
  conditions: (FilterOperator | FilterCondition)[]
}

/** A type-specific filter condition; MUST NOT contain an `operator` key (RFC 8620 §5.5). */
export type FilterCondition = Record<string, unknown>

/** Arguments for `Foo/query` (RFC 8620 §5.5). */
export interface QueryRequest {
  accountId: Id
  filter?: FilterOperator | FilterCondition | null
  sort?: Comparator[] | null
  position?: Int
  anchor?: Id | null
  anchorOffset?: Int
  limit?: UnsignedInt | null
  calculateTotal?: boolean
}

/** Response for `Foo/query` (RFC 8620 §5.5). `total` present only if `calculateTotal` was true. */
export interface QueryResponse {
  accountId: Id
  queryState: string
  canCalculateChanges: boolean
  position: UnsignedInt
  ids: Id[]
  total?: UnsignedInt
  limit?: UnsignedInt
}

/** Arguments for `Foo/queryChanges` (RFC 8620 §5.6). `filter`/`sort` MUST match the original query. */
export interface QueryChangesRequest {
  accountId: Id
  filter?: FilterOperator | FilterCondition | null
  sort?: Comparator[] | null
  sinceQueryState: string
  maxChanges?: UnsignedInt | null
  upToId?: Id | null
  calculateTotal?: boolean
}

/** An item added at `index` in a `/queryChanges` response (RFC 8620 §5.6). */
export interface AddedItem {
  id: Id
  index: UnsignedInt
}

/** Response for `Foo/queryChanges` (RFC 8620 §5.6). Apply `removed` first, then splice `added`. */
export interface QueryChangesResponse {
  accountId: Id
  oldQueryState: string
  newQueryState: string
  total?: UnsignedInt
  removed: Id[]
  added: AddedItem[]
}

// ── Error wire shapes (RFC 8620 §3.6) ───────────────────────────────────────────────

/**
 * Request-level RFC 7807 problem details (RFC 8620 §3.6.1), served with
 * `Content-Type: application/problem+json` and HTTP 400.
 */
export interface ProblemDetails {
  type: string
  status?: number
  detail?: string
  instance?: string
  /** Present on `urn:ietf:params:jmap:error:limit`; names the exceeded limit. */
  limit?: string
  [k: string]: unknown
}

/** The args object of a method-level `["error", …]` response invocation (RFC 8620 §3.6.2). */
export interface MethodErrorObject {
  type: string
  description?: string
  [k: string]: unknown
}

/** A per-record failure inside a `/set` or `/copy` response (RFC 8620 §5.3). */
export interface SetError {
  type: string
  description: string | null
  /** SHOULD be set for `invalidProperties`, naming the offending fields. */
  properties?: string[]
  /** Set for the copy-specific `alreadyExists` error. */
  existingId?: Id
}
