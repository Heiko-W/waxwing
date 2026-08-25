/**
 * Folder picker for "Move to…" (M1.8, FR-ORG-01). A modal list of the account's mailboxes (minus the
 * one the message is already in); choosing one dispatches the move via the caller. Reuses the design
 * system {@link Dialog}; role folders get their localized name so Inbox/Archive/… read consistently.
 *
 * Rendered in the TREE's order and indentation, with the full path in each button's accessible name
 * (B21). It used to be a flat alphabetical list of bare names, and JMAP only requires a name to be
 * unique among siblings — so `Archive › 2024` and `Projects › 2024` were two adjacent buttons both
 * reading "2024", with nothing on screen or in the accessibility tree to tell them apart. The folder
 * re-parent picker next door had already reasoned its way out of exactly this; both now share one
 * {@link folderPath}, so they cannot drift.
 */

import type { Id } from '@waxwing/jmap'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useMailboxes } from '../sync'
import { Dialog } from '../ui'
import { buildFolderTree, folderDisplayName, folderPath, visibleRows } from './folder-tree'
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

  const rows = useMemo(
    () =>
      // Build the tree from ALL mailboxes and filter the FLATTENED rows, not the input: a target
      // whose parent is not itself a legal target (an unwritable folder with a writable child) must
      // still appear, and at its true depth. `visibleRows(…, () => false)` collapses nothing.
      visibleRows(buildFolderTree(mailboxes), () => false).filter(
        (node) =>
          node.mailbox.id !== currentMailboxId &&
          // A mailbox we may not add to is not a target — offering it would dispatch a move the
          // server rejects, after the optimistic apply has already shown it as done.
          node.mailbox.myRights.mayAddItems,
      ),
    [mailboxes, currentMailboxId],
  )

  return (
    <Dialog open={open} onClose={onClose} title={t('reading.moveTitle')} size="sm">
      <ul className={styles.moveList}>
        {rows.map((node) => (
          <li key={node.mailbox.id}>
            <button
              type="button"
              className={styles.moveItem}
              aria-label={folderPath(mailboxes, node.mailbox, t)}
              style={{
                paddingInlineStart: `calc(${node.depth} * var(--waxwing-space-4) + var(--waxwing-space-3))`,
              }}
              onClick={() => onMove(node.mailbox.id, folderDisplayName(node.mailbox, t))}
            >
              {folderDisplayName(node.mailbox, t)}
            </button>
          </li>
        ))}
        {rows.length === 0 && <li className={styles.moveEmpty}>{t('reading.moveEmpty')}</li>}
      </ul>
    </Dialog>
  )
}
