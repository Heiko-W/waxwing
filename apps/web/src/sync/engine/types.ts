/**
 * Sync-engine contracts (M1.3). The engine is a single-writer (leader-elected) loop that keeps the
 * replica fresh from JMAP push + delta sync and replays the outbox. To keep the correctness-critical
 * logic hermetically testable, everything speaks a narrow {@link JmapPort} — the ONE seam that knows
 * the `@waxwing/jmap` RequestBuilder DSL — rather than the `JmapClient` directly. `delta`/`outbox`/
 * `backfill` take a `JmapPort` + the replica; tests pass a plain fake port.
 */

import type {
  Email,
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

/** The full-body fields fetched for an opened message (mapped to an `EmailBodyRow` by the engine). */
export interface EmailBodyInput {
  readonly id: Id
  readonly bodyValues: Record<string, EmailBodyValue>
  readonly bodyStructure: EmailBodyPart
  readonly textBody: EmailBodyPart[]
  readonly htmlBody: EmailBodyPart[]
  readonly attachments: EmailBodyPart[]
  readonly hasAttachment: boolean
}

/** Email properties fetched for a full body. `bodyValues` MUST be named here (SP.4: the fetch flags
 * alone do not populate it). */
export const EMAIL_BODY_PROPERTIES: readonly string[] = [
  'id',
  'bodyValues',
  'bodyStructure',
  'textBody',
  'htmlBody',
  'attachments',
  'hasAttachment',
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
  readonly pendingActions: number
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
  error: null,
}

/** Injectable clock/scheduler so backoff, retry and polling are deterministic in tests. */
export interface EngineClock {
  now(): number
  setTimeout(handler: () => void, ms: number): number
  clearTimeout(id: number): void
}
