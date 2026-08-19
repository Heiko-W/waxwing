/**
 * The draft persistence seam (M2.6, FR-CMP-03). `flush` writes the live draft durably to the local
 * `drafts` store (the crash-safety guarantee — no server round-trip on the critical path) and then
 * dispatches a coalesced `saveDraft` outbox intent (create-new + destroy-old `Email/set` into the
 * Drafts mailbox). `close` flushes (unless empty) then closes the window; `discard` deletes the
 * local row + destroys the server draft. Reads the running engine lazily (safe before it starts).
 */

import type { EmailAddress, Id } from '@waxwing/jmap'
import { useMemo } from 'react'
import {
  type DraftRow,
  deleteDraft,
  getActiveReplica,
  getDraft,
  mailboxByRole,
  putDraft,
  type ReplicaDb,
  useReplicaOptional,
} from '../sync'
import { getEngineFor } from '../sync/engine'
import { useComposerStore } from './composer-store'
import { deserializeDraft, isEmptyDraft, serializeDraft, toEmailCreate } from './draft-email'
import { revokeInlineObjectUrls } from './inline-image-registry'
import { holdUntilParameters } from './scheduled-send'

/** Why a send could not start (surfaced by the composer as a toast). */
export type SendFailure = 'noRecipients' | 'noIdentity' | 'noSentMailbox' | 'engineUnavailable'
export type SendResult = { ok: true; undoMs: number } | { ok: false; reason: SendFailure }

/** Unique SMTP recipients (RCPT TO) across to+cc+bcc, deduped by lowercased address. */
function dedupRecipients(list: readonly EmailAddress[]): { email: string }[] {
  const seen = new Set<string>()
  const out: { email: string }[] = []
  for (const addr of list) {
    const key = addr.email.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      out.push({ email: addr.email })
    }
  }
  return out
}

/** Revoke the inline-image preview objectURLs a (discarded) draft holds — Close keeps them for reopen. */
function revokeDraftInlineImages(localId: string): void {
  const draft = useComposerStore.getState().drafts.get(localId)
  if (draft === undefined) return
  revokeInlineObjectUrls(
    draft.attachments.map((a) => a.cid).filter((cid): cid is string => cid !== null),
  )
}

export interface DraftSync {
  /** Persist the draft locally (durable) + queue the server save. No-op for an empty draft. */
  flush(localId: string): Promise<void>
  /** Save (unless empty) then close the window — the content is safe in Drafts. */
  close(localId: string): Promise<void>
  /** Delete the local draft + destroy the server draft, then close the window. */
  discard(localId: string): Promise<void>
  /**
   * Queue the draft for send (create+submit, with an undo grace of `undoMs`). Preserves the draft.
   *
   * `scheduleAt` asks the SERVER to hold the message until then (FR-CMP-11, SMTP FUTURERELEASE):
   * the submission is created now and the message leaves the queue at that time, whether or not
   * this app is running. Where the account cannot schedule, the caller must not pass it — the
   * server would reject the whole envelope rather than send immediately.
   */
  send(localId: string, opts: { undoMs: number; scheduleAt?: Date }): Promise<SendResult>
  /** Cancel a queued send while still in its grace window and reopen the draft (M2.8 Undo). */
  undoSend(localId: string): Promise<void>
}

/** Autosave/discard share this id (a later save coalesces over an earlier one). */
const outboxId = (localId: string): string => `draft:${localId}`
/** Send uses a DISTINCT id so a concurrent autosave's reconcile can never delete the queued send. */
const sendOutboxId = (localId: string): string => `send:${localId}`

async function resolveFrom(
  db: ReplicaDb,
  accountId: Id,
  fromIdentityId: string | null,
): Promise<EmailAddress | null> {
  if (fromIdentityId === null) return null
  const identity = await db.identities.get([accountId, fromIdentityId])
  return identity ? { name: identity.name, email: identity.email } : null
}

/**
 * The engine everywhere in this module is `getEngineFor(accountId)` — the account the composer's own
 * replica scope names (M4.4 Etappe 4). That is the primary today, and deliberately so: the composer
 * mounts ABOVE the acting-account scope, because there is no send-as from a delegated account yet
 * (`FromField` lists only the provider account's identities). Making it follow the ACTIVE account
 * would be a regression — the draft would be created in a shared account's Drafts under a primary
 * identity, and its outbox row would desync from that account's engine. The value here is that the
 * engine can no longer disagree with the `putDraft` / `getDraft` / `mailboxByRole(db, accountId, …)`
 * calls surrounding it, whatever the scope later becomes.
 */
