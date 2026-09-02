/**
 * The draft persistence seam (M2.6, FR-CMP-03). `flush` writes the live draft durably to the local
 * `drafts` store (the crash-safety guarantee — no server round-trip on the critical path) and then
 * dispatches a coalesced `saveDraft` outbox intent (create-new + destroy-old `Email/set` into the
 * Drafts mailbox). `close` flushes then closes the window; `discard` deletes the local row +
 * destroys the server draft. Reads the running engine lazily (safe before it starts).
 *
 * "Empty" is a THREE-way answer, not a two-way one. An empty draft with nothing saved is dropped;
 * an empty draft that HAS been saved is discarded, locally and on the server, because emptying a
 * draft is how a writer takes it back; and an unchanged draft that the server already has is left
 * alone, because a save is create-new + destroy-old and would only mint a new id for the same text.
 */

import type { EmailAddress, EmailSubmissionAddress, Id } from '@waxwing/jmap'
import { useMemo } from 'react'
import { useSessionOptional } from '../app/session/context'
import {
  type DraftRow,
  deleteDraft,
  dispatchOrReport,
  getActiveReplica,
  getDraft,
  mailboxByRole,
  putDraft,
  type ReplicaDb,
  useReplicaOptional,
} from '../sync'
import { getEngineFor } from '../sync/engine'
import { useComposerStore } from './composer-store'
import {
  deserializeDraft,
  draftSendOptions,
  isEmptyDraft,
  sameDraftContent,
  serializeDraft,
  toEmailCreate,
} from './draft-email'
import { revokeInlineObjectUrls } from './inline-image-registry'
import { holdUntilParameters } from './scheduled-send'
import { mailFromParameters, rcptToParameters, readSubmissionExtensions } from './send-options'

/** Why a send could not start (surfaced by the composer as a toast). */
export type SendFailure =
  | 'noRecipients'
  | 'noIdentity'
  | 'noSentMailbox'
  | 'engineUnavailable'
  /**
   * The durable enqueue itself failed — realistically a `QuotaExceededError` on the `put` that
   * carries the whole mail body.
   *
   * Its own reason rather than a shrug, because it is the only failure here that happens AFTER the
   * draft row was written `sending`: the recovery has to undo that, and the message the user needs
   * is about storage, not about recipients or a mailbox.
   */
  | 'queueFailed'
export type SendResult = { ok: true; undoMs: number } | { ok: false; reason: SendFailure }

/**
 * Unique SMTP recipients (RCPT TO) across to+cc+bcc, deduped by lowercased address.
 *
 * Each carries its own DSN parameters (M-7), because `NOTIFY`/`ORCPT` are per-RECIPIENT in SMTP —
 * that is the whole reason a receipt can tell you *which* of five addresses failed. `ORCPT` is
 * built from `addr.email` as the writer typed it, not the lower-cased dedup key: the point of the
 * parameter is to echo the original address back in the report.
 */
