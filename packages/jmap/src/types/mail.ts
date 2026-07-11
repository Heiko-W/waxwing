/**
 * RFC 8621 (JMAP for Mail) wire types: Mailbox, Thread, Email (+ SearchSnippet is
 * reserved for later) and the argument / response shapes of their methods.
 *
 * These model the JSON exactly as it appears on the wire: absent-but-nullable fields are
 * `T | null` (not optional). A property the client did not request in a `/get` is simply
 * absent from the returned object, so `/get` results are effectively `Partial<>` — callers
 * that fetch a subset should type the record accordingly.
 *
 * Capability URI: `urn:ietf:params:jmap:mail`.
 */

import type {
  ChangesRequest,
  ChangesResponse,
  Comparator,
  CreationId,
  FilterOperator,
  GetRequest,
  GetResponse,
  Id,
  JmapDate,
  PatchObject,
  QueryChangesRequest,
  QueryChangesResponse,
  QueryRequest,
  QueryResponse,
  SetResponse,
  UnsignedInt,
  UTCDate,
} from './core'

// ── Capability ───────────────────────────────────────────────────────────────────────

/**
 * The value stored under `account.accountCapabilities["urn:ietf:params:jmap:mail"]`
 * (RFC 8621 §1.4). `maxMailboxesPerEmail` / `maxMailboxDepth` may be `null` (unlimited) —
 * guard for `null` before any numeric comparison.
 */
export interface MailCapability {
  /** Max mailboxes an Email may be in at once; `null` = unlimited. */
  maxMailboxesPerEmail: UnsignedInt | null
  /** Max mailbox nesting depth; `null` = unlimited. */
  maxMailboxDepth: UnsignedInt | null
  /** Max Mailbox name length in UTF-8 octets. */
  maxSizeMailboxName: UnsignedInt
  /** Max total unencoded octets of attachments per Email. */
  maxSizeAttachmentsPerEmail: UnsignedInt
  /** Email property names usable in an `Email/query` sort. `receivedAt` is always supported. */
  emailQuerySortOptions: string[]
  /** Whether the user may create a top-level (parentless) Mailbox. */
  mayCreateTopLevelMailbox: boolean
}

// ── Mailbox (RFC 8621 §2) ──────────────────────────────────────────────────────────────

/**
 * Known IANA mailbox roles (lower-cased). The registry is open, so {@link Mailbox.role}
 * is typed as a `string`; these constants document the values Waxwing acts on.
 */
export const MailboxRoles = {
  all: 'all',
  archive: 'archive',
  drafts: 'drafts',
  flagged: 'flagged',
  important: 'important',
  inbox: 'inbox',
  junk: 'junk',
  sent: 'sent',
  subscribed: 'subscribed',
  trash: 'trash',
} as const

/** A known role value from {@link MailboxRoles}. */
export type MailboxKnownRole = (typeof MailboxRoles)[keyof typeof MailboxRoles]

/**
 * Per-mailbox permissions (RFC 8621 §2), each mapping to IMAP ACL letters. Server-set;
 * an Email is fetchable only if it is in at least one Mailbox with `mayReadItems`.
 */
export interface MailboxRights {
  /** May fetch the emails in this mailbox (IMAP `lr`). */
  mayReadItems: boolean
  /** May add emails to this mailbox (IMAP `i`). */
  mayAddItems: boolean
  /** May remove emails from this mailbox (IMAP `te`). */
  mayRemoveItems: boolean
  /** May set the `$seen` keyword (IMAP `s`). */
  maySetSeen: boolean
  /** May set keywords other than `$seen` (IMAP `w`). */
  maySetKeywords: boolean
  /** May create a child mailbox (IMAP `k`). */
  mayCreateChild: boolean
  /** May rename this mailbox (IMAP `x`). */
  mayRename: boolean
  /** May delete this mailbox (IMAP `x`). */
  mayDelete: boolean
  /** May submit (send) messages from this mailbox (IMAP `p`). */
  maySubmit: boolean
}

