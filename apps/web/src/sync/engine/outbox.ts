/**
 * Action queue / outbox (M1.3, FR-OFF-03 skeleton, FR-ORG-01, FR-LST-04). Every write — even
 * "mark read" — is an idempotent JMAP `set` intent with a client id: it is applied to the replica
 * optimistically (instant UI), enqueued, then replayed against the server. On confirmation the row
 * is dropped; on a per-object rejection the optimistic change is rolled back and the row marked
 * `error`; on a transport error the row stays `pending` for retry. M1 scope is ONLINE replay + basic
 * retry — offline hardening and the conflict-resolution UX are M3.3.
 *
 * Rollback strategy: {@link applyOptimistic} returns an in-memory closure that restores the prior
 * replica state, and {@link enqueueAction} hands it back to the caller. The engine keeps these by
 * intent id and passes them to {@link replayOutbox}. A process restart loses the in-memory
 * rollbacks; a persisted `error` row therefore means "needs server reconciliation" — TODO(M3.3).
 */

import { type Id, JmapMethodError, type Mailbox, type PatchObject } from '@waxwing/jmap'
import {
  type EmailEnvelopeInput,
  type EmailRow,
  type OutboxRow,
  type ReplicaDb,
  scopeKey,
  toMailboxRow,
} from '../db'
import {
  deleteEmails,
  deleteMailbox,
  emailsByIds,
  enqueue,
  pendingOutbox,
  putEmails,
} from '../repo'
import type { JmapPort, PortSetResult } from './types'

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

export type Rollback = () => Promise<void>

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
// Optimistic apply.
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
    subject: row.subject,
    preview: row.preview,
    hasAttachment: row.hasAttachment,
  }
}

function present(rows: (EmailRow | undefined)[]): EmailRow[] {
  return rows.filter((row): row is EmailRow => row !== undefined)
}

/**
 * Apply an intent to the replica immediately and return a closure that undoes it. Only rows that
 * actually exist locally are touched; the rollback re-writes their captured originals.
 */
export async function applyOptimistic(
  db: ReplicaDb,
  accountId: Id,
  intent: OutboxIntent,
): Promise<Rollback> {
  switch (intent.kind) {
    case 'setKeywords': {
      const originals = present(await emailsByIds(db, accountId, intent.emailIds))
      const updated = originals.map((row) => {
        const keywords = { ...row.keywords }
        if (intent.value) keywords[intent.keyword] = true
        else delete keywords[intent.keyword]
        return { ...toEnvelope(row), keywords }
      })
      await putEmails(db, accountId, updated)
      return async () => {
        await putEmails(db, accountId, originals.map(toEnvelope))
      }
    }
    case 'move': {
      const originals = present(await emailsByIds(db, accountId, intent.emailIds))
      const updated = originals.map((row) => {
        const mailboxIds = { ...row.mailboxIds }
        if (intent.from !== null) delete mailboxIds[intent.from]
        mailboxIds[intent.to] = true
        return { ...toEnvelope(row), mailboxIds }
      })
      await putEmails(db, accountId, updated)
      return async () => {
        await putEmails(db, accountId, originals.map(toEnvelope))
      }
    }
    case 'destroyEmails': {
      const originals = present(await emailsByIds(db, accountId, intent.emailIds))
      await deleteEmails(db, accountId, intent.emailIds)
      return async () => {
        await putEmails(db, accountId, originals.map(toEnvelope))
      }
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
      return async () => {
        await deleteMailbox(db, accountId, intent.creationId)
      }
    }
    case 'renameMailbox':
    case 'moveMailbox':
    case 'deleteMailbox': {
      const prior = await db.mailboxes.get([accountId, intent.id])
      if (intent.kind === 'renameMailbox') {
        await db.mailboxes.update([accountId, intent.id], { name: intent.name })
      } else if (intent.kind === 'moveMailbox') {
        await db.mailboxes.update([accountId, intent.id], { parentId: intent.parentId })
      } else {
        await deleteMailbox(db, accountId, intent.id)
      }
      return async () => {
        if (prior) await db.mailboxes.put(prior)
        else await deleteMailbox(db, accountId, intent.id)
      }
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
}

/** Apply optimistically + persist the intent. Returns the id and its in-memory rollback. */
export async function enqueueAction(
  db: ReplicaDb,
  accountId: Id,
  intent: OutboxIntent,
  options: EnqueueOptions,
): Promise<{ id: Id; rollback: Rollback }> {
  const rollback = await applyOptimistic(db, accountId, intent)
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
  }
  await enqueue(db, row)
  return { id: options.id, rollback }
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
  }
}

