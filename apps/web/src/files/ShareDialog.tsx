/**
 * Sharing one file or folder (M5.18, RFC 9670) — the FileNode binding of `../sharing/ShareDialog`.
 *
 * The surface itself moved when mail folders needed the same two lists over a different set of
 * rights (S-3). What is left here is the three things that are genuinely about files: the title,
 * the FileNode role vocabulary, and a `setShareWith` with the node id closed over. The generic
 * dialog never learns which id it is writing to, which is the seam that lets a mailbox use it.
 */

import type { FileNode, FileNodeRights, Id } from '@waxwing/jmap'
import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ShareDialog as GenericShareDialog, type SharingClient } from '../sharing/ShareDialog'
import type { FilesClient } from './files-client'
import { fileRoles } from './sharing'

export interface ShareDialogProps {
  readonly node: FileNode
  readonly client: FilesClient
  onClose: () => void
  /** Called after every successful write, so the list behind the dialog stays true. */
  onChanged: () => void
}

export function ShareDialog({ node, client, onClose, onChanged }: ShareDialogProps) {
  const { t } = useTranslation()
  const setShareWith = useCallback(
    (shareWith: Record<Id, FileNodeRights>) => client.setShareWith(node.id, shareWith),
    [client, node.id],
  )
  // Memoized: the generic dialog holds this in a `useEffect` dependency list, so a fresh object per
  // render would re-run the principal search on every keystroke.
  const sharing = useMemo<SharingClient<FileNodeRights>>(
    () => ({ searchPrincipals: (query) => client.searchPrincipals(query), setShareWith }),
    [client, setShareWith],
  )

  return (
    <GenericShareDialog
      title={t('files.share.title', { name: node.name })}
      kind="file"
      roles={fileRoles}
      shareWith={node.shareWith ?? {}}
      client={sharing}
      onClose={onClose}
      onChanged={onChanged}
    />
  )
}

export default ShareDialog
