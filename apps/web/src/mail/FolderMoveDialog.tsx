/**
 * Parent picker for re-parenting a folder (M3.9, FR-MBX-03) — and the FIRST caller `moveMailbox`
 * has ever had. The intent has been implemented, optimistic and state-guarded since M1.5 with no
 * way to reach it: the tree offered create/rename/delete and nothing else, so a folder's place in
 * the hierarchy was fixed at creation.
 *
 * Deliberately not a variant of {@link MoveDialog}: that one moves MESSAGES and its `onMove` cannot
 * express "top level", which is exactly the target a re-parent needs most.
 *
 * Every legality rule lives in {@link legalParents}, not here — this component only renders what it
 * returns. `moveMailbox` patches `parentId` optimistically and unconditionally, so an illegal move
 * would look like it worked and only come back as an `invalid` conflict a round-trip later.
 */

import type { Id } from '@waxwing/jmap'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { type MailboxRow, useMailboxes } from '../sync'
import { Dialog } from '../ui'
import { buildFolderTree, folderDisplayName, legalParents, visibleRows } from './folder-tree'
import styles from './reading.module.css'
import { useMoveLimits } from './use-move-limits'

export interface FolderMoveDialogProps {
  readonly mailbox: MailboxRow
  readonly onClose: () => void
  readonly onMove: (parentId: Id | null) => void
}

export function FolderMoveDialog({ mailbox, onClose, onMove }: FolderMoveDialogProps) {
  const { t } = useTranslation()
  const mailboxes = useMailboxes() ?? []
  // Same limits the drag uses — one source, so the two cannot disagree about what is legal.
  const limits = useMoveLimits()

  const legal = useMemo(
    () => new Set(legalParents(mailboxes, mailbox.id, limits)),
    [mailboxes, mailbox.id, limits],
  )
  // Render in the tree's own order and indentation, so the picker reads like the tree it edits.
  const rows = useMemo(
    () =>
      visibleRows(buildFolderTree(mailboxes), () => false).filter((n) => legal.has(n.mailbox.id)),
    [mailboxes, legal],
  )

  /**
   * The full path of a target — `Archive › 2024`, not just `2024`.
   *
   * The indentation carries the hierarchy for a sighted user, but CSS padding is not a structure
   * anyone can query (WCAG 1.3.1). JMAP only requires names to be unique among SIBLINGS, so
   * `Archive › 2024` and `Projects › 2024` both render as a button reading "2024": a screen reader
   * would announce two identical targets and a re-parent, unlike a message move, has no Undo. The
   * path goes in the accessible NAME (it contains the visible label, so SC 2.5.3 still holds) and
   * the visible row stays short.
   */
  const pathOf = useMemo(() => {
    const index = new Map(mailboxes.map((m) => [m.id, m]))
    return (target: MailboxRow): string => {
      const parts: string[] = []
      const seen = new Set<string>()
      let current: MailboxRow | undefined = target
      while (current !== undefined && !seen.has(current.id)) {
        seen.add(current.id) // a replica mid-sync may briefly hold a parentId cycle
        parts.unshift(folderDisplayName(current, t))
        current = current.parentId !== null ? index.get(current.parentId) : undefined
      }
      return parts.join(' › ')
    }
  }, [mailboxes, t])

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('mailbox.move.title', { name: folderDisplayName(mailbox, t) })}
      size="sm"
    >
      <ul className={styles.moveList}>
        {legal.has(null) && (
          <li>
            <button type="button" className={styles.moveItem} onClick={() => onMove(null)}>
              {t('mailbox.move.topLevel')}
            </button>
          </li>
        )}
        {rows.map((node) => (
          // No `aria-level` here: the path in the button's NAME is what carries the hierarchy, and a
          // level alone would not help — two same-named folders would both announce as "2024, level
          // 2". (It is also not a property a plain `li` may take.) `rows` is filtered besides, so any
          // posinset/setsize taken from the tree would be a lie.
          <li key={node.mailbox.id}>
            <button
              type="button"
              className={styles.moveItem}
              aria-label={pathOf(node.mailbox)}
              style={{
                paddingInlineStart: `calc(${node.depth} * var(--waxwing-space-4) + var(--waxwing-space-3))`,
              }}
              onClick={() => onMove(node.mailbox.id)}
            >
              {folderDisplayName(node.mailbox, t)}
            </button>
          </li>
        ))}
        {legal.size === 0 && <li className={styles.moveEmpty}>{t('mailbox.move.empty')}</li>}
      </ul>
    </Dialog>
  )
}
