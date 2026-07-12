/**
 * Action queue / outbox (M1.3 skeleton, M3.3 hardening — FR-OFF-03, FR-ORG-01, FR-LST-04). Every
 * write — even "mark read" — is an idempotent JMAP `set` intent with a client id: it is applied to
 * the replica optimistically (instant UI), enqueued durably, then replayed against the server.
 *
 * ## The M3.3 contract (never silent data loss)
 *  - **Durable undo.** {@link applyOptimistic} returns an {@link OutboxUndo} *value* (not a closure)
 *    that is persisted on the row. `status === 'error' && undo != null` ⇒ *a rollback is still
 *    OWED*; {@link drainOwedUndos} retries it at the start of every pass, and it is nulled only once
 *    applied. So a rollback survives a reload, a tab hand-over and an outage.
 *  - **Transient ≠ failed.** A network/5xx/429/`serverFail` failure backs the row off and leaves it
 *    `pending` — FOREVER if need be. It is never rolled back and never dead-lettered.
 *  - **Per-object rejections.** A rejection is classified and undone PER FAILED ID: a 500-id destroy
 *    with one `notFound` no longer restores 500 messages, and `notFound` on a destroy is a SUCCESS
 *    ("already gone"), not a resurrection.
 *  - **Dead letters are surfaced.** A row that fails permanently is rolled back, marked `error` with
 *    an {@link OutboxConflict}, and shown to the user (retry / discard) — never silently retried,
 *    never silently dropped.
 *
 * Classification lives in `conflict.ts`, the retry curve in `backoff.ts`; this module owns the
 * replica mutations and the queue state machine.
 */

import type { EmailCreate, Envelope, Id, Mailbox, PatchObject } from '@waxwing/jmap'
import {
  type ConflictCode,
  type EmailEnvelopeInput,
  type EmailRow,
  type OutboxConflict,
  type OutboxRow,
  type OutboxUndo,
  type ReplicaDb,
  scopeKey,
  toMailboxRow,
} from '../db'
import {
  deleteDraft,
  deleteEmails,
  deleteMailbox,
  emailsByIds,
  enqueue,
  failedOutbox,
  pendingOutbox,
  putEmails,
} from '../repo'
import {
  backoffDelayMs,
  DEFAULT_OUTBOX_BACKOFF,
  MAX_REFRESHES,
  type OutboxBackoff,
  STUCK_AFTER_ATTEMPTS,
} from './backoff'
import { classifySetError, classifyThrown, isAuthExpiry, thrownErrorType } from './conflict'
import type { JmapPort, PortSetError, PortSetResult } from './types'

// ---------------------------------------------------------------------------------------------
// Intent model.
// ---------------------------------------------------------------------------------------------

export type OutboxIntent =
  | {
      readonly kind: 'setKeywords'
      readonly emailIds: Id[]
      readonly keyword: string
      readonly value: boolean
    }
  | { readonly kind: 'move'; readonly emailIds: Id[]; readonly from: Id | null; readonly to: Id }
  | { readonly kind: 'destroyEmails'; readonly emailIds: Id[] }
  | {
      readonly kind: 'createMailbox'
      readonly creationId: string
      readonly props: {
        readonly name: string
        readonly parentId: Id | null
        readonly role?: string | null
      }
    }
  | { readonly kind: 'renameMailbox'; readonly id: Id; readonly name: string }
  | { readonly kind: 'moveMailbox'; readonly id: Id; readonly parentId: Id | null }
  | { readonly kind: 'deleteMailbox'; readonly id: Id }
  | {
      // Save a draft (M2.6): a content change is create-new + destroy-old in ONE Email/set, because
      // an Email is immutable except keywords/mailboxIds (RFC 8621 §4.6).
      readonly kind: 'saveDraft'
      readonly localId: string
      readonly creationId: string
      readonly priorServerId: Id | null
      readonly email: EmailCreate
    }
  | { readonly kind: 'discardDraft'; readonly localId: string; readonly serverEmailId: Id }
  | {
      // Send a draft (M2.8): create the Email + submit it in ONE request (port.submitEmail), with
      // `onSuccessUpdateEmail` refiling Drafts→Sent + clearing `$draft`. Dispatched with a `notBefore`
      // grace timestamp so an Undo can delete the row before it replays.
      readonly kind: 'sendEmail'
      readonly localId: string
      readonly emailCreationId: string
      readonly submissionCreationId: string
      readonly priorServerId: Id | null
      readonly email: EmailCreate
      readonly identityId: Id
      readonly envelope: Envelope
      readonly onSuccessUpdateEmail: PatchObject
      readonly source: { readonly emailId: Id; readonly keyword: '$answered' | '$forwarded' } | null
    }

/** The mailbox intents dispatched with an `ifInState` guard (M3.3, Q3) — `Email/set` stays unguarded. */
export const STATE_GUARDED_INTENTS: ReadonlySet<OutboxIntent['kind']> = new Set([
  'renameMailbox',
  'moveMailbox',
  'deleteMailbox',
])