async function flushDraft(db: ReplicaDb, accountId: Id, localId: string): Promise<void> {
  const draft = useComposerStore.getState().drafts.get(localId)
  if (draft === undefined || isEmptyDraft(draft)) return
  const content = serializeDraft(draft)
  const existing = await getDraft(db, accountId, localId)
  const now = Date.now()
  const row: DraftRow = {
    accountId,
    localId,
    serverEmailId: existing?.serverEmailId ?? null,
    status: 'pending',
    content,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastError: null,
  }
  await putDraft(db, row) // durable local write — the crash-safety guarantee
  // Queue the server save only when the Drafts mailbox is known; otherwise the draft is local-only
  // and stays `pending` until a later flush (once the mailbox syncs in).
  const draftsBox = await mailboxByRole(db, accountId, 'drafts')
  if (draftsBox === undefined) return
  const from = await resolveFrom(db, accountId, content.fromIdentityId)
  const email = toEmailCreate({ draft: content, draftsMailboxId: draftsBox.id, from })
  void getEngineFor(accountId)?.dispatch(
    {
      kind: 'saveDraft',
      localId,
      creationId: `draft-${localId}`,
      priorServerId: row.serverEmailId,
      email,
    },
    { id: outboxId(localId) },
  )
}

/**
 * {@link DraftSync.flush} for callers that are NOT inside the `ReplicaProvider` subtree (M3.10).
 *
 * The hook below cannot serve them: the PWA update prompt is mounted ABOVE the auth gate (see
 * `app/App.tsx`), so `useReplicaOptional()` hands it the `null` branch and its flush persists
 * nothing — the defect this exists to close. Reading {@link getActiveReplica} instead resolves the
 * replica at CALL time, which is also the correct moment: the user accepts the reload long after
 * both trees have mounted.
 *
 * No replica yet (still on the sign-in screen) is a clean no-op, not an error — the composer only
 * exists inside the shell, so there is nothing open to lose.
 */
export async function flushActiveDraft(localId: string): Promise<void> {
  const replica = getActiveReplica()
  if (replica === null) return
  await flushDraft(replica.db, replica.accountId, localId)
}

