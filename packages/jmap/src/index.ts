/**
 * `@waxwing/jmap` — a small, typed, zero-dependency JMAP client (MIT).
 *
 * SP.1 ships the core plumbing — session discovery, an auth-scheme abstraction, a batched
 * request layer with back-references, transparent auto-chunking against the session limits
 * (FR-SRV-03) and the RFC 8620 error/type surface — plus the RFC 8621 mail types (Mailbox,
 * Thread, Email), a typed method registry, and blob upload/download. Remaining data-type
 * modules (Submission, Vacation, Quota, Sieve, Contacts, …) are layered on in later phases;
 * see `types/index.ts` and `capabilities.ts` for the reserved slots.
 */

// Auth-scheme abstraction (FR-AUTH-04 groundwork).
export type { AuthProvider } from './auth'
export { applyAuth, basic, bearer } from './auth'
// Blob transfer (RFC 8620 §6): upload / download via the session URI templates.
export type {
  BlobData,
  BlobProgress,
  DownloadOptions,
  DownloadVars,
  UploadOptions,
  UploadResult,
} from './blob'
export { DEFAULT_BLOB_TYPE, downloadBlob, expandUriTemplate, uploadBlob } from './blob'
export type { CapabilityUrn } from './capabilities'
// Capability URNs + method → capability mapping.
export { Capabilities, capabilityForMethod, usingForMethods } from './capabilities'
// Auto-chunking (exposed for testing and advanced callers).
export type { ChunkLimits, ChunkPlan } from './chunking'
export { planRequest, reassembleResponses } from './chunking'
// Client + connection.
export type { CallOptions, ConnectOptions, JmapClientOptions } from './client'
export { connect, FALLBACK_LIMITS, JmapClient } from './client'
// Error hierarchy (RFC 8620 §3.6, RFC 8887 §4.2).
export {
  errorFromResponse,
  isMethodError,
  isMethodErrorType,
  isSetErrorType,
  JmapError,
  JmapHttpError,
  JmapMethodError,
  JmapProblemError,
  JmapRequestError,
  MethodErrorTypes,
  ProblemTypes,
  parseRetryAfter,
} from './errors'
// Typed method registry (RFC 8620/8621 methods bound to their arg/response types).
export type { MethodName } from './methods'
export { Methods } from './methods'
// Push transports (SP.3, FR-NOTIF-01): WebSocket (RFC 8887) + fetch-based SSE, auto-selected.
export * from './push'
// Request builder + response view + back-reference helpers.
export type { BackReferenceArgs, MethodDef, TypedCallHandle } from './request'
export { CallHandle, creationRef, defineMethod, MethodResponses, RequestBuilder } from './request'
// Session discovery + helpers.
export type { GetSessionOptions } from './session'
export {
  getCoreCapability,
  getMailCapability,
  getSession,
  getWebPushVapidCapability,
  hasCapability,
  normalizeSession,
  resolveUrl,
  sessionStateChanged,
  toWellKnownUrl,
  WELL_KNOWN_PATH,
} from './session'
// Transport (injectable fetch).
export type { FetchLike, Transport } from './transport'
export { getWithAuth, postApi, resolveFetch } from './transport'
// Wire types (RFC 8620 core + RFC 8621 mail).
export type * from './types/index'
// Runtime value(s) from the types modules (the type-only re-export above strips values).
export { MailboxRoles } from './types/mail'
export { EMAIL_DELIVERY_TYPE } from './types/push'
export { VACATION_SINGLETON_ID } from './types/vacation'