/** Full permissive rights for an optimistically-created folder (the server corrects them on sync). */
const OPTIMISTIC_RIGHTS = {
  mayReadItems: true,
  mayAddItems: true,
  mayRemoveItems: true,
  maySetSeen: true,
  maySetKeywords: true,
  mayCreateChild: true,
  mayRename: true,
  mayDelete: true,
  maySubmit: true,
}

// ---------------------------------------------------------------------------------------------
// Optimistic apply + its persisted undo.
// ---------------------------------------------------------------------------------------------

/** Copy an {@link EmailRow} back to its envelope input (drops accountId + the derived amb/akw). */
function toEnvelope(row: EmailRow): EmailEnvelopeInput {
  return {
    id: row.id,
    blobId: row.blobId,
    threadId: row.threadId,
    mailboxIds: row.mailboxIds,
    keywords: row.keywords,
    size: row.size,
    receivedAt: row.receivedAt,
    sentAt: row.sentAt,
    from: row.from,
    to: row.to,
    cc: row.cc,
    replyTo: row.replyTo,
    subject: row.subject,
    messageId: row.messageId,
    inReplyTo: row.inReplyTo,
    references: row.references,
    preview: row.preview,
    hasAttachment: row.hasAttachment,
  }
}

function present(rows: (EmailRow | undefined)[]): EmailRow[] {
  return rows.filter((row): row is EmailRow => row !== undefined)
}

/**
 * Apply an intent to the replica immediately and return the DATA needed to undo it (M3.3). Only
 * rows that actually exist locally are touched. The undo is deliberately id-set-based, not a
 * snapshot: it is persisted on the outbox row, so it must stay small and must survive being applied
 * to a SUBSET of the intent's ids (a partial rejection).
 */
export async function applyOptimistic(
  db: ReplicaDb,
  accountId: Id,
  intent: OutboxIntent,
): Promise<OutboxUndo> {
  switch (intent.kind) {
    case 'setKeywords': {
      const originals = present(await emailsByIds(db, accountId, intent.emailIds))
      const had = originals.filter((row) => row.keywords[intent.keyword] === true).map((r) => r.id)
      await putEmails(
        db,
        accountId,
        originals.map((row) => {
          const keywords = { ...row.keywords }
          if (intent.value) keywords[intent.keyword] = true
          else delete keywords[intent.keyword]
          return { ...toEnvelope(row), keywords }
        }),
      )
      return { kind: 'keywords', keyword: intent.keyword, had }
    }
    case 'move': {
      const originals = present(await emailsByIds(db, accountId, intent.emailIds))
      const hadTo = originals.filter((row) => row.mailboxIds[intent.to] === true).map((r) => r.id)
      const from = intent.from
      const hadFrom =
        from === null
          ? []
          : originals.filter((row) => row.mailboxIds[from] === true).map((row) => row.id)
      await putEmails(
        db,
        accountId,
        originals.map((row) => {
          const mailboxIds = { ...row.mailboxIds }
          if (from !== null) delete mailboxIds[from]
          mailboxIds[intent.to] = true
          return { ...toEnvelope(row), mailboxIds }
        }),
      )
      return { kind: 'mailboxIds', from, to: intent.to, hadTo, hadFrom }
    }
    case 'destroyEmails': {
      await deleteEmails(db, accountId, intent.emailIds)
      // The "before" state is the full envelope set — far too big to persist. It does not need to
      // be: a REJECTED destroy means the messages still exist on the server, so the undo is a
      // re-fetch. That also self-corrects a PARTIAL rejection — only the surviving ids come back.
      return { kind: 'refetchEmails' }
    }
    case 'createMailbox': {
      const mailbox: Mailbox = {
        id: intent.creationId,
        name: intent.props.name,
        parentId: intent.props.parentId,
        role: intent.props.role ?? null,
        sortOrder: 0,
        totalEmails: 0,
        unreadEmails: 0,
        totalThreads: 0,
        unreadThreads: 0,
        myRights: OPTIMISTIC_RIGHTS,
        isSubscribed: true,
      }
      await db.mailboxes.put(toMailboxRow(accountId, mailbox))
      return { kind: 'mailbox', id: intent.creationId, prior: null }
    }
    case 'renameMailbox':
    case 'moveMailbox':
    case 'deleteMailbox': {
      const prior = (await db.mailboxes.get([accountId, intent.id])) ?? null
      if (intent.kind === 'renameMailbox') {
        await db.mailboxes.update([accountId, intent.id], { name: intent.name })
      } else if (intent.kind === 'moveMailbox') {
        await db.mailboxes.update([accountId, intent.id], { parentId: intent.parentId })
      } else {
        await deleteMailbox(db, accountId, intent.id)
      }
      return { kind: 'mailbox', id: intent.id, prior }
    }
    case 'saveDraft':
    case 'discardDraft':
      // Drafts are edit-state, not envelope cache: the local `drafts` row is written durably by the
      // persist bridge / discard handler, not optimistically into `emails`. Nothing to undo here
      // (a rejection is surfaced on the drafts row itself by `stampDraftError`).
      return { kind: 'none' }
    case 'sendEmail': {
      // No synthetic Sent row (the real copy arrives via delta in a few ms). The only optimistic
      // replica change is the reply/forward source flag ($answered/$forwarded).
      const source = intent.source
      if (source === null) return { kind: 'none' }
      const originals = present(await emailsByIds(db, accountId, [source.emailId]))
      const had = originals.filter((row) => row.keywords[source.keyword] === true).map((r) => r.id)
      await putEmails(
        db,
        accountId,
        originals.map((row) => ({
          ...toEnvelope(row),
          keywords: { ...row.keywords, [source.keyword]: true },
        })),
      )
      return { kind: 'keywords', keyword: source.keyword, had }
    }
  }
}

