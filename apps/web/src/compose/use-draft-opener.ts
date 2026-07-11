/**
 * Open a Drafts-mailbox message back into the composer (M2.6, FR-CMP-03). Prefers the full-fidelity
 * LOCAL copy (keeps `bcc` and reopens under the SAME localId, so autosave keeps coalescing onto the
 * same server draft); falls back to the server envelope + fetched body for a draft created elsewhere
 * (loses `bcc` — it isn't on the envelope). Reads the running engine lazily (safe before it starts).
 */

import type { Id } from '@waxwing/jmap'
import { useCallback } from 'react'
import { pickHtmlBody } from '../mail/message-body'
import { getDraftByServerId, useReplicaOptional } from '../sync'
import { useActiveEngine } from '../sync/engine'
import { useComposerStore } from './composer-store'
import { deserializeDraft, toDraftInit } from './draft-email'

export interface DraftOpener {
  /** Open the Drafts message `emailId` in the composer (local copy if we have one; else the server body). */
  open(emailId: Id): Promise<void>
}

export function useDraftOpener(): DraftOpener {
  const replica = useReplicaOptional()
  const engine = useActiveEngine()
  const open = useCallback(
    async (emailId: Id): Promise<void> => {
      if (replica === null) return
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
      openDraft(toDraftInit(email, bodyHtml))
    },
    [replica, engine],
  )
  return { open }
}
