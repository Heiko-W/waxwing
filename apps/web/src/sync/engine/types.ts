/**
 * Sync-engine contracts (M1.3). The engine is a single-writer (leader-elected) loop that keeps the
 * replica fresh from JMAP push + delta sync and replays the outbox. To keep the correctness-critical
 * logic hermetically testable, everything speaks a narrow {@link JmapPort} — the ONE seam that knows
 * the `@waxwing/jmap` RequestBuilder DSL — rather than the `JmapClient` directly. `delta`/`outbox`/
 * `backfill` take a `JmapPort` + the replica; tests pass a plain fake port.
 */

import type {
  AddressBook,
  ContactCard,
  ContactCardComparator,
  ContactCardFilter,
  Email,
  EmailAddress,
  EmailBodyPart,
  EmailBodyValue,
  EmailComparator,
  EmailCreate,
  EmailFilter,
  Envelope,
  Id,
  Identity,
  Mailbox,
  PatchObject,
  PushStatus,
  PushTransport,
  SearchSnippet,
  Thread,
} from '@waxwing/jmap'
import type { EmailEnvelopeInput } from '../db'

// ---------------------------------------------------------------------------------------------
// JMAP port — the task-oriented surface the engine needs. `port.ts` adapts a real JmapClient to
// this; the ports below map 1:1 to RFC 8620/8621 methods but hide the request/back-ref/chunking DSL.
// ---------------------------------------------------------------------------------------------

/** Result of a `Foo/changes` call. `updatedProperties` is Mailbox-only (RFC 8621 §2.5). */
export interface ChangesResult {
  readonly newState: string
  readonly hasMoreChanges: boolean
  readonly created: Id[]
  readonly updated: Id[]
  readonly destroyed: Id[]
  /** Mailbox/changes only: non-null ⇒ only these props changed (patch counts, skip a full get). */
  readonly updatedProperties?: string[] | null
}

/** Result of an `Email/query` (one page). */
export interface QueryResult {
  readonly ids: Id[]
  readonly queryState: string
  readonly canCalculateChanges: boolean
  readonly position: number
  readonly total?: number
}

/** Result of an `Email/queryChanges` — apply `removed` first, then splice `added` by index. */
export interface QueryChangesResult {
  readonly oldQueryState: string
  readonly newQueryState: string
  readonly removed: Id[]
  readonly added: ReadonlyArray<{ readonly id: Id; readonly index: number }>
  readonly total?: number
}

/** A `Foo/get` slice. */
export interface GetResult<T> {
  readonly list: T[]
  readonly notFound: Id[]
  readonly state: string
}

/** Per-object `/set` failure (RFC 8620 §5.3 `SetError`). */
export interface PortSetError {
  readonly type: string
  readonly description?: string | null
}

/** Result of a `Foo/set`. Creation ids map to their server ids; failures are per-object. */
export interface PortSetResult {
  readonly oldState: string | null
  readonly newState: string
  readonly created: Record<string, { id: Id } & Record<string, unknown>>
  readonly updated: Id[]
  readonly destroyed: Id[]
  readonly notCreated: Record<string, PortSetError>
  readonly notUpdated: Record<Id, PortSetError>
  readonly notDestroyed: Record<Id, PortSetError>
  /**
   * Send only ({@link JmapPort.submitEmail}): the sibling `Email/set` create outcome, since that
   * runs BEFORE the submission and commits even if the submission is rejected. Lets the send-failure
   * path re-point the local draft at the newly-created (orphaned-in-Drafts) id instead of the
   * already-destroyed prior — so a later save replaces it in place rather than duplicating.
   */
  readonly emailCreated?: ({ id: Id } & Record<string, unknown>) | null
}

export interface EmailQuerySpec {
  readonly filter?: EmailFilter | null
  readonly sort?: EmailComparator[] | null
  readonly collapseThreads?: boolean
  readonly position?: number
  readonly limit?: number
  readonly calculateTotal?: boolean
}

export interface EmailQueryChangesSpec {
  readonly filter?: EmailFilter | null
  readonly sort?: EmailComparator[] | null
  readonly collapseThreads?: boolean
  readonly sinceQueryState: string
  readonly upToId?: Id | null
  readonly maxChanges?: number
  readonly calculateTotal?: boolean
}

/** A `ContactCard/query` (one page) — the Mail {@link EmailQuerySpec} analogue (no `collapseThreads`). */
export interface ContactQuerySpec {
  readonly filter?: ContactCardFilter | null
  readonly sort?: ContactCardComparator[] | null
  readonly position?: number
  readonly limit?: number
  readonly calculateTotal?: boolean
}