/** A Mailbox (RFC 8621 §2). Only `name`, `parentId`, `role`, `sortOrder` and `isSubscribed` are mutable. */
export interface Mailbox {
  /** Immutable, server-set. */
  id: Id
  /** Net-Unicode display name, unique among siblings. */
  name: string
  /** Parent mailbox id, or `null` for a top-level mailbox. */
  parentId: Id | null
  /** IANA role (lower-cased), or `null`. At most one mailbox per role per account. */
  role: string | null
  /** Sort hint; lower shown first, ties broken alphabetically by `name`. */
  sortOrder: UnsignedInt
  /** Server-set count of all emails in this mailbox. */
  totalEmails: UnsignedInt
  /** Server-set count of emails lacking both `$seen` and `$draft`. */
  unreadEmails: UnsignedInt
  /** Server-set count of threads with ≥ 1 email in this mailbox. */
  totalThreads: UnsignedInt
  /** Server-set count of threads considered unread in this mailbox. */
  unreadThreads: UnsignedInt
  /** Server-set effective permissions for the authenticated user. */
  myRights: MailboxRights
  /** Whether the user is subscribed to this mailbox. */
  isSubscribed: boolean
}

/** Filter conditions for `Mailbox/query` (RFC 8621 §2.3). Multiple present fields are ANDed. */
export interface MailboxFilterCondition {
  /** Exact parent id (or `null` for top-level). */
  parentId?: Id | null
  /** Substring match on the name. */
  name?: string
  /** Exact role match (or `null`). */
  role?: string | null
  /** `true` = has any role; `false` = has no role. */
  hasAnyRole?: boolean
  /** Match on subscription state. */
  isSubscribed?: boolean
}

/** A `Mailbox/query` filter: a boolean group or a single condition. */
export type MailboxFilter = FilterOperator | MailboxFilterCondition

/** Arguments for `Mailbox/get` (standard `/get`, RFC 8621 §2.1). */
export type MailboxGetRequest = GetRequest
/** Response for `Mailbox/get`. */
export type MailboxGetResponse = GetResponse<Mailbox>

/** Arguments for `Mailbox/changes` (standard `/changes`, RFC 8621 §2.2). */
export type MailboxChangesRequest = ChangesRequest
/**
 * Response for `Mailbox/changes`. When `updatedProperties` is non-null the only changes are
 * to the four count properties, so the client can patch counts without a full `Mailbox/get`;
 * `null` means fetch the changed mailboxes fully.
 */
export interface MailboxChangesResponse extends ChangesResponse {
  updatedProperties: string[] | null
}

/** Arguments for `Mailbox/query` (standard `/query` + tree flags, RFC 8621 §2.3). */
export type MailboxQueryRequest = Omit<QueryRequest, 'filter'> & {
  filter?: MailboxFilter | null
  /** Return mailboxes in tree order (default `false`). */
  sortAsTree?: boolean
  /** Only include a mailbox if its ancestors also match the filter (default `false`). */
  filterAsTree?: boolean
}
/** Response for `Mailbox/query`. */
export type MailboxQueryResponse = QueryResponse

/** Arguments for `Mailbox/queryChanges` (standard `/queryChanges`, RFC 8621 §2.4). */
export type MailboxQueryChangesRequest = Omit<QueryChangesRequest, 'filter'> & {
  filter?: MailboxFilter | null
}
/** Response for `Mailbox/queryChanges`. */
export type MailboxQueryChangesResponse = QueryChangesResponse

/** Arguments for `Mailbox/set` (standard `/set` + `onDestroyRemoveEmails`, RFC 8621 §2.5). */
export interface MailboxSetRequest {
  accountId: Id
  ifInState?: string | null
  create?: Record<CreationId, Partial<Mailbox>> | null
  update?: Record<Id, PatchObject> | null
  destroy?: Id[] | null
  /** If `true`, destroying a mailbox also removes the emails only in it (default `false`). */
  onDestroyRemoveEmails?: boolean
}
/** Response for `Mailbox/set`. */
export type MailboxSetResponse = SetResponse<Mailbox>

// ── Thread (RFC 8621 §3) ───────────────────────────────────────────────────────────────

/** A Thread (RFC 8621 §3). `emailIds` are ordered oldest-first by `receivedAt` with a stable id tiebreak. */
export interface Thread {
  /** Immutable, server-set. */
  id: Id
  /** Emails in this thread, oldest-first. */
  emailIds: Id[]
}

/** Arguments for `Thread/get` (standard `/get`, RFC 8621 §3.1). */
export type ThreadGetRequest = GetRequest
/** Response for `Thread/get`. */
export type ThreadGetResponse = GetResponse<Thread>
/** Arguments for `Thread/changes` (standard `/changes`, RFC 8621 §3.2). */
export type ThreadChangesRequest = ChangesRequest
/** Response for `Thread/changes`. */
export type ThreadChangesResponse = ChangesResponse