/** The server-side rejection (if any) that applies to this intent's objects. */
function rejection(intent: OutboxIntent, result: PortSetResult): string | null {
  const first = (record: Record<string, { type: string }>, ids: string[]): string | null => {
    for (const id of ids) {
      const error = record[id]
      if (error) return error.type
    }
    return null
  }
  switch (intent.kind) {
    case 'setKeywords':
    case 'move':
      return first(result.notUpdated, intent.emailIds)
    case 'destroyEmails':
      return first(result.notDestroyed, intent.emailIds)
    case 'createMailbox':
      return first(result.notCreated, [intent.creationId])
    case 'renameMailbox':
    case 'moveMailbox':
      return first(result.notUpdated, [intent.id])
    case 'deleteMailbox':
      return first(result.notDestroyed, [intent.id])
  }
}

/**
 * On a confirmed create, swap the optimistic client id for the server id — on the mailbox row AND
 * on every dependent reference: emails filed into it (mailboxIds → amb/akw recomputed), child
 * mailboxes' parentId, and any still-pending outbox intent whose payload points at the temp id
 * (e.g. a `move` into the folder queued right after its create). Otherwise those references dangle.
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

  // Still-queued intents that reference the temp id in their payload.
  const queued = await db.outbox.where('accountId').equals(accountId).toArray()
  for (const queuedRow of queued) {
    const rewritten = rewriteIntentTarget(queuedRow.payload as OutboxIntent, tempId, serverId)
    if (rewritten) await db.outbox.update([accountId, queuedRow.id], { payload: rewritten })
  }
}

/** Rewrite an intent's mailbox target from `fromId` to `toId`; returns null when it referenced neither. */
function rewriteIntentTarget(intent: OutboxIntent, fromId: Id, toId: Id): OutboxIntent | null {
  switch (intent.kind) {
    case 'move':
      if (intent.to === fromId) return { ...intent, to: toId }
      if (intent.from === fromId) return { ...intent, from: toId }
      return null
    case 'moveMailbox':
      return intent.parentId === fromId ? { ...intent, parentId: toId } : null
    case 'createMailbox':
      return intent.props.parentId === fromId
        ? { ...intent, props: { ...intent.props, parentId: toId } }
        : null
    default:
      return null
  }
}

export interface ReplayOptions {
  readonly rollbacks?: Map<Id, Rollback>
  readonly maxAttempts?: number
}

export interface ReplaySummary {
  readonly replayed: number
  readonly failed: number
}

/**
 * Replay the pending outbox in FIFO order against the server. Stops on the first transport error
 * (basic retry — the engine calls again later); per-object rejections roll back and continue.
 */
export async function replayOutbox(
  port: JmapPort,
  db: ReplicaDb,
  accountId: Id,
  options: ReplayOptions = {},
): Promise<ReplaySummary> {
  const maxAttempts = options.maxAttempts ?? 5
  const rollbacks = options.rollbacks
  // Recover intents stranded `inflight` by a leader that was killed mid-request; re-sending an
  // idempotent `set` is safe, and otherwise the optimistic change would never reach the server.
  await db.outbox
    .where('[accountId+status]')
    .equals([accountId, 'inflight'])
    .modify({ status: 'pending' })
  // Replay ONLY `pending` rows; a terminal `error` row is a dead-letter (retry UX = M3.3) and must
  // never be re-sent, or one poison intent would be reprocessed on every sweep.
  const rows = (await pendingOutbox(db, accountId)).filter((row) => row.status === 'pending')
  let replayed = 0
  let failed = 0

  for (const row of rows) {
    const intent = row.payload as OutboxIntent
    await db.outbox.update([accountId, row.id], { status: 'inflight' })
    try {
      const result = await executeIntent(port, intent, row.ifInState)
      const rejected = rejection(intent, result)
      if (rejected !== null) {
        await rollbacks?.get(row.id)?.()
        rollbacks?.delete(row.id)
        await db.outbox.update([accountId, row.id], { status: 'error', lastError: rejected })
        failed += 1
        continue
      }
      await reconcileCreate(db, accountId, intent, result)
      await db.outbox.delete([accountId, row.id])
      rollbacks?.delete(row.id)
      replayed += 1
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (error instanceof JmapMethodError) {
        // A permanent method-level rejection (invalidArguments, stateMismatch, …). Treat it like a
        // per-object rejection — roll back, mark `error`, and CONTINUE — so it cannot starve the
        // FIFO tail (a `break` here would wedge every later action behind the poison intent).
        await rollbacks?.get(row.id)?.()
        rollbacks?.delete(row.id)
        await db.outbox.update([accountId, row.id], { status: 'error', lastError: message })
        failed += 1
        continue
      }
      // A transient transport/network error: bump attempts, roll back + give up after maxAttempts,
      // else leave `pending`; stop the pass either way (the engine retries the whole queue later).
      const attempts = row.attempts + 1
      if (attempts >= maxAttempts) {
        await rollbacks?.get(row.id)?.()
        rollbacks?.delete(row.id)
        await db.outbox.update([accountId, row.id], {
          status: 'error',
          attempts,
          lastError: message,
        })
        failed += 1
      } else {
        await db.outbox.update([accountId, row.id], {
          status: 'pending',
          attempts,
          lastError: message,
        })
      }
      break
    }
  }

  return { replayed, failed }
}