function dedupRecipients(
  list: readonly EmailAddress[],
  parameters: (email: string) => Record<string, string | null> | null,
): EmailSubmissionAddress[] {
  const seen = new Set<string>()
  const out: EmailSubmissionAddress[] = []
  for (const addr of list) {
    const key = addr.email.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      const params = parameters(addr.email)
      out.push(params === null ? { email: addr.email } : { email: addr.email, parameters: params })
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
  /**
   * Persist the draft locally (durable) + queue the server save.
   *
   * An EMPTIED draft that was already saved is deleted instead (local row + server copy); one that
   * was never saved is a no-op; one the server already has unchanged is a no-op too.
   */
  flush(localId: string): Promise<void>
  /** Save (or, if it has been emptied, delete) then close the window — the content is safe in Drafts. */
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

/** Merge two optional parameter maps into one, or `null` when neither has anything to say. */
function mergeEnvelopeParameters(
  ...maps: readonly (Record<string, string | null> | null)[]
): Record<string, string | null> | null {
  const merged: Record<string, string | null> = {}
  for (const map of maps) if (map !== null) Object.assign(merged, map)
  return Object.keys(merged).length > 0 ? merged : null
}

/** Autosave/discard share this id (a later save coalesces over an earlier one). */
const outboxId = (localId: string): string => `draft:${localId}`
/** Send uses a DISTINCT id so a concurrent autosave's reconcile can never delete the queued send. */
const sendOutboxId = (localId: string): string => `send:${localId}`

/**
 * Drop this draft's queued autosave — but ONLY while it is still `pending`.
 *
 * Deleting it unconditionally deletes an `inflight` row too, and the request that row is executing
 * comes back anyway: the server creates the draft, `reconcileDraftSave` records its id, and nothing
 * is left in the queue that remembers to destroy it. Left in place, the same reconcile re-points it
 * at the new server id (and, for a discard, queues its removal), which is why an `inflight` row is
 * the one case where doing nothing is right.
 *
 * Re-read inside the transaction because the status can change between the read and the delete —
 * the whole point is the moment when replay claims the row.
 */
async function dropPendingSave(db: ReplicaDb, accountId: Id, localId: string): Promise<void> {
  const key: [Id, string] = [accountId, outboxId(localId)]
  await db.transaction('rw', db.outbox, async () => {
    const queued = await db.outbox.get(key)
    if (queued?.status !== 'pending') return
    await db.outbox.delete(key)
  })
}

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
  if (draft === undefined) return
  const existing = await getDraft(db, accountId, localId)
  if (isEmptyDraft(draft)) {
    // An empty draft used to mean "return, do nothing", which is right only while nothing has been
    // saved yet. Once a row exists, doing nothing is the WRONG answer to "I typed something, thought
    // better of it, deleted it and closed the window": the local row and the server copy both kept
    // the old text, and the Drafts folder kept a message the writer had emptied on purpose. Emptying
    // a saved draft IS a discard — just without the window closing (that is `close`'s job).
    if (existing === undefined) return
    await deleteDraft(db, accountId, localId)
    if (existing.serverEmailId !== null) {
      dispatchOrReport(
        getEngineFor(accountId)?.dispatch(
          { kind: 'discardDraft', localId, serverEmailId: existing.serverEmailId },
          { id: outboxId(localId) },
        ),
      )
    } else {
      await dropPendingSave(db, accountId, localId)
    }
    return
  }
  const content = serializeDraft(draft)
  // Nothing changed since the server acknowledged this draft ⇒ nothing to do. A save is create-new
  // + destroy-old, so an autosave with identical content is not free: it mints a new server id for
  // the same text. The autosave used to be armed by ANY store change — minimize, restore, full
  // screen — and each of those spent a round trip on a message nobody had edited.
  if (existing?.status === 'synced' && sameDraftContent(content, existing.content)) return
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
  // Autosave is best-effort by design — but "the local row is written and the server copy is not"
  // is worth one toast, and it used to be an unhandled rejection in the console.
  dispatchOrReport(
    getEngineFor(accountId)?.dispatch(
      {
        kind: 'saveDraft',
        localId,
        creationId: `draft-${localId}`,
        priorServerId: row.serverEmailId,
        email,
      },
      { id: outboxId(localId) },
    ),
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

/**
 * Persist every open draft, best-effort and time-boxed. Used by anything that is about to take the
 * composer away: the M3.5 reload prompt and the sign-out teardown.
 *
 * **It can never fail the thing it precedes, and can never delay it indefinitely.** `flush` writes
 * to IndexedDB, which rejects on a full disk (the state M3.4's storage notifier exists for), on a
 * closed database, and in Safari's private mode — and a rejection here used to swallow the
 * `activate()` that followed it: the user clicked "Reload", the toast dismissed itself, and nothing
 * happened, ever again. Saving the draft is best-effort; stranding the user on a dead build — or
 * holding a sign-out open on a shared machine — is not an acceptable price for it. So:
 * `allSettled`, so one bad draft cannot take the others' flushes down with it, and a DEADLINE,
 * because a write can also do neither — a database blocked behind another tab's `versionchange`
 * simply never settles, and `allSettled` would wait for it forever.
 *
 * The caller must START this while the replica is still mounted: {@link flushActiveDraft} resolves
 * it per call, and a sign-out unmounts the provider in the same tick it clears the screen.
 */
export async function flushOpenDrafts(
  draftSync: Pick<DraftSync, 'flush'>,
  deadlineMs: number,
): Promise<void> {
  const openIds = [...useComposerStore.getState().drafts.keys()]
  const flushed = Promise.allSettled(openIds.map((localId) => draftSync.flush(localId)))
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, deadlineMs)
  })
  await Promise.race([flushed, deadline])
  clearTimeout(timer)
}

/** {@link flushOpenDrafts} against the real seam — for callers outside the `ReplicaProvider` tree. */
export const ACTIVE_DRAFT_SYNC: Pick<DraftSync, 'flush'> = { flush: flushActiveDraft }