/** A `ContactCard/queryChanges` — the Mail {@link EmailQueryChangesSpec} analogue. */
export interface ContactQueryChangesSpec {
  readonly filter?: ContactCardFilter | null
  readonly sort?: ContactCardComparator[] | null
  readonly sinceQueryState: string
  readonly upToId?: Id | null
  readonly maxChanges?: number
  readonly calculateTotal?: boolean
}

/**
 * The narrow JMAP surface the engine uses. All calls are implicitly scoped to {@link accountId}.
 * `queryEmailChanges` REJECTS with {@link CannotCalculateChangesError} when the server cannot
 * compute the delta (the caller must then full-re-query + reconcile).
 */
export interface JmapPort {
  readonly accountId: Id

  mailboxChanges(sinceState: string, maxChanges?: number): Promise<ChangesResult>
  threadChanges(sinceState: string, maxChanges?: number): Promise<ChangesResult>
  emailChanges(sinceState: string, maxChanges?: number): Promise<ChangesResult>

  /** `ids === null` fetches all records (used for the initial mailbox/thread pull). */
  getMailboxes(ids: Id[] | null): Promise<GetResult<Mailbox>>
  /** Fetches all send identities (RFC 8621 §6) — a one-shot pull; Identity/changes is deferred (M2.5). */
  getIdentities(): Promise<GetResult<Identity>>
  getThreads(ids: Id[]): Promise<GetResult<Thread>>
  /** Fetches the envelope/index property set the list needs (never bodies). */
  getEmailEnvelopes(ids: Id[]): Promise<GetResult<EmailEnvelopeInput>>
  /** Fetches the FULL body (values/structure/attachments) for opened messages (M1.8, FR-OFF-02). */
  getEmailBodies(ids: Id[]): Promise<GetResult<EmailBodyInput>>

  queryEmails(spec: EmailQuerySpec): Promise<QueryResult>
  queryEmailChanges(spec: EmailQueryChangesSpec): Promise<QueryChangesResult>
  /** Highlighted (`<mark>` markup) subject/preview for the visible slice of a search (M3.1). */
  getSearchSnippets(
    emailIds: Id[],
    filter: EmailFilter | null,
  ): Promise<{ list: SearchSnippet[]; notFound: Id[] }>

  setEmails(args: {
    create?: Record<string, EmailCreate>
    update?: Record<Id, PatchObject>
    destroy?: Id[]
    ifInState?: string | null
  }): Promise<PortSetResult>
  setMailboxes(args: {
    create?: Record<string, Partial<Mailbox>>
    update?: Record<Id, PatchObject>
    destroy?: Id[]
    ifInState?: string | null
  }): Promise<PortSetResult>
  /**
   * Send an email atomically (M2.8): ONE request that creates the Email (into Drafts) — optionally
   * destroying a prior autosaved draft copy and flagging the reply/forward source — and creates an
   * `EmailSubmission` referencing it via a `#creationId` back-ref, with `onSuccessUpdateEmail`
   * refiling Drafts→Sent + clearing `$draft`. Returns the EmailSubmission/set result (keyed by the
   * submission creation id), so a per-recipient/quota rejection surfaces as `notCreated`.
   */
  submitEmail(args: {
    emailCreationId: string
    email: EmailCreate
    destroyServerDraftId?: Id | null
    submissionCreationId: string
    identityId: Id
    envelope: Envelope
    onSuccessUpdateEmail: PatchObject
    sourceUpdate?: { id: Id; patch: PatchObject } | null
    ifInState?: string | null
  }): Promise<PortSetResult>

  // ── Contacts (M4.2, RFC 9610) ──────────────────────────────────────────────────────────────
  // AddressBooks mirror the Mailbox surface (whole-account pull, no `/query`); ContactCards mirror
  // the Email surface (delta + windowed query). `queryContactCardChanges` REJECTS with
  // {@link CannotCalculateChangesError} when the server cannot compute the delta.

  /** `ids === null` fetches all address books (the initial + reconciliation pull). */
  getAddressBooks(ids: Id[] | null): Promise<GetResult<AddressBook>>
  addressBookChanges(sinceState: string, maxChanges?: number): Promise<ChangesResult>
  setAddressBooks(args: {
    create?: Record<string, Partial<AddressBook>>
    update?: Record<Id, PatchObject>
    destroy?: Id[]
    ifInState?: string | null
  }): Promise<PortSetResult>

