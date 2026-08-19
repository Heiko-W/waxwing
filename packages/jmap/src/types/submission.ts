/**
 * RFC 8621 §6 — Identity (and the reserved EmailSubmission slot). An Identity is an address the
 * user may send from, with an optional reply-to/bcc and text/HTML signatures. Lives under the
 * `urn:ietf:params:jmap:submission` capability. M2.5 uses a one-shot `Identity/get`; M5.1 adds
 * `Identity/set` so the user can manage their own identities and signatures. The
 * `Identity/changes` bindings are kept for a later freshness milestone.
 */

import type {
  ChangesRequest,
  ChangesResponse,
  CreationId,
  FilterOperator,
  GetRequest,
  GetResponse,
  Id,
  PatchObject,
  QueryRequest,
  QueryResponse,
  SetRequest,
  SetResponse,
  UTCDate,
} from './core'
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

/**
 * The properties a client may write on an Identity (RFC 8621 §6). Deliberately NOT
 * `Partial<Identity>`: `id` and `mayDelete` are server-set and `email` is immutable, so a type that
 * accepted them would let a caller send fields the server can only reject — and an `email` in an
 * `update` fails as `invalidProperties`, which is a confusing way to learn that the address of an
 * identity cannot be changed. Create a new identity and destroy the old one instead.
 */
export type IdentityWritable = Partial<
  Pick<Identity, 'name' | 'replyTo' | 'bcc' | 'textSignature' | 'htmlSignature'>
>

/** A new Identity: the writable properties plus the immutable `email`, which only `create` sets. */
export type IdentityCreate = IdentityWritable & Pick<Identity, 'email'>

/**
 * Arguments for `Identity/set` (RFC 8621 §6.3). A standard `/set` except that `create` is narrowed
 * to {@link IdentityCreate}. Extra SetError types: `forbiddenFrom` on create (the user may not send
 * from that address) and `forbidden` on destroy when `mayDelete` is false.
 */
export interface IdentitySetRequest extends Omit<SetRequest<Identity>, 'create'> {
  create?: Record<CreationId, IdentityCreate> | null
}

export type IdentitySetResponse = SetResponse<Identity>

// ── EmailSubmission (RFC 8621 §7) — the send pipeline (M2.8) ──────────────────────────────────

/** An SMTP envelope address with optional ESMTP parameters (RFC 8621 §7.1). */
export interface EmailSubmissionAddress {
  email: string
  parameters?: Record<string, string | null> | null
}

/** The SMTP envelope for a submission; `null` means "derive it from the message" (RFC 8621 §7). */
export interface Envelope {
  mailFrom: EmailSubmissionAddress
  rcptTo: EmailSubmissionAddress[]
}

/** RFC 8621 §7: `pending` while the client can still cancel, then `final` (sent) or `canceled`. */
export type UndoStatus = 'pending' | 'final' | 'canceled'

/** Per-recipient delivery state (RFC 8621 §7.1). */
export interface DeliveryStatus {
  smtpReply: string
  delivered: 'queued' | 'yes' | 'no' | 'unknown'
  displayed: 'unknown' | 'yes'
}

/** An EmailSubmission (RFC 8621 §7.1): the record of one send of an Email. */
export interface EmailSubmission {
  id: Id
  identityId: Id
  /** The Email to send; MAY be `#<creationId>` when created in the same `/set` (back-reference). */
  emailId: Id
  threadId?: Id
  envelope: Envelope | null
  sendAt?: UTCDate
  undoStatus: UndoStatus
  deliveryStatus?: Record<string, DeliveryStatus> | null
  dsnBlobIds?: Id[]
  mdnBlobIds?: Id[]
}

/**
 * Arguments for `EmailSubmission/set` (RFC 8621 §7.5). `onSuccessUpdateEmail` patches the sent
 * Email once the submission is created (canonically: refile Drafts→Sent, clear `$draft`, set
 * `$seen`); its keys are `#<submissionCreationId>` or a submission id.
 */
export interface EmailSubmissionSetRequest {
  accountId: Id
  ifInState?: string | null
  create?: Record<CreationId, Partial<EmailSubmission>> | null
  update?: Record<Id, PatchObject> | null
  destroy?: Id[] | null
  onSuccessUpdateEmail?: Record<string, PatchObject> | null
  onSuccessDestroyEmail?: string[] | null
}

/** Response for `EmailSubmission/set` (RFC 8621 §7.5). */
export type EmailSubmissionSetResponse = SetResponse<EmailSubmission>

export type EmailSubmissionGetRequest = GetRequest
export type EmailSubmissionGetResponse = GetResponse<EmailSubmission>

/**
 * Filter conditions for `EmailSubmission/query` (RFC 8621 §7.2).
 *
 * `undoStatus: 'pending'` plus an `after` in the future is how a client finds the messages a server
 * is holding for later delivery — there is no "Scheduled" mailbox, because a submission is not an
 * Email and lives in no folder.
 */
export interface EmailSubmissionFilterCondition {
  identityIds?: Id[]
  emailIds?: Id[]
  threadIds?: Id[]
  undoStatus?: UndoStatus
  /** Submissions whose `sendAt` is at or after this date. */
  after?: UTCDate
  /** Submissions whose `sendAt` is before this date. */
  before?: UTCDate
}

export type EmailSubmissionFilter = FilterOperator | EmailSubmissionFilterCondition

export type EmailSubmissionQueryRequest = Omit<QueryRequest, 'filter'> & {
  filter?: EmailSubmissionFilter | null
}

export type EmailSubmissionQueryResponse = QueryResponse
