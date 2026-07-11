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
  getDraft,
  mailboxByRole,
  putDraft,
  type ReplicaDb,
  useReplicaOptional,
} from '../sync'
import { getActiveEngine } from '../sync/engine'
import { useComposerStore } from './composer-store'
import { isEmptyDraft, serializeDraft, toEmailCreate } from './draft-email'
import { revokeInlineObjectUrls } from './inline-image-registry'

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
}

const outboxId = (localId: string): string => `draft:${localId}`

async function resolveFrom(
  db: ReplicaDb,
  accountId: Id,
  fromIdentityId: string | null,
): Promise<EmailAddress | null> {
  if (fromIdentityId === null) return null
  const identity = await db.identities.get([accountId, fromIdentityId])
  return identity ? { name: identity.name, email: identity.email } : null
}

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
  void getActiveEngine()?.dispatch(
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
      }
    }
    const { db, accountId } = replica
    return {
      flush: (localId) => flushDraft(db, accountId, localId),
      close: async (localId) => {
        await flushDraft(db, accountId, localId)
        closeWindow(localId)
      },
      discard: async (localId) => {
        const row = await getDraft(db, accountId, localId)
        await deleteDraft(db, accountId, localId)
        if (row?.serverEmailId != null) {
          void getActiveEngine()?.dispatch(
            { kind: 'discardDraft', localId, serverEmailId: row.serverEmailId },
            { id: outboxId(localId) },
          )
        }
        revokeDraftInlineImages(localId)
        closeWindow(localId)
      },
    }
  }, [replica])
}
