/**
 * Live send-failure surfacing (M2.8, FR-CMP-07). A send is dispatched with the composer already
 * closed and the "Sending…" toast auto-dismissing after the undo grace — so a submission REJECTED
 * after the grace (bad recipient, over quota, too large, auth) would otherwise be invisible until
 * the next page reload. This hook subscribes to the local `drafts` store and, the moment a draft is
 * stamped `status:'error'` by the SEND pipeline (`errorKind:'send'`), raises a danger toast (mapping
 * the JMAP `SetError` type to a specific message) and reopens the draft docked so the user can fix
 * and resend. Autosave failures (`errorKind:'save'`) are intentionally NOT surfaced here — the local
 * copy is safe and the save retries. Mounted once in the connected shell, next to
 * {@link useDraftRestore}.
 */

import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { listDrafts, useReplicaQuery } from '../sync'
import { useToast } from '../ui'
import { useComposerStore } from './composer-store'
import { deserializeDraft } from './draft-email'

/** Map a stored `SetError` type / error message to the most specific send-failure message key. */
function sendErrorKey(lastError: string | null): string {
  const error = (lastError ?? '').toLowerCase()
  if (/quota/.test(error)) return 'compose.sendErrorQuota'
  if (/toolarge|maxsize|toobig/.test(error)) return 'compose.sendErrorSize'
  if (/recipient|invalidemail|forbiddenfrom|forbiddenmailfrom|forbiddento|mailfrom/.test(error)) {
    return 'compose.sendErrorRecipient'
  }
  return 'compose.sendErrorGeneric'
}

export function useSendErrorNotifier(): void {
  const { t } = useTranslation()
  const { toast } = useToast()
  const drafts = useReplicaQuery(({ db, accountId }) => listDrafts(db, accountId))
  // Dedup by (localId → updatedAt): each send attempt bumps `updatedAt`, so a re-send that fails
  // again re-surfaces, but a steady `error` row (repeated liveQuery emissions) surfaces only once.
  const surfaced = useRef<Map<string, number>>(new Map())

  useEffect(() => {
    if (drafts === undefined) return
    const openDraft = useComposerStore.getState().openDraft
    for (const row of drafts) {
      if (row.status !== 'error' || row.errorKind !== 'send') continue
      if (surfaced.current.get(row.localId) === row.updatedAt) continue
      surfaced.current.set(row.localId, row.updatedAt)
      const key = sendErrorKey(row.lastError)
      toast({
        tone: 'danger',
        title:
          key === 'compose.sendErrorRecipient' ? t(key, { detail: row.lastError ?? '' }) : t(key),
      })
      openDraft({ ...deserializeDraft(row), mode: 'docked' })
    }
  }, [drafts, t, toast])
}