  /** Fetches the full JSContact card ({@link CONTACT_CARD_PROPERTIES}) for the given ids. */
  getContactCards(ids: Id[]): Promise<GetResult<ContactCard>>
  contactCardChanges(sinceState: string, maxChanges?: number): Promise<ChangesResult>
  queryContactCards(spec: ContactQuerySpec): Promise<QueryResult>
  queryContactCardChanges(spec: ContactQueryChangesSpec): Promise<QueryChangesResult>
  setContactCards(args: {
    create?: Record<string, Partial<ContactCard>>
    update?: Record<Id, PatchObject>
    destroy?: Id[]
    ifInState?: string | null
  }): Promise<PortSetResult>
}

/** The property set fetched for an email envelope row (kept in one place so port + tests agree). */
export const EMAIL_ENVELOPE_PROPERTIES: readonly (keyof Email | string)[] = [
  'id',
  'blobId',
  'threadId',
  'mailboxIds',
  'keywords',
  'size',
  'receivedAt',
  'sentAt',
  'from',
  'to',
  'cc',
  'replyTo',
  'subject',
  'messageId',
  'inReplyTo',
  'references',
  'preview',
  'hasAttachment',
]

/**
 * The `ContactCard/get` property set fetched for a card row (M4.2). Enumerates the JMAP object fields
 * (`id`, `addressBookIds`) plus every JSContact `Card` property this client models, INCLUDING
 * `vCardProps` — the bag by which unmapped vCard properties survive a round-trip. It is the "default
 * to fetch" set (kept here so port + tests agree, mirroring {@link EMAIL_ENVELOPE_PROPERTIES}); a
 * fetch restricted to it stays lossless for every property the app knows about.
 */
export const CONTACT_CARD_PROPERTIES: readonly (keyof ContactCard | string)[] = [
  'id',
  'addressBookIds',
  '@type',
  'version',
  'uid',
  'kind',
  'created',
  'updated',
  'name',
  'nicknames',
  'emails',
  'phones',
  'addresses',
  'organizations',
  'titles',
  'anniversaries',
  'notes',
  'media',
  'links',
  'keywords',
  'members',
  'vCardProps',
]

/**
 * The `Email/get` property name for the Authentication-Results header (M3.9, FR-RD-06).
 *
 * `:all` — NOT the plain `:asText` — because RFC 8621 §4.1.2 defines the singular form as "the value
 * of the last instance of the header field", while the RECEIVING MTA *prepends* its report (RFC 8601
 * §5): the last instance is therefore whatever the SENDER forged, and the first is the only one our
 * server wrote. `port.ts` renames this key to `authResults` and the UI reads `[0]`.
 */
export const AUTH_RESULTS_PROPERTY = 'header:Authentication-Results:asText:all'

/**
 * The `Email/get` property names for the unsubscribe headers (M5.3, FR-RD-09).
 *
 * `:asURLs` is the form RFC 8621 §4.1.2 defines for exactly this header: it returns the bracketed
 * `<mailto:…>, <https://…>` list already split, so no bracket parsing is needed here.
 *
 * `List-Unsubscribe-Post` is a plain text header whose only defined value is
 * `List-Unsubscribe=One-Click` (RFC 8058 §3.1). Its presence is what distinguishes a list that
 * accepts a silent POST from one that needs the reader to open a page.
 */
export const LIST_UNSUBSCRIBE_PROPERTY = 'header:List-Unsubscribe:asURLs'
export const LIST_UNSUBSCRIBE_POST_PROPERTY = 'header:List-Unsubscribe-Post:asText'

/**
 * The `Email/get` property for the read-receipt request header (M5.22, RFC 8098 §2.1).
 *
 * The singular `:asText` is right here, unlike `Authentication-Results`: this header is the
 * SENDER's own and a message carrying two of them is malformed. RFC 8621 §4.1.2 gives the last
 * instance, which is the sender's final word either way.
 */
export const MDN_REQUEST_PROPERTY = 'header:Disposition-Notification-To:asText'