// ── Email address & header value shapes (RFC 8621 §4.1) ────────────────────────────────

/** A single mailbox address. `email` may be non-conformant for broken messages. */
export interface EmailAddress {
  name: string | null
  email: string
}

/** A named group of addresses (RFC 5322 groups); consecutive ungrouped addresses use `name: null`. */
export interface EmailAddressGroup {
  name: string | null
  addresses: EmailAddress[]
}

/** A raw header field (name + value in `Raw` form, i.e. exactly as on the wire). */
export interface EmailHeader {
  name: string
  value: string
}

// ── Email body parts & values (RFC 8621 §4.1.2–4.1.3) ─────────────────────────────────

/**
 * One MIME part of an Email's body structure. `partId` and `blobId` are non-null iff the
 * part is NOT `multipart/*`; `subParts` is non-null iff it IS `multipart/*`.
 */
export interface EmailBodyPart {
  /** Identifies the part's decoded content in `bodyValues`; `null` for `multipart/*`. */
  partId: string | null
  /** Blob id of the decoded (post-CTE) content; `null` for `multipart/*`. */
  blobId: Id | null
  /** Octets after content-transfer-decoding. */
  size: UnsignedInt
  /** This part's headers, in `Raw` form. */
  headers: EmailHeader[]
  /** Decoded filename (Content-Disposition `filename`, else Content-Type `name`), or `null`. */
  name: string | null
  /** MIME type with parameters/CFWS stripped (e.g. `text/plain`). */
  type: string
  /** Charset (`text/*` defaults to `us-ascii`), or `null`. */
  charset: string | null
  /** Content-Disposition value with parameters removed (e.g. `attachment`, `inline`), or `null`. */
  disposition: string | null
  /** Content-Id with angle brackets/CFWS removed (for `cid:` references), or `null`. */
  cid: string | null
  /** Content-Language values, or `null`. */
  language: string[] | null
  /** Content-Location value, or `null`. */
  location: string | null
  /** Child parts; non-null iff `multipart/*`. */
  subParts: EmailBodyPart[] | null
}

/** The decoded value of a single body part, keyed by `partId` in {@link EmailBodyFields.bodyValues}. */
export interface EmailBodyValue {
  /** Decoded (CTE + charset), with CRLF normalised to LF. */
  value: string
  /** `true` if a charset/CTE problem was encountered (default `false`). */
  isEncodingProblem: boolean
  /** `true` if truncated to `maxBodyValueBytes` (default `false`). */
  isTruncated: boolean
}

/** The immutable server-set metadata of an Email (RFC 8621 §4.1.1). */
export interface EmailMetadata {
  /** Immutable, server-set. */
  id: Id
  /** Immutable, server-set; download the raw RFC 5322 message via this blob. */
  blobId: Id
  /** Immutable, server-set. */
  threadId: Id
  /** Mailboxes this Email is in; MUST be non-empty. Mutable. */
  mailboxIds: Record<Id, true>
  /** Keywords (lower-cased on set, matched case-insensitively). Mutable. Default `{}`. */
  keywords: Record<string, true>
  /** Immutable, server-set; octets of the raw message. */
  size: UnsignedInt
  /** Immutable, server-set; internal received date (always `Z`). */
  receivedAt: UTCDate
}

/** The parsed convenience header fields of an Email (RFC 8621 §4.1.2). All `null` when absent/unparsable. */
export interface EmailParsedHeaders {
  /** All header fields in message order, `Raw` form. */
  headers: EmailHeader[]
  messageId: string[] | null
  inReplyTo: string[] | null
  references: string[] | null
  sender: EmailAddress[] | null
  from: EmailAddress[] | null
  to: EmailAddress[] | null
  cc: EmailAddress[] | null
  bcc: EmailAddress[] | null
  replyTo: EmailAddress[] | null
  subject: string | null
  /** Date header (`:asDate`) — a local {@link JmapDate} that MAY carry an offset, not a {@link UTCDate}. */
  sentAt: JmapDate | null
}

