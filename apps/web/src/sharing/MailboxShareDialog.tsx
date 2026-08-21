/**
 * Sharing one mail folder (S-3) — the `Mailbox` binding of {@link ShareDialog}.
 *
 * The whole of this file is the LOAD. `Mailbox/get` omits `shareWith` unless it is named in
 * `properties` (measured, v0.16.18), so unlike a file node — whose `shareWith` arrives with the node
 * the screen already has — a folder's grant map is not on hand when the dialog opens. It has to be
 * fetched, and until it arrives there is nothing safe to render: a dialog that opened on `{}` would
 * show "Only you" over a folder three people can read, and the first edit made from that view would
 * write the `{}` back and revoke all three.
 *
 * The wait lives INSIDE the dialog rather than around it — one `<Dialog>` mounted once, its body
 * swapped. Rendering a separate loading dialog and replacing it on arrival unmounts a focus trap,
 * and `useFocusTrap` restores focus to the opener when it goes: the user's focus jumped back to the
 * folder menu the moment the fetch returned.
 */

import type { Id, MailboxRights } from '@waxwing/jmap'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MailboxShareWith } from './mailbox'
import { mailboxRoles } from './mailbox'
import type { MailboxSharingClient } from './mailbox-client'
import { ShareDialog, type ShareLoadState, type SharingClient } from './ShareDialog'

export interface MailboxShareDialogProps {
  readonly mailboxId: Id
  /** The folder's display name — role-translated by the caller, which owns that vocabulary. */
  readonly name: string
  readonly client: MailboxSharingClient
  onClose: () => void
}

const NOTHING: MailboxShareWith = {}

export function MailboxShareDialog({ mailboxId, name, client, onClose }: MailboxShareDialogProps) {
  const { t } = useTranslation()
  const [state, setState] = useState<ShareLoadState>('loading')
  const [shareWith, setShareWith] = useState<MailboxShareWith>(NOTHING)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const loaded = await client.load(mailboxId)
        if (cancelled) return
        setShareWith(loaded)
        setState('ready')
      } catch {
        if (!cancelled) setState('failed')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [client, mailboxId])

  const setShare = useCallback(
    (next: Record<Id, MailboxRights>) => client.setShareWith(mailboxId, next),
    [client, mailboxId],
  )
  // Memoized: the generic dialog holds this in a `useEffect` dependency list, so a fresh object per
  // render would re-run the principal search on every keystroke.
  const sharing = useMemo<SharingClient<MailboxRights>>(
    () => ({ searchPrincipals: (query) => client.searchPrincipals(query), setShareWith: setShare }),
    [client, setShare],
  )

  return (
    <ShareDialog
      title={t('sharing.mailbox.title', { name })}
      kind="mailbox"
      roles={mailboxRoles}
      shareWith={shareWith}
      client={sharing}
      state={state}
      loadFailedMessage={t('sharing.mailbox.loadFailed')}
      onClose={onClose}
      // Nothing behind this dialog reads `shareWith` — the sidebar shows folders, not grants — so
      // there is no list to refresh. The engine's own sync will pick the mailbox change up; a forced
      // resync here would buy nothing visible and spend a round trip per edit.
      onChanged={() => {}}
    />
  )
}

export default MailboxShareDialog
