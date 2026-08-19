/**
 * RFC 9661 — JMAP for Sieve Scripts (FR-SIEVE-01/02).
 *
 * Four methods, no more: `/get`, `/set`, `/query`, `/validate`. There is deliberately **no
 * `/changes` and no `/queryChanges`** in the RFC, so scripts cannot be synced incrementally —
 * a settings surface re-reads them instead.
 *
 * **Script content never travels inside these objects.** A {@link SieveScript} carries only a
 * {@link SieveScript.blobId}; the octets are uploaded and downloaded through the RFC 8620 §6
 * blob endpoints. RFC 9661 §2.2 is explicit: "Script content must first be uploaded as per
 * Section 2.2 prior to referencing it in a SieveScript/set call." Early drafts (-01, -02) did
 * carry an inline `content` string, which is why half the material on the web shows one; -03
 * reverted it and no shipping server accepts it today.
 *
 * The blob id a `/set` returns is **not** the one that was uploaded — the server stores the
 * script and mints its own. Never cache the upload id as if it addressed the script.
 */

import type {
  Comparator,
  FilterOperator,
  GetRequest,
  GetResponse,
  Id,
  QueryRequest,
  QueryResponse,
  SetError,
  SetRequest,
  SetResponse,
  UnsignedInt,
} from './core'

/** Media type for a Sieve script upload (RFC 5228 §6). */
export const SIEVE_CONTENT_TYPE = 'application/sieve'

/** A stored Sieve script (RFC 9661 §2.1). */
export interface SieveScript {
  /** Immutable, server-set. */
  id: Id
  /**
   * User-visible name, unique within the account. Servers MUST reject the C0/C1 control
   * characters plus U+2028/U+2029 for ManageSieve compatibility, and cap the length at
   * {@link SieveAccountCapability.maxSizeScriptName}.
   */
  name: string | null
  /** The blob holding the raw octets of the script. */
  blobId: Id
  /**
   * Server-set: whether this script is the one filtering incoming mail. At most one script per
   * account is active. Set it through {@link SieveScriptSetRequest.onSuccessActivateScript}
   * rather than by patching this property — see that field for why.
   */
  isActive: boolean
}

/**
 * The session-level `urn:ietf:params:jmap:sieve` object (RFC 9661 §1.2.1) — the server's
 * implementation name and version. The per-account limits live in
 * {@link SieveAccountCapability} instead.
 */
export interface SieveCapability {
  implementation: string
}

/** The account-level `urn:ietf:params:jmap:sieve` object (RFC 9661 §1.2.1). */
export interface SieveAccountCapability {
  /** Maximum script name length in octets; at least 512. */
  maxSizeScriptName: UnsignedInt
  /** Maximum script size in octets; `null` = unlimited. */
  maxSizeScript: UnsignedInt | null
  /** Maximum number of scripts in the account; `null` = unlimited. */
  maxNumberScripts: UnsignedInt | null
  /** Maximum `redirect` actions **per evaluation**, not per script; `null` = unlimited. */
  maxNumberRedirects: UnsignedInt | null
  /**
   * Case-sensitive extension strings this server accepts in a `require` line.
   *
   * Worth checking before a save rather than after: a server may compile a script containing a
   * `require` for an extension it does not have, and only fail at delivery time — so
   * {@link SieveScriptValidateResponse} coming back clean does not prove the `require` line is
   * satisfiable.
   */
  sieveExtensions: string[]
  /** URI schemes usable with the `enotify` extension; `null` when unsupported. */
  notificationMethods: string[] | null
  /** URI schemes usable with the `extlists` extension; `null` when unsupported. */
  externalLists: string[] | null
}

export type SieveScriptGetRequest = GetRequest
export type SieveScriptGetResponse = GetResponse<SieveScript>

/** `SieveScript/set` (RFC 9661 §2.4). */
export interface SieveScriptSetRequest extends SetRequest<SieveScript> {
  /**
   * Activate this script if every create/update/destroy in the call succeeds, deactivating
   * whatever was active before. Accepts a creation reference (`#creationId`).
   *
   * **`null` does not deactivate.** The RFC requires an absent, invalid or unknown id to be
   * ignored, leaving the active script as it was — use {@link onSuccessDeactivateScript}.
   */
  onSuccessActivateScript?: Id | null
  /** Deactivate the active script if every change in the call succeeds. Processed first. */
  onSuccessDeactivateScript?: boolean | null
}

export type SieveScriptSetResponse = SetResponse<SieveScript>

/** Filter for `SieveScript/query` (RFC 9661 §2.5). Both conditions MUST be supported. */
export interface SieveScriptFilterCondition {
  /** Substring match against the script name. */
  name?: string
  isActive?: boolean
}

/** A SieveScript query filter: a boolean group or a single condition. */
export type SieveScriptFilter = FilterOperator | SieveScriptFilterCondition

/** The properties RFC 9661 §2.5 requires a server to sort on. */
export interface SieveScriptComparator extends Comparator {
  property: 'name' | 'isActive'
}

export type SieveScriptQueryRequest = Omit<QueryRequest, 'filter' | 'sort'> & {
  filter?: SieveScriptFilter | null
  sort?: SieveScriptComparator[] | null
}

export type SieveScriptQueryResponse = QueryResponse

/** `SieveScript/validate` (RFC 9661 §2.6) — the content is addressed by blob, as everywhere else. */
export interface SieveScriptValidateRequest {
  accountId: Id
  blobId: Id
}

/**
 * Response for `SieveScript/validate` (RFC 9661 §2.6).
 *
 * There is no `isValid` field: **valid means `error === null`**. The human-readable reason is in
 * `error.description`, which SHOULD name at least the line of the first problem.
 */
export interface SieveScriptValidateResponse {
  accountId: Id
  error: SetError | null
}

/**
 * The `SetError` types RFC 9661 §2.4 defines, each paired with the pre-RFC spelling.
 *
 * Draft -17 renamed `invalidScript` → `invalidSieve` and `scriptIsActive` → `sieveIsActive`.
 * Stalwart still emits the old names, so a client that matches only the RFC spelling silently
 * misreads a rejected save as an unknown failure. Match both.
 */
export const SieveSetErrors = {
  invalidSieve: ['invalidSieve', 'invalidScript'],
  sieveIsActive: ['sieveIsActive', 'scriptIsActive'],
} as const

/** Whether `type` is "this script does not compile", under either spelling. */
export function isInvalidSieveError(type: string): boolean {
  return (SieveSetErrors.invalidSieve as readonly string[]).includes(type)
}

/**
 * Whether `type` is "cannot destroy the active script", under either spelling. Deactivating and
 * destroying have to be separate `/set` calls (RFC 9661 §2.4).
 */
export function isSieveIsActiveError(type: string): boolean {
  return (SieveSetErrors.sieveIsActive as readonly string[]).includes(type)
}