/** The full-body fields fetched for an opened message (mapped to an `EmailBodyRow` by the engine). */
export interface EmailBodyInput {
  readonly id: Id
  readonly bodyValues: Record<string, EmailBodyValue>
  readonly bodyStructure: EmailBodyPart
  readonly textBody: EmailBodyPart[]
  readonly htmlBody: EmailBodyPart[]
  readonly attachments: EmailBodyPart[]
  readonly hasAttachment: boolean
  /** Header details (M3.9). Optional: a fake port in a test need not supply them. */
  readonly bcc?: EmailAddress[] | null
  readonly sender?: EmailAddress[] | null
  /**
   * Every `Authentication-Results` value, in message order ({@link AUTH_RESULTS_PROPERTY}); `[]` when
   * the message carries none. The awkward `header:…` key is mapped away in `port.ts` and never
   * escapes it.
   */
  readonly authResults?: string[]
  /**
   * The `List-Unsubscribe` URLs, already unbracketed ({@link LIST_UNSUBSCRIBE_PROPERTY}).
   *
   * Three states, and they are not the same: `undefined` means the row predates this feature (or a
   * test port did not supply it), `null` means the header is absent, `[]` means it was present but
   * empty. Only the first must not be read as "this message offers no unsubscribe".
   */
  readonly listUnsubscribe?: string[] | null
  /** The raw `List-Unsubscribe-Post` value; `null` when absent ({@link LIST_UNSUBSCRIBE_POST_PROPERTY}). */
  readonly listUnsubscribePost?: string | null
  /**
   * Where the sender asked to be told this was read ({@link MDN_REQUEST_PROPERTY}); `null` when
   * they did not ask. Waxwing never answers it without the reader pressing a button — see `mdn.ts`.
   */
  readonly mdnRequestTo?: string | null
}

/** Email properties fetched for a full body. `bodyValues` MUST be named here (SP.4: the fetch flags
 * alone do not populate it). `headers` (the raw array) is deliberately ABSENT: RFC 8621 returns it in
 * Raw form — RFC 2047-encoded and folded — while `:asText:all` is server-decoded and unfolded, and the
 * raw truth is already covered by the .eml source view. */
export const EMAIL_BODY_PROPERTIES: readonly string[] = [
  'id',
  'bodyValues',
  'bodyStructure',
  'textBody',
  'htmlBody',
  'attachments',
  'hasAttachment',
  'bcc',
  'sender',
  AUTH_RESULTS_PROPERTY,
  LIST_UNSUBSCRIBE_PROPERTY,
  LIST_UNSUBSCRIBE_POST_PROPERTY,
  MDN_REQUEST_PROPERTY,
]

/** Per-part properties for the body/attachment `EmailBodyPart`s (incl. `cid` for inline-image mapping). */
export const BODY_PART_PROPERTIES: readonly string[] = [
  'partId',
  'blobId',
  'type',
  'size',
  'name',
  'disposition',
  'cid',
  'charset',
]

/** Thrown by {@link JmapPort.queryEmailChanges} when the server returns `cannotCalculateChanges`. */
export class CannotCalculateChangesError extends Error {
  constructor(message = 'cannotCalculateChanges') {
    super(message)
    this.name = 'CannotCalculateChangesError'
  }
}

// ---------------------------------------------------------------------------------------------
// Engine status (the M1.4 StatusRegion seam) + injected dependencies for the facade.
// ---------------------------------------------------------------------------------------------

export type EnginePhase = 'idle' | 'syncing' | 'offline' | 'error'

/** The engine's public status, surfaced to the shell chrome and shared cross-tab via BroadcastChannel. */
export interface EngineStatus {
  readonly phase: EnginePhase
  readonly isLeader: boolean
  readonly online: boolean
  readonly pushTransport: PushTransport | null
  readonly pushStatus: PushStatus | null
  readonly lastSyncedAt: number | null
  /** The LIVE queue: `pending` + `inflight`. Dead letters are counted by {@link failedActions}. */
  readonly pendingActions: number
  /** Dead-lettered actions awaiting the user (M3.3) — the problems button/dialog surface. */
  readonly failedActions: number
  /** Still-queued actions past {@link STUCK_AFTER_ATTEMPTS} retries — a gentle "still trying" notice. */
  readonly stuckActions: number
  readonly error: string | null
}

export const INITIAL_ENGINE_STATUS: EngineStatus = {
  phase: 'idle',
  isLeader: false,
  online: true,
  pushTransport: null,
  pushStatus: null,
  lastSyncedAt: null,
  pendingActions: 0,
  failedActions: 0,
  stuckActions: 0,
  error: null,
}

/** Injectable clock/scheduler so backoff, retry and polling are deterministic in tests. */
export interface EngineClock {
  now(): number
  setTimeout(handler: () => void, ms: number): number
  clearTimeout(id: number): void
}