/** The body fields of an Email (RFC 8621 §4.1.3–4.1.4). */
export interface EmailBodyFields {
  /** Full MIME tree; does NOT recurse into `message/rfc822` or `message/global` parts. */
  bodyStructure: EmailBodyPart
  /** Decoded body values keyed by `partId` (subset controlled by the fetch* args). */
  bodyValues: Record<string, EmailBodyValue>
  /** Parts to display as the plaintext body. */
  textBody: EmailBodyPart[]
  /** Parts to display as the HTML body. */
  htmlBody: EmailBodyPart[]
  /** Non-inline / non-body media parts (depth-first). */
  attachments: EmailBodyPart[]
  /** Server-set; `true` if a downloadable (non-inline) attachment exists. */
  hasAttachment: boolean
  /** Server-set plaintext preview (≤ 256 chars); may change without marking the Email changed. */
  preview: string
}

/**
 * A full Email (RFC 8621 §4.1) — the union of metadata, parsed headers and body fields. A
 * `/get` returns only the requested properties, so in practice a fetched record is a
 * `Partial<Email>`; type the response accordingly when fetching a subset.
 */
export interface Email extends EmailMetadata, EmailParsedHeaders, EmailBodyFields {}

// ── Email/query filter & sort (RFC 8621 §4.4) ─────────────────────────────────────────

/** Filter conditions for `Email/query` (RFC 8621 §4.4.1). Multiple present fields are ANDed. */
export interface EmailFilterCondition {
  /** Email is in this mailbox. */
  inMailbox?: Id
  /** Email is in none of these mailboxes. */
  inMailboxOtherThan?: Id[]
  /** `receivedAt` < this. */
  before?: UTCDate
  /** `receivedAt` ≥ this. */
  after?: UTCDate
  /** `size` ≥ this. */
  minSize?: UnsignedInt
  /** `size` < this. */
  maxSize?: UnsignedInt
  /** Every email in the thread has this keyword. */
  allInThreadHaveKeyword?: string
  /** Some email in the thread has this keyword. */
  someInThreadHaveKeyword?: string
  /** No email in the thread has this keyword. */
  noneInThreadHaveKeyword?: string
  /** This email has this keyword. */
  hasKeyword?: string
  /** This email does not have this keyword. */
  notKeyword?: string
  /** Whether the email has an attachment. */
  hasAttachment?: boolean
  /** Server-defined free-text match across from/to/cc/bcc/subject/body. */
  text?: string
  from?: string
  to?: string
  cc?: string
  bcc?: string
  subject?: string
  body?: string
  /** `[name]` (header exists) or `[name, value]` (header contains value). */
  header?: string[]
}

/** An `Email/query` filter: a boolean group or a single condition. */
export type EmailFilter = FilterOperator | EmailFilterCondition

/**
 * A sort comparator for `Email/query` (RFC 8621 §4.4.2). Keyword-based properties
 * (`hasKeyword`, `allInThreadHaveKeyword`, `someInThreadHaveKeyword`) take an extra
 * `keyword`. `collapseThreads` is NOT a comparator property — it is a top-level
 * `Email/query`/`Email/queryChanges` argument (see {@link EmailQueryRequest}).
 */
export interface EmailComparator extends Comparator {
  keyword?: string
}

// ── Email methods (RFC 8621 §4.6–4.9) ─────────────────────────────────────────────────

/** Arguments for `Email/get` (RFC 8621 §4.6): standard `/get` plus body-fetch controls. */
export interface EmailGetRequest extends GetRequest {
  /** Properties of each {@link EmailBodyPart} to return (server default applies if omitted). */
  bodyProperties?: string[]
  /** Include the `text/*` values referenced by `textBody` (default `false`). */
  fetchTextBodyValues?: boolean
  /** Include the `text/*` values referenced by `htmlBody` (default `false`). */
  fetchHTMLBodyValues?: boolean
  /** Include all `text/*` values from `bodyStructure` (default `false`). */
  fetchAllBodyValues?: boolean
  /** Truncate each returned body value to this many octets (default `0` = no truncation). */
  maxBodyValueBytes?: UnsignedInt
}
/**
 * Response for `Email/get`. Generic over the record type so callers fetching a subset can
 * pass a narrowed `Partial<Email>`; defaults to the full {@link Email}.
 */
export type EmailGetResponse<T = Email> = GetResponse<T>

/** Arguments for `Email/changes` (standard `/changes`, RFC 8621 §4.7). */
export type EmailChangesRequest = ChangesRequest
/**
 * Response for `Email/changes`. Since all parsed/body fields are immutable, an id in
 * `updated` only ever means a `mailboxIds` or `keywords` change.
 */
export type EmailChangesResponse = ChangesResponse