export function useDraftSync(): DraftSync {
  const replica = useReplicaOptional()
  const connected = useSessionOptional()
  const jmapSession = connected?.jmapSession ?? null
  const sessionAccountId = connected?.accountId ?? null
  // What this account may be ASKED for. Absent session (unit tests, pre-connect) reads as "no
  // extensions", which makes every envelope identical to the one sent before M-7 existed — the
  // send path must never become dependent on a capability document having arrived.
  //
  // Memoized because the DraftSync below is, and a fresh object every render would rebuild the whole
  // seam on every keystroke.
  const extensions = useMemo(
    () => readSubmissionExtensions(jmapSession, sessionAccountId),
    [jmapSession, sessionAccountId],
  )
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
          dispatchOrReport(
            getEngineFor(accountId)?.dispatch(
              { kind: 'discardDraft', localId, serverEmailId: row.serverEmailId },
              { id: outboxId(localId) },
            ),
          )
        } else {
          // No server copy YET is not the same as no server copy EVER: a draft without an id
          // typically has an autosave still waiting in the queue (offline, a backoff window after a
          // transient failure, a follower tab whose leader has not run a pass). Discarding deleted
          // the local row and dispatched nothing, so the next replay created on the server exactly
          // the draft the user threw away — no race required. Cancel that save instead.
          await dropPendingSave(db, accountId, localId)
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
        // The identity's Reply-To is a FALLBACK now (M-11): `toEmailCreate` has already written the
        // draft's own, and overwriting it here would make the per-message field the one thing in the
        // composer that silently does nothing.
        const draftReplyTo = content.replyTo ?? []
        if (draftReplyTo.length === 0 && identity.replyTo !== null && identity.replyTo.length > 0) {
          email.replyTo = identity.replyTo
        }
        if (identityBcc.length > 0) {
          const seen = new Set(content.bcc.map((address) => address.email.toLowerCase()))
          const extra = identityBcc.filter((address) => !seen.has(address.email.toLowerCase()))
          if (extra.length > 0) email.bcc = [...content.bcc, ...extra]
        }
        const sendOptions = draftSendOptions(content)
        const mergedParameters = mergeEnvelopeParameters(
          opts.scheduleAt === undefined ? null : holdUntilParameters(opts.scheduleAt),
          mailFromParameters(sendOptions, extensions),
        )
        const source =
          content.sourceEmailId !== null && content.sourceFlag !== null
            ? { emailId: content.sourceEmailId, keyword: content.sourceFlag }
            : null
        // Cancel any queued autosave for this draft BEFORE dispatching the send. The send uses a
        // DISTINCT outbox id (`send:<id>`), so an autosave's reconcile can no longer delete it; the
        // send captures the latest content, making a pending save redundant.
        //
        // Only a PENDING one, though: deleting an `inflight` autosave does not stop the request it
        // is executing, and the draft it creates would then be a copy of the message in the Drafts
        // folder that nothing ever removes — the send's `destroyServerDraftId` still names the id
        // from BEFORE that save. Leaving the row alone lets `reconcileDraftSave` re-point this very
        // send at the id the save produced.
        await dropPendingSave(db, accountId, localId)
        // AWAITED, and the catch is the point of the await.
        //
        // This was fire-and-forget under a comment explaining that a silent send loss is exactly
        // what must not happen here — and `dispatch` awaits `stateGuard`, `enqueueAction` and
        // `refreshQueueCounts`, all IndexedDB writes that can throw. When one did, the draft row
        // was already durably `sending` (which `use-draft-restore` skips), this returned
        // `{ok: true}`, and `ComposerWindow` closed the window: no outbox row, no queued-sends
        // chip, no dead letter, nothing to reopen. The user saw "Sending…" and the mail did not
        // exist anywhere.
        try {
          await engine.dispatch(
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
                  // ONE parameter map, built from two independent wishes: the scheduling request
                  // (FUTURERELEASE) and the send options (DSN / REQUIRETLS / MT-PRIORITY). They are
                  // merged rather than chosen between — scheduling a receipted message is an ordinary
                  // thing to want, and an envelope carries all of its parameters or none of them.
                  // Omitted entirely when both are empty, so an ordinary send is unchanged.
                  ...(mergedParameters === null ? {} : { parameters: mergedParameters }),
                },
                rcptTo: dedupRecipients(
                  [...content.to, ...content.cc, ...content.bcc, ...identityBcc],
                  (email) => rcptToParameters(email, sendOptions, extensions),
                ),
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
        } catch (error) {
          // Back to a row the composer can restore and the user can retry, with the failure on it.
          await putDraft(db, {
            accountId,
            localId,
            serverEmailId: existing?.serverEmailId ?? null,
            status: 'error',
            errorKind: 'send',
            content,
            createdAt: existing?.createdAt ?? now,
            updatedAt: Date.now(),
            lastError: error instanceof Error ? error.message : String(error),
          })
          return { ok: false, reason: 'queueFailed' }
        }
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
  }, [replica, extensions])
}
