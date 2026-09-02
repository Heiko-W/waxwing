/**
 * Open a Drafts-mailbox message back into the composer (M2.6, FR-CMP-03). Prefers the full-fidelity
 * LOCAL copy (keeps `bcc` and reopens under the SAME localId, so autosave keeps coalescing onto the
 * same server draft); falls back to the server envelope + fetched body for a draft created elsewhere
 * (loses `bcc` — it isn't on the envelope). Reads the running engine lazily (safe before it starts).
 */

import type { Id } from '@waxwing/jmap'
import { useCallback } from 'react'
import { useSessionOptional } from '../app/session/context'
import { pickHtmlBody } from '../mail/message-body'
import { getDraftByServerId, putDraft, type ReplicaDb, useReplicaOptional } from '../sync'
import { useAccountEngine } from '../sync/engine'
import { useComposerStore } from './composer-store'
import { deserializeDraft, serializeDraft, toDraftInit } from './draft-email'

export interface DraftOpener {
  /** Open the Drafts message `emailId` in the composer (local copy if we have one; else the server body). */
  open(emailId: Id): Promise<void>
  /**
   * May a draft of the ACTING account be opened for editing at all? False for a delegated account.
   *
   * This hook runs inside `ActiveAccountScope`; the composer mounts OUTSIDE it, on the primary
   * account, because there is no send-as from a delegated account yet (ADR-020). Opening Carol's
   * draft therefore adopted it under Carol's id and then flushed it under Alice's: a COPY appeared
   * in Alice's Drafts folder on close, Carol's original stayed untouched, and Discard found no
   * `serverEmailId` and destroyed nothing — the "folder full of copies" the `adoptServerDraft`
   * comment describes, one account over. Until send-as exists, such a draft is readable, not
   * editable; callers offer the reading pane instead.
   */
  readonly canEdit: boolean
}

export function useDraftOpener(): DraftOpener {
  const replica = useReplicaOptional()
  const engine = useAccountEngine()
  // The account the COMPOSER writes to (`sync/engine/react.tsx` mounts the outer provider on it),
  // which is not necessarily the one this hook is scoped to. No session (unit tests, pre-connect)
  // reads as "not delegated", so the single-account path is exactly today's.
  const composerAccountId = useSessionOptional()?.accountId ?? null
  const canEdit =
    replica !== null && (composerAccountId === null || replica.accountId === composerAccountId)
  const open = useCallback(
    async (emailId: Id): Promise<void> => {
      if (replica === null || !canEdit) return
      const { db, accountId } = replica
      const openDraft = useComposerStore.getState().openDraft
      // Full-fidelity local copy — reopen it (idempotent: focuses if already open).
      const local = await getDraftByServerId(db, accountId, emailId)
      if (local) {
        openDraft({ ...deserializeDraft(local), mode: 'docked' })
        return
      }
      // Server-only draft: seed from the envelope + on-demand body.
      const email = await db.emails.get([accountId, emailId])
      if (email === undefined) return
      await engine?.fetchBody(emailId)
      const body = await db.emailBodies.get([accountId, emailId])
      const htmlParts = body ? pickHtmlBody(body) : null
      const bodyHtml = htmlParts !== null ? htmlParts.map((part) => part.value).join('') : ''
      const localId = openDraft(toDraftInit(email, bodyHtml))
      await adoptServerDraft(db, accountId, localId, emailId)
    },
    [replica, engine, canEdit],
  )
  return { open, canEdit }
}

/**
 * Give the freshly opened window the local row that TIES it to the server draft it came from.
 *
 * Without it the window knows nothing about `emailId`, and everything downstream keys off the local
 * row: `flushDraft` reads `serverEmailId` to send `priorServerId` (so the save REPLACES rather than
 * creates), and `discard` reads it to dispatch `discardDraft` at all. Measured against the fixture,
 * 2026-08-22, opening a draft that had no local copy — one written on another device, or here before
 * the browser data was cleared:
 *
 *  - **Discard did nothing to the server.** The window closed, the confirmation disappeared, and the
 *    draft was still in the Drafts folder. That is the reported bug.
 *  - **Close left a SECOND draft.** The save had no prior id, so the server created a new message
 *    beside the untouched original. Open-and-close a few times and the folder fills with copies of
 *    the same unfinished mail — which is what the folder in the report looked like.
 *
 * Written here rather than lazily at the first flush because both paths out of the window (save and
 * discard) need it, and one of them — discard — never flushes.
 *
 * Not fatal if it fails: the draft is open and readable, and the failure mode is the one that has
 * been shipping. The window is not torn down for a write that only affects what happens later.
 */
async function adoptServerDraft(
  db: ReplicaDb,
  accountId: Id,
  localId: string,
  serverEmailId: Id,
): Promise<void> {
  const draft = useComposerStore.getState().drafts.get(localId)
  if (draft === undefined) return
  const now = Date.now()
  try {
    await putDraft(db, {
      accountId,
      localId,
      serverEmailId,
      status: 'pending',
      content: serializeDraft(draft),
      createdAt: now,
      updatedAt: now,
      lastError: null,
    })
  } catch (error) {
    console.error('[waxwing] could not link the opened draft to its server copy', error)
  }
}