export function useDraftSync(): DraftSync {
  const replica = useReplicaOptional()
  return useMemo<DraftSync>(() => {
    const closeWindow = (localId: string): void => useComposerStore.getState().closeDraft(localId)
    if (replica === null) {
      const noop = async (): Promise<void> => {}
      return {
        flush: noop,
        close: async (localId) => closeWindow(localId),
        discard: async (localId) => {
          revokeDraftInlineImages(localId)
          closeWindow(localId)
        },
        send: async () => ({ ok: false, reason: 'noSentMailbox' }),
        undoSend: noop,
      }
    }
    const { db, accountId } = replica
    return {
      flush: (localId) => flushDraft(db, accountId, localId),
      close: async (localId) => {
        await flushDraft(db, accountId, localId)
        // Free this draft's inline-image preview objectURLs (bounds the session-long registry leak).
        // The draft is safe in the Drafts folder; reopening it re-downloads inline parts (follow-up).
        revokeDraftInlineImages(localId)
        closeWindow(localId)
      },
      discard: async (localId) => {
        const row = await getDraft(db, accountId, localId)
        await deleteDraft(db, accountId, localId)
        if (row?.serverEmailId != null) {
          void getEngineFor(accountId)?.dispatch(
            { kind: 'discardDraft', localId, serverEmailId: row.serverEmailId },
            { id: outboxId(localId) },
          )
        }
        revokeDraftInlineImages(localId)
        closeWindow(localId)
      },
      send: async (localId, opts): Promise<SendResult> => {
        const draft = useComposerStore.getState().drafts.get(localId)
        if (draft === undefined) return { ok: false, reason: 'noRecipients' }
        if (draft.to.length + draft.cc.length + draft.bcc.length === 0) {
          return { ok: false, reason: 'noRecipients' }
        }
        if (draft.fromIdentityId === undefined) return { ok: false, reason: 'noIdentity' }
        const identity = await db.identities.get([accountId, draft.fromIdentityId])
        if (identity === undefined) return { ok: false, reason: 'noIdentity' }
        const draftsBox = await mailboxByRole(db, accountId, 'drafts')
        const sentBox = await mailboxByRole(db, accountId, 'sent')
        if (draftsBox === undefined || sentBox === undefined) {
          return { ok: false, reason: 'noSentMailbox' }
        }
        // Resolve the engine BEFORE any state mutation: if it is not running (no Web Locks /
        // BroadcastChannel, or a teardown window) the dispatch below would be a silent no-op while
        // we'd already have marked the draft `sending` (which restore skips) — a silent send loss
        // with a false "sent". Bail cleanly instead, leaving the draft intact for a later retry.
        // Also covers "no engine serves this account" — refusing a send is exactly right there.
        const engine = getEngineFor(accountId)
        if (engine === null) return { ok: false, reason: 'engineUnavailable' }

        const content = serializeDraft(draft)
        const existing = await getDraft(db, accountId, localId)
        const now = Date.now()
        // Durable local write (crash-safety) — status `sending` so a restore skips it while it's queued.
        await putDraft(db, {
          accountId,
          localId,
          serverEmailId: existing?.serverEmailId ?? null,
          status: 'sending',
          content,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          lastError: null,
        })
        const from = { name: identity.name, email: identity.email }
        const email = toEmailCreate({ draft: content, draftsMailboxId: draftsBox.id, from })
        // Apply the selected identity's submission extras (RFC 8621 §6): a Reply-To header and an
        // "always bcc" copy. An identity bcc must ALSO reach the SMTP envelope (rcptTo) to deliver.
        const identityBcc = identity.bcc ?? []
        if (identity.replyTo !== null && identity.replyTo.length > 0)
          email.replyTo = identity.replyTo
        if (identityBcc.length > 0) {
          const seen = new Set(content.bcc.map((address) => address.email.toLowerCase()))
          const extra = identityBcc.filter((address) => !seen.has(address.email.toLowerCase()))
          if (extra.length > 0) email.bcc = [...content.bcc, ...extra]
        }
        const source =
          content.sourceEmailId !== null && content.sourceFlag !== null
            ? { emailId: content.sourceEmailId, keyword: content.sourceFlag }
            : null
        // Cancel any queued autosave for this draft BEFORE dispatching the send. The send uses a
        // DISTINCT outbox id (`send:<id>`), so an autosave's reconcile can no longer delete it; the
        // send captures the latest content, making a pending save redundant.
        await db.outbox.delete([accountId, outboxId(localId)])
        void engine.dispatch(
          {
            kind: 'sendEmail',
            localId,
            emailCreationId: `send-${localId}`,
            submissionCreationId: `sub-${localId}`,
            priorServerId: existing?.serverEmailId ?? null,
            email,
            identityId: identity.id,
            envelope: {
              mailFrom: {
                email: identity.email,
                // The scheduling request rides here, as an SMTP parameter — NOT as `sendAt`, which
                // is server-set and immutable (RFC 8621 §7.1).
                ...(opts.scheduleAt === undefined
                  ? {}
                  : { parameters: holdUntilParameters(opts.scheduleAt) }),
              },
              rcptTo: dedupRecipients([
                ...content.to,
                ...content.cc,
                ...content.bcc,
                ...identityBcc,
              ]),
            },
            onSuccessUpdateEmail: {
              [`mailboxIds/${draftsBox.id}`]: null,
              [`mailboxIds/${sentBox.id}`]: true,
              'keywords/$draft': null,
              'keywords/$seen': true,
            },
            source,
          },
          { id: sendOutboxId(localId), notBefore: opts.undoMs > 0 ? now + opts.undoMs : null },
        )
        return { ok: true, undoMs: opts.undoMs }
      },
      undoSend: async (localId) => {
        const engine = getEngineFor(accountId)
        if (engine === null) return
        if (!(await engine.cancelSend(sendOutboxId(localId)))) return // already sent — too late
        const row = await getDraft(db, accountId, localId)
        if (row !== undefined) {
          useComposerStore.getState().openDraft({ ...deserializeDraft(row), mode: 'docked' })
        }
      },
    }
  }, [replica])
}