/**
 * The email ids an intent's undo touches. `onlyIds` narrows it to the objects that ACTUALLY failed
 * (a partial rejection) — but only for the intents whose failure keys ARE email ids; a `sendEmail`
 * fails under its submission creation id, which says nothing about which email to restore.
 */
function undoTargets(intent: OutboxIntent, onlyIds: readonly string[] | null): Id[] {
  switch (intent.kind) {
    case 'setKeywords':
    case 'move':
    case 'destroyEmails': {
      if (onlyIds === null) return intent.emailIds
      const wanted = new Set(onlyIds)
      return intent.emailIds.filter((id) => wanted.has(id))
    }
    case 'sendEmail':
      return intent.source === null ? [] : [intent.source.emailId]
    default:
      return []
  }
}

/**
 * Undo an intent's optimistic apply from its PERSISTED {@link OutboxUndo} — for `onlyIds` alone when
 * a partial rejection is being repaired. MAY THROW (the `refetchEmails` arm needs the network); the
 * caller then leaves the undo owed on the row and retries it on the next pass.
 */
export async function applyUndo(
  db: ReplicaDb,
  port: JmapPort,
  accountId: Id,
  intent: OutboxIntent,
  undo: OutboxUndo,
  onlyIds: readonly string[] | null = null,
): Promise<void> {
  switch (undo.kind) {
    case 'none':
      return
    case 'keywords': {
      const ids = undoTargets(intent, onlyIds)
      if (ids.length === 0) return
      const rows = present(await emailsByIds(db, accountId, ids))
      const had = new Set(undo.had)
      await putEmails(
        db,
        accountId,
        rows.map((row) => {
          const keywords = { ...row.keywords }
          if (had.has(row.id)) keywords[undo.keyword] = true
          else delete keywords[undo.keyword]
          return { ...toEnvelope(row), keywords }
        }),
      )
      return
    }
    case 'mailboxIds': {
      const ids = undoTargets(intent, onlyIds)
      if (ids.length === 0) return
      const rows = present(await emailsByIds(db, accountId, ids))
      const hadTo = new Set(undo.hadTo)
      const hadFrom = new Set(undo.hadFrom)
      await putEmails(
        db,
        accountId,
        rows.map((row) => {
          const mailboxIds = { ...row.mailboxIds }
          if (!hadTo.has(row.id)) delete mailboxIds[undo.to]
          if (undo.from !== null && hadFrom.has(row.id)) mailboxIds[undo.from] = true
          return { ...toEnvelope(row), mailboxIds }
        }),
      )
      return
    }
    case 'refetchEmails': {
      const ids = undoTargets(intent, onlyIds)
      if (ids.length === 0) return
      // The rejected ids still exist server-side (that is WHY the destroy was rejected). Anything
      // the server reports as `notFound` really is gone — leave it deleted.
      const { list } = await port.getEmailEnvelopes(ids)
      if (list.length > 0) await putEmails(db, accountId, list)
      return
    }
    case 'mailbox': {
      if (undo.prior !== null) await db.mailboxes.put(undo.prior)
      else await deleteMailbox(db, accountId, undo.id)
      return
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Enqueue.
// ---------------------------------------------------------------------------------------------

export interface EnqueueOptions {
  /** Client-generated, stable-across-retries intent id (caller supplies it — no ambient randomness). */
  readonly id: Id
  readonly ifInState?: string | null
  readonly now: number
  /** Epoch ms before which replay must not fire (M2.8 undo-send grace); omit for immediate replay. */
  readonly notBefore?: number | null
}

/** Apply optimistically + persist the intent together with its durable undo (M3.3). */
export async function enqueueAction(
  db: ReplicaDb,
  accountId: Id,
  intent: OutboxIntent,
  options: EnqueueOptions,
): Promise<{ id: Id; undo: OutboxUndo }> {
  const undo = await applyOptimistic(db, accountId, intent)
  const row: OutboxRow = {
    accountId,
    id: options.id,
    type: intent.kind,
    payload: intent,
    ifInState: options.ifInState ?? null,
    status: 'pending',
    attempts: 0,
    createdAt: options.now,
    lastError: null,
    notBefore: options.notBefore ?? null,
    nextAttemptAt: null,
    undo,
    conflict: null,
    refreshes: 0,
  }
  await enqueue(db, row)
  return { id: options.id, undo }
}

// ---------------------------------------------------------------------------------------------
// Replay.
// ---------------------------------------------------------------------------------------------

function keywordUpdate(
  intent: Extract<OutboxIntent, { kind: 'setKeywords' }>,
): Record<Id, PatchObject> {
  const patch: PatchObject = { [`keywords/${intent.keyword}`]: intent.value ? true : null }
  return Object.fromEntries(intent.emailIds.map((id) => [id, patch]))
}

function moveUpdate(intent: Extract<OutboxIntent, { kind: 'move' }>): Record<Id, PatchObject> {
  const patch: PatchObject = { [`mailboxIds/${intent.to}`]: true }
  if (intent.from !== null) patch[`mailboxIds/${intent.from}`] = null
  return Object.fromEntries(intent.emailIds.map((id) => [id, patch]))
}

function executeIntent(
  port: JmapPort,
  intent: OutboxIntent,
  ifInState: string | null,
): Promise<PortSetResult> {
  switch (intent.kind) {
    case 'setKeywords':
      return port.setEmails({ update: keywordUpdate(intent), ifInState })
    case 'move':
      return port.setEmails({ update: moveUpdate(intent), ifInState })
    case 'destroyEmails':
      return port.setEmails({ destroy: intent.emailIds, ifInState })
    case 'createMailbox': {
      const props: Partial<Mailbox> = { name: intent.props.name, parentId: intent.props.parentId }
      if (intent.props.role != null) props.role = intent.props.role
      return port.setMailboxes({ create: { [intent.creationId]: props }, ifInState })
    }
    case 'renameMailbox':
      return port.setMailboxes({ update: { [intent.id]: { name: intent.name } }, ifInState })
    case 'moveMailbox':
      return port.setMailboxes({
        update: { [intent.id]: { parentId: intent.parentId } },
        ifInState,
      })
    case 'deleteMailbox':
      return port.setMailboxes({ destroy: [intent.id], ifInState })
    case 'saveDraft':
      // create-new + destroy-old in one call — RFC 8620 §5.3 processes create before destroy, so the
      // new draft exists before the prior one is removed (gap-free).
      return port.setEmails({
        create: { [intent.creationId]: intent.email },
        ...(intent.priorServerId ? { destroy: [intent.priorServerId] } : {}),
        ifInState,
      })
    case 'discardDraft':
      return port.setEmails({ destroy: [intent.serverEmailId], ifInState })
    case 'sendEmail':
      return port.submitEmail({
        emailCreationId: intent.emailCreationId,
        email: intent.email,
        destroyServerDraftId: intent.priorServerId,
        submissionCreationId: intent.submissionCreationId,
        identityId: intent.identityId,
        envelope: intent.envelope,
        onSuccessUpdateEmail: intent.onSuccessUpdateEmail,
        sourceUpdate: intent.source
          ? { id: intent.source.emailId, patch: { [`keywords/${intent.source.keyword}`]: true } }
          : null,
        ifInState,
      })
  }
}

/**
 * EVERY rejected object of this intent, keyed by the id (or creation id) it failed under (M3.3,
 * defect D1). The predecessor returned only the FIRST error and the caller then rolled the WHOLE
 * intent back — so one `notFound` in a 500-id destroy resurrected 500 messages.
 *
 * A `Map` (not a record) so `noUncheckedIndexedAccess` cannot be side-stepped.
 */
function rejections(intent: OutboxIntent, result: PortSetResult): Map<string, PortSetError> {
  const found = new Map<string, PortSetError>()
  const collect = (record: Record<string, PortSetError>, ids: readonly string[]): void => {
    for (const id of ids) {
      const error = record[id]
      if (error) found.set(id, error)
    }
  }
  switch (intent.kind) {
    case 'setKeywords':
    case 'move':
      collect(result.notUpdated, intent.emailIds)
      break
    case 'destroyEmails':
      collect(result.notDestroyed, intent.emailIds)
      break
    case 'createMailbox':
      collect(result.notCreated, [intent.creationId])
      break
    case 'renameMailbox':
    case 'moveMailbox':
      collect(result.notUpdated, [intent.id])
      break
    case 'deleteMailbox':
      collect(result.notDestroyed, [intent.id])
      break
    case 'saveDraft':
      collect(result.notCreated, [intent.creationId])
      break
    case 'discardDraft':
      collect(result.notDestroyed, [intent.serverEmailId])
      break
    case 'sendEmail':
      // The result is the EmailSubmission/set response — a rejected submission (bad recipient, quota,
      // size) lands in notCreated under the submission creation id.
      collect(result.notCreated, [intent.submissionCreationId])
      break
  }
  return found
}

/**
 * On a confirmed create, swap the optimistic client id for the server id — on the mailbox row AND
 * on every dependent reference: emails filed into it (mailboxIds → amb/akw recomputed), child
 * mailboxes' parentId, and any still-QUEUED outbox intent whose payload points at the temp id
 * (e.g. a rename/delete/move of the folder queued right after its create). Otherwise those
 * references dangle and the server rejects them with a bogus `notFound`.
 */
async function reconcileCreate(
  db: ReplicaDb,
  accountId: Id,
  intent: OutboxIntent,
  result: PortSetResult,
): Promise<void> {
  if (intent.kind !== 'createMailbox') return
  const created = result.created[intent.creationId]
  if (!created) return
  const tempId = intent.creationId
  const serverId = created.id

  const temp = await db.mailboxes.get([accountId, tempId])
  await deleteMailbox(db, accountId, tempId)
  if (temp) await db.mailboxes.put({ ...temp, id: serverId })

  // Emails filed into the temp folder → re-file under the server id (putEmails recomputes amb/akw).
  const affected = await db.emails.where('amb').equals(scopeKey(accountId, tempId)).toArray()
  if (affected.length > 0) {
    await putEmails(
      db,
      accountId,
      affected.map((row) => {
        const mailboxIds = { ...row.mailboxIds }
        delete mailboxIds[tempId]
        mailboxIds[serverId] = true
        return { ...row, mailboxIds }
      }),
    )
  }

  // Child mailboxes created under the temp folder.
  await db.mailboxes
    .where('accountId')
    .equals(accountId)
    .filter((row) => row.parentId === tempId)
    .modify({ parentId: serverId })

  // Still-queued intents that reference the temp id in their payload. An `inflight` row is being
  // executed right now against the id it was built with — rewriting it under the executing pass
  // would have no effect on the in-flight request and could corrupt its retry payload.
  const queued = await db.outbox.where('accountId').equals(accountId).toArray()
  for (const queuedRow of queued) {
    if (queuedRow.status === 'inflight') continue
    const rewritten = rewriteIntentTarget(queuedRow.payload as OutboxIntent, tempId, serverId)
    if (rewritten) {
      await db.outbox.update([accountId, queuedRow.id], { payload: rewritten })
    }
  }
}

/** On a confirmed draft save, record the new server Email id on the local drafts row (M2.6). */
async function reconcileDraftSave(
  db: ReplicaDb,
  accountId: Id,
  intent: OutboxIntent,
  result: PortSetResult,
): Promise<void> {
  if (intent.kind !== 'saveDraft') return
  const created = result.created[intent.creationId]
  if (!created) return
  await db.drafts.update([accountId, intent.localId], {
    serverEmailId: created.id,
    status: 'synced',
    lastError: null,
  })
}

/**
 * Mark the local drafts row `error` when its server save/discard was rejected (M2.6). `code` is a
 * stable JMAP `SetError` type or a {@link ConflictCode} — never prose (M3.3, defect D8).
 */
async function stampDraftError(
  db: ReplicaDb,
  accountId: Id,
  intent: OutboxIntent,
  code: string,
): Promise<void> {
  if (intent.kind !== 'saveDraft' && intent.kind !== 'discardDraft') return
  await db.drafts.update([accountId, intent.localId], {
    status: 'error',
    lastError: code,
    errorKind: 'save',
  })
}

/**
 * On a confirmed send, drop the local drafts edit-state row (M2.8 — the Sent copy arrives via delta).
 * `onSuccessUpdateEmail` (Drafts→Sent, clear `$draft`) is best-effort per RFC 8621 §7.5: if the
 * submission is accepted but the refile patch fails, the sent message lingers in Drafts flagged
 * `$draft` (a misfile the user can correct), but it was still sent — so we still drop the edit-state.
 */
async function reconcileSend(
  db: ReplicaDb,
  accountId: Id,
  intent: OutboxIntent,
  result: PortSetResult,
): Promise<void> {
  if (intent.kind !== 'sendEmail') return
  if (!result.created[intent.submissionCreationId]) return
  await deleteDraft(db, accountId, intent.localId)
}

/** Mark the local drafts row `error` when a send was rejected (M2.8) — the notifier reopens it. */
async function stampSendError(
  db: ReplicaDb,
  accountId: Id,
  intent: OutboxIntent,
  code: string,
): Promise<void> {
  if (intent.kind !== 'sendEmail') return
  await db.drafts.update([accountId, intent.localId], {
    status: 'error',
    lastError: code,
    errorKind: 'send',
  })
}

/**
 * On a REJECTED send (M2.8), adopt the draft the sibling `Email/set` just created. The submission
 * failed but its Email/set create ran first and committed (a new draft in Drafts, the prior one
 * destroyed) — so the local row's `serverEmailId` now points at a destroyed id. Re-point it at the
 * fresh id so the reopened draft's next save replaces it in place instead of destroying a gone id
 * and spawning a duplicate. Only reachable when the request itself succeeded (a per-object
 * rejection); a transport/method throw carries no result, so that residue is reconciled by re-sync.
 */
async function reconcileSendFailure(
  db: ReplicaDb,
  accountId: Id,
  intent: OutboxIntent,
  result: PortSetResult,
): Promise<void> {
  if (intent.kind !== 'sendEmail') return
  const created = result.emailCreated
  if (!created) return
  await db.drafts.update([accountId, intent.localId], { serverEmailId: created.id })
}

/**
 * Rewrite an intent's mailbox references from `fromId` to `toId`; null when it referenced neither.
 * Both the SUBJECT of a folder intent (`renameMailbox.id`, `moveMailbox.id`, `deleteMailbox.id`) and
 * its target/parent must be rewritten (M3.3, defect D5): create-then-rename a folder offline used to
 * leave the rename pointing at the temp creation id, which the server answered with `notFound` — a
 * bogus conflict plus a permanently mis-named folder on the server.
 */
function rewriteIntentTarget(intent: OutboxIntent, fromId: Id, toId: Id): OutboxIntent | null {
  switch (intent.kind) {
    case 'move':
      if (intent.to === fromId) return { ...intent, to: toId }
      if (intent.from === fromId) return { ...intent, from: toId }
      return null
    case 'renameMailbox':
    case 'deleteMailbox':
      return intent.id === fromId ? { ...intent, id: toId } : null
    case 'moveMailbox': {
      const id = intent.id === fromId ? toId : intent.id
      const parentId = intent.parentId === fromId ? toId : intent.parentId
      return id !== intent.id || parentId !== intent.parentId ? { ...intent, id, parentId } : null
    }
    case 'createMailbox':
      return intent.props.parentId === fromId
        ? { ...intent, props: { ...intent.props, parentId: toId } }
        : null
    default:
      return null
  }
}

export interface ReplayOptions {
  /** Wall clock for the `notBefore` grace + the `nextAttemptAt` backoff gate; defaults to `Date.now()`. */
  readonly now?: number
  /** Injected jitter source for the backoff curve (tests pass `() => 0`); defaults to `Math.random`. */
  readonly random?: () => number
  /** Re-sync the given type and return its FRESH state string — the bounded `stateMismatch` recovery. */
  readonly refreshState?: (type: 'Mailbox') => Promise<string | null>
  /** `false` skips the pass entirely (the engine's `isOnline()` guard). Defaults to `true`. */
  readonly online?: boolean
  readonly backoff?: OutboxBackoff
}

export interface ReplaySummary {
  /** Rows completed this pass (confirmed, or already-satisfied server-side). */
  readonly replayed: number
  /** Rows dead-lettered this pass (a permanent, user-facing rejection). */
  readonly failed: number
  /** Rows still `pending` whose attempt count has passed {@link STUCK_AFTER_ATTEMPTS}. */
  readonly stuck: number
  /** Total dead letters in the queue after the pass (the problems-dialog backlog). */
  readonly conflicted: number
}

/** A row is replayable when BOTH its undo-send grace and its retry backoff have elapsed. */
function readyAt(row: OutboxRow): number {
  return Math.max(row.notBefore ?? 0, row.nextAttemptAt ?? 0)
}

/**
 * Apply every rollback still OWED (an `error` row whose `undo` was never applied — a re-fetch that
 * could not reach the server, or a crash between the dead-letter write and the undo). Runs at the
 * start of every pass, so a stale optimistic change can never survive silently: it is either undone
 * or still visibly listed as a problem.
 */
async function drainOwedUndos(port: JmapPort, db: ReplicaDb, accountId: Id): Promise<void> {
  for (const row of await failedOutbox(db, accountId)) {
    const undo = row.undo ?? null
    if (undo === null) continue
    try {
      await applyUndo(
        db,
        port,
        accountId,
        row.payload as OutboxIntent,
        undo,
        row.conflict?.ids ?? null,
      )
      await db.outbox.update([accountId, row.id], { undo: null })
    } catch {
      // Network — the rollback stays OWED and is retried on the next pass. Never dropped.
    }
  }
}

/**
 * Recover intents stranded `inflight` by a leader killed mid-request. Re-sending an idempotent `set`
 * is safe → back to `pending`. But an `EmailSubmission` is NOT idempotent: a re-sent `sendEmail`
 * could deliver the message twice, so a stranded send is dead-lettered with the `sendInterrupted`
 * CODE ("was it sent?") instead of auto-resent (M2.8) — the user decides via the reopened draft.
 */
async function recoverStranded(db: ReplicaDb, accountId: Id, now: number): Promise<void> {
  const stranded = await db.outbox
    .where('[accountId+status]')
    .equals([accountId, 'inflight'])
    .toArray()
  for (const row of stranded) {
    const intent = row.payload as OutboxIntent
    if (intent.kind !== 'sendEmail') {
      await db.outbox.update([accountId, row.id], { status: 'pending' })
      continue
    }
    const code: ConflictCode = 'sendInterrupted'
    await stampSendError(db, accountId, intent, code)
    const conflict: OutboxConflict = {
      code,
      errorType: null,
      detail: null,
      ids: [intent.submissionCreationId],
      at: now,
    }
    await db.outbox.update([accountId, row.id], { status: 'error', lastError: code, conflict })
  }
}

/**
 * Replay the pending outbox in FIFO order against the server.
 *
 *  1. drain any OWED rollback, 2. recover stranded `inflight` rows, 3. replay every `pending` row
 *  whose grace + backoff have elapsed.
 *
 * A transient failure backs the row off and STOPS the pass (the server is unhappy, not the row —
 * and FIFO means the failed row is first anyway) WITHOUT rolling back or dead-lettering. A permanent
 * rejection undoes only the FAILED ids, dead-letters the row and CONTINUES (a poison intent must not
 * starve the FIFO tail). Auth expiry re-throws with the row left `pending`.
 */
export async function replayOutbox(
  port: JmapPort,
  db: ReplicaDb,
  accountId: Id,
  options: ReplayOptions = {},
): Promise<ReplaySummary> {
  const now = options.now ?? Date.now()
  const random = options.random ?? Math.random
  const backoff = options.backoff ?? DEFAULT_OUTBOX_BACKOFF

  const summarize = async (replayed: number, failed: number): Promise<ReplaySummary> => {
    const live = await pendingOutbox(db, accountId)
    const stuck = live.filter(
      (row) => row.status === 'pending' && row.attempts >= STUCK_AFTER_ATTEMPTS,
    ).length
    const conflicted = (await failedOutbox(db, accountId)).length
    return { replayed, failed, stuck, conflicted }
  }

  // Offline: nothing to attempt. Rows keep their optimistic state, `attempts` stays put, and NOTHING
  // is rolled back or discarded — an outage of any length costs the queue nothing.
  if (options.online === false) return summarize(0, 0)

  // Stranded-recovery FIRST: a send interrupted mid-flight becomes a dead letter whose undo (the
  // source `$answered` flag) is then owed — the drain below settles it in this same pass.
  await recoverStranded(db, accountId, now)
  await drainOwedUndos(port, db, accountId)

  const rows = (await pendingOutbox(db, accountId)).filter(
    (row) => row.status === 'pending' && readyAt(row) <= now,
  )
  let replayed = 0
  let failed = 0

  /** Dead-letter a row: undo ONLY the failed objects, stamp the conflict, keep the rest applied. */
  const deadLetter = async (
    row: OutboxRow,
    intent: OutboxIntent,
    code: ConflictCode,
    errorType: string | null,
    detail: string | null,
    ids: string[],
  ): Promise<void> => {
    failed += 1
    const conflict: OutboxConflict = { code, errorType, detail, ids, at: now }
    // Persist the dead letter with its undo STILL SET (⇒ owed) before attempting the rollback, so a
    // crash or a failing re-fetch mid-undo leaves a row that `drainOwedUndos` will finish later.
    await db.outbox.update([accountId, row.id], {
      status: 'error',
      lastError: errorType ?? code,
      conflict,
    })
    await stampDraftError(db, accountId, intent, errorType ?? code)
    await stampSendError(db, accountId, intent, errorType ?? code)
    const undo = row.undo ?? null
    if (undo === null) return
    try {
      await applyUndo(db, port, accountId, intent, undo, ids)
      await db.outbox.update([accountId, row.id], { undo: null })
    } catch {
      // Owed — drained on a later pass.
    }
  }

  for (const row of rows) {
    const intent = row.payload as OutboxIntent
    // Atomically claim the row before executing: re-read + flip pending→inflight in ONE rw txn so a
    // concurrent cancelSend (undo) that deletes the row wins the race, instead of the send firing on
    // a row that was just deleted (a Dexie `update` on a missing key is a silent no-op). Skip the row
    // if it is gone or no longer pending (already claimed / canceled / not yet ready).
    const claimed = await db.transaction('rw', db.outbox, async () => {
      const current = await db.outbox.get([accountId, row.id])
      if (current === undefined || current.status !== 'pending') return false
      if (readyAt(current) > now) return false
      await db.outbox.update([accountId, row.id], { status: 'inflight' })
      return true
    })
    if (!claimed) continue

    // Execute, with a BOUNDED `stateMismatch` auto-resolve: re-sync to a fresh state and re-run. The
    // counter is persisted, so a server that always mismatches cannot spin forever across reloads.
    let ifInState = row.ifInState
    let refreshes = row.refreshes ?? 0
    let result: PortSetResult | undefined
    let thrown: unknown
    for (;;) {
      try {
        result = await executeIntent(port, intent, ifInState)
        break
      } catch (error) {
        const verdict = classifyThrown(error, row.attempts + 1, random(), backoff)
        if (
          verdict.kind !== 'refresh' ||
          refreshes >= MAX_REFRESHES ||
          options.refreshState === undefined
        ) {
          thrown = error
          break
        }
        refreshes += 1
        await db.outbox.update([accountId, row.id], { refreshes })
        // Re-execute against the FRESH state; the server's answer to that re-run IS the re-check of
        // the precondition (its per-object SetError is authoritative — a locally-derived predicate
        // could disagree with it).
        ifInState = await options.refreshState('Mailbox')
      }
    }

    if (result === undefined) {
      // ---- thrown ----
      if (isAuthExpiry(thrown)) {
        // The session expired: nothing about this row is wrong. Put it back and let the engine route
        // to the re-auth funnel (FR-AUTH-06).
        await db.outbox.update([accountId, row.id], { status: 'pending' })
        throw thrown
      }
      const attempts = row.attempts + 1
      // An `EmailSubmission` is NOT idempotent, and a THROWN error leaves it UNKNOWN whether the
      // submission reached the server — the request may have been processed and only the RESPONSE
      // lost. Auto-retrying could deliver the message TWICE. So a thrown send is dead-lettered as
      // `sendInterrupted`, exactly like a stranded `inflight` one ({@link recoverStranded}), and the
      // user decides via the reopened draft ("check Sent before resending"). Without this the
      // transient branch below would reset it to `pending` and silently re-send it. (Auth expiry is
      // handled above and IS safe to keep pending: a 401 is rejected before the mail is processed.)
      if (intent.kind === 'sendEmail') {
        await db.outbox.update([accountId, row.id], { attempts })
        await deadLetter(
          { ...row, attempts },
          intent,
          'sendInterrupted',
          thrownErrorType(thrown),
          errorMessage(thrown),
          rejectionKeys(intent),
        )
        continue
      }
      const verdict = classifyThrown(thrown, attempts, random(), backoff)
      if (verdict.kind === 'retry') {
        // TRANSIENT — the ONE branch that must never roll back and never dead-letter (defect D3).
        await db.outbox.update([accountId, row.id], {
          status: 'pending',
          attempts,
          nextAttemptAt: now + verdict.delayMs,
          lastError: thrownErrorType(thrown) ?? errorMessage(thrown),
        })
        break // the server/network is down — hammering the FIFO tail against it is pointless
      }
      // Not retryable ⇒ dead-letter it. A `refresh` verdict that reaches here has exhausted its
      // MAX_REFRESHES budget (a server that mismatches forever) — that IS the state conflict.
      // (`satisfied` is unreachable: a call that THREW cannot have already succeeded.)
      const code: ConflictCode = verdict.kind === 'conflict' ? verdict.code : 'stateConflict'
      const detail = verdict.kind === 'conflict' ? verdict.detail : errorMessage(thrown)
      await db.outbox.update([accountId, row.id], { attempts, refreshes })
      await deadLetter({ ...row, refreshes }, intent, code, thrownErrorType(thrown), detail, [
        ...rejectionKeys(intent),
      ])
      continue
    }

    // ---- a response came back: classify it per REJECTED OBJECT ----
    const failures = rejections(intent, result)
    if (failures.size === 0) {
      await reconcileCreate(db, accountId, intent, result)
      await reconcileDraftSave(db, accountId, intent, result)
      await reconcileSend(db, accountId, intent, result)
      await db.outbox.delete([accountId, row.id])
      replayed += 1
      continue
    }

    const retryIds: string[] = []
    const conflictIds: string[] = []
    let worst: { code: ConflictCode; errorType: string; detail: string | null } | undefined
    for (const [id, error] of failures) {
      const verdict = classifySetError(intent.kind, error)
      if (verdict.kind === 'retry') retryIds.push(id)
      else if (verdict.kind === 'conflict') {
        conflictIds.push(id)
        worst ??= { code: verdict.code, errorType: error.type, detail: verdict.detail }
      }
      // `satisfied` (a destroy of an already-gone object) needs NOTHING: the optimistic state is
      // correct and the object is not restored (defect D2).
    }

    if (conflictIds.length === 0 && retryIds.length === 0) {
      // Every failure was `satisfied` — the intent's goal already holds server-side. A SUCCESS.
      await db.outbox.delete([accountId, row.id])
      replayed += 1
      continue
    }

    if (retryIds.length > 0) {
      // At least one object failed TRANSIENTLY (`rateLimit`) — whether or not others failed
      // permanently. Back the WHOLE row off and re-execute it later; re-sending the already-applied
      // objects is a no-op because every intent is idempotent.
      //
      // This MUST be checked before the dead-letter branch: dead-lettering a MIXED result would
      // silently drop the transient objects — never retried, never undone, never recorded in
      // `conflict.ids` — leaving their optimistic change in the replica while the server never saw
      // it. That is exactly the silent divergence FR-OFF-03 forbids. It converges: once the transient
      // failures clear, a later pass sees only the permanent ones and dead-letters then.
      const attempts = row.attempts + 1
      await db.outbox.update([accountId, row.id], {
        status: 'pending',
        attempts,
        nextAttemptAt: now + backoffDelayMs(attempts, random(), backoff),
        lastError: 'rateLimit',
      })
      break
    }

    // A permanent rejection of SOME objects: undo ONLY those, keep the applied ones applied.
    const reason = worst ?? { code: 'serverRejected' as ConflictCode, errorType: '', detail: null }
    await reconcileSendFailure(db, accountId, intent, result)
    await db.outbox.update([accountId, row.id], { attempts: row.attempts + 1 })
    await deadLetter(row, intent, reason.code, reason.errorType || null, reason.detail, conflictIds)
  }

  return summarize(replayed, failed)
}

/** Every object key this intent could fail under — the undo scope when the whole call threw. */
function rejectionKeys(intent: OutboxIntent): string[] {
  switch (intent.kind) {
    case 'setKeywords':
    case 'move':
    case 'destroyEmails':
      return [...intent.emailIds]
    case 'createMailbox':
      return [intent.creationId]
    case 'renameMailbox':
    case 'moveMailbox':
    case 'deleteMailbox':
      return [intent.id]
    case 'saveDraft':
      return [intent.creationId]
    case 'discardDraft':
      return [intent.serverEmailId]
    case 'sendEmail':
      return [intent.submissionCreationId]
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
