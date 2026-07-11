/**
 * RFC 8621 §6 — Identity (and the reserved EmailSubmission slot). An Identity is an address the
 * user may send from, with an optional reply-to/bcc and text/HTML signatures. Lives under the
 * `urn:ietf:params:jmap:submission` capability. M2.5 uses a one-shot `Identity/get`; the
 * `Identity/changes` bindings are kept for a later freshness milestone.
 */

import type { ChangesRequest, ChangesResponse, GetRequest, GetResponse, Id } from './core'
import type { EmailAddress } from './mail'

/** An Identity (RFC 8621 §6.1): a From address with optional reply-to/bcc and signatures. */
export interface Identity {
  id: Id
  name: string
  email: string
  replyTo: EmailAddress[] | null
  bcc: EmailAddress[] | null
  textSignature: string
  htmlSignature: string
  mayDelete: boolean
}

export type IdentityGetRequest = GetRequest
export type IdentityGetResponse = GetResponse<Identity>
// Identity/changes is deferred (M2.5 uses a one-shot get); the bindings are kept for later.
export type IdentityChangesRequest = ChangesRequest
export type IdentityChangesResponse = ChangesResponse