/** Arguments for `Email/query` (RFC 8621 §4.4): standard `/query` plus thread collapsing. */
export type EmailQueryRequest = Omit<QueryRequest, 'filter' | 'sort'> & {
  filter?: EmailFilter | null
  sort?: EmailComparator[] | null
  /** Return only the highest-sorted email per thread (default `false`). */
  collapseThreads?: boolean
}
/** Response for `Email/query`. */
export type EmailQueryResponse = QueryResponse

/** Arguments for `Email/queryChanges` (RFC 8621 §4.5). `filter`/`sort` MUST match the original query. */
export type EmailQueryChangesRequest = Omit<QueryChangesRequest, 'filter' | 'sort'> & {
  filter?: EmailFilter | null
  sort?: EmailComparator[] | null
  collapseThreads?: boolean
}
/** Response for `Email/queryChanges`. */
export type EmailQueryChangesResponse = QueryChangesResponse

// ── SearchSnippet (RFC 8621 §5) — highlighted search results (M3.1) ───────────────────────────

/**
 * A per-email search snippet (RFC 8621 §5.1): the `subject`/`preview` with the query's matched terms
 * wrapped in `<mark>` markup. SERVER-PRODUCED markup — the client MUST sanitize it before rendering.
 */
export interface SearchSnippet {
  emailId: Id
  subject: string | null
  preview: string | null
}

/** Arguments for `SearchSnippet/get` (RFC 8621 §5.1): the same `filter` as the query + the email ids. */
export interface SearchSnippetGetRequest {
  accountId: Id
  filter?: EmailFilter | null
  emailIds: Id[]
}

/** Response for `SearchSnippet/get` (RFC 8621 §5.1). */
export interface SearchSnippetGetResponse {
  accountId: Id
  list: SearchSnippet[]
  notFound: Id[]
}

/**
 * The create form of an Email (RFC 8621 §4.8). `mailboxIds` is required; content may be
 * supplied structurally (`bodyStructure` + `bodyValues`) or simplified
 * (`textBody`/`htmlBody`/`attachments`). Header values may be set via the convenience props
 * or arbitrary `header:{field}` keys (hence the index signature).
 */
export interface EmailCreate {
  /** Required: the mailboxes to file the new email in. */
  mailboxIds: Record<Id, true>
  keywords?: Record<string, true>
  receivedAt?: UTCDate
  subject?: string | null
  from?: EmailAddress[] | null
  to?: EmailAddress[] | null
  cc?: EmailAddress[] | null
  bcc?: EmailAddress[] | null
  replyTo?: EmailAddress[] | null
  sender?: EmailAddress[] | null
  inReplyTo?: string[] | null
  references?: string[] | null
  messageId?: string[] | null
  sentAt?: JmapDate | null
  bodyStructure?: EmailBodyPart
  bodyValues?: Record<string, EmailBodyValue>
  textBody?: Partial<EmailBodyPart>[]
  htmlBody?: Partial<EmailBodyPart>[]
  attachments?: Partial<EmailBodyPart>[]
  /** Arbitrary `header:{field}` keys and other server-accepted create properties. */
  [key: string]: unknown
}

/** Arguments for `Email/set` (RFC 8621 §4.8). `create` uses {@link EmailCreate}; `update` uses JSON-Pointer patches. */
export interface EmailSetRequest {
  accountId: Id
  ifInState?: string | null
  create?: Record<CreationId, EmailCreate> | null
  update?: Record<Id, PatchObject> | null
  destroy?: Id[] | null
}
/** Response for `Email/set`. */
export type EmailSetResponse = SetResponse<Email>

/** Arguments for `Email/parse` (RFC 8621 §4.9): parse uploaded RFC 5322 blobs without importing them. */
export interface EmailParseRequest {
  accountId: Id
  blobIds: Id[]
  properties?: string[]
  bodyProperties?: string[]
  fetchTextBodyValues?: boolean
  fetchHTMLBodyValues?: boolean
  fetchAllBodyValues?: boolean
  maxBodyValueBytes?: UnsignedInt
}
/**
 * Response for `Email/parse` (RFC 8621 §4.9). Parsed emails are keyed by `blobId` and carry
 * a `blobId` but NO `id`/`threadId`/`mailboxIds`/`keywords`/`receivedAt`.
 */
export interface EmailParseResponse {
  accountId: Id
  parsed: Record<Id, Email>
  notParsable: Id[]
  notFound: Id[]
}
