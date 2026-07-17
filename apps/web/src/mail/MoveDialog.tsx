/**
 * Folder picker for "Move to…" (M1.8, FR-ORG-01). A modal list of the account's mailboxes (minus the
 * one the message is already in); choosing one dispatches the move via the caller. Reuses the design
 * system {@link Dialog}; role folders get their localized name so Inbox/Archive/… read consistently.
 */

import type { Id } from '@waxwing/jmap'
import { useTranslation } from 'react-i18next'
import { useMailboxes } from '../sync'
import { Dialog } from '../ui'
import { folderDisplayName } from './folder-tree'
import styles from './reading.module.css'

export interface MoveDialogProps {
  readonly open: boolean
  readonly currentMailboxId: Id | null
  readonly onClose: () => void
  /** Hands the target's LABEL up with its id — the caller names it in the Undo toast and cannot
   *  re-derive it (a role folder shows a localized name, not the server's `name`). */
  readonly onMove: (target: Id, label: string) => void
}

export function MoveDialog({ open, currentMailboxId, onClose, onMove }: MoveDialogProps) {
  const { t } = useTranslation()
  const mailboxes = useMailboxes() ?? []
  const targets = mailboxes
    // A mailbox we may not add to is not a target — offering it would dispatch a move the server
    // rejects, after the optimistic apply has already shown it as done.
    .filter((mailbox) => mailbox.id !== currentMailboxId && mailbox.myRights.mayAddItems)
    .slice()
    .sort((a, b) => folderDisplayName(a, t).localeCompare(folderDisplayName(b, t)))

  return (
    <Dialog open={open} onClose={onClose} title={t('reading.moveTitle')} size="sm">
      <ul className={styles.moveList}>
        {targets.map((mailbox) => (
          <li key={mailbox.id}>
            <button
              type="button"
              className={styles.moveItem}
              onClick={() => onMove(mailbox.id, folderDisplayName(mailbox, t))}
            >
              {folderDisplayName(mailbox, t)}
            </button>
          </li>
        ))}
        {targets.length === 0 && <li className={styles.moveEmpty}>{t('reading.moveEmpty')}</li>}
      </ul>
    </Dialog>
  )
}
