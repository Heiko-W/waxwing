/**
 * Folder picker for "Move to…" (M1.8, FR-ORG-01). A modal list of the account's mailboxes (minus the
 * one the message is already in); choosing one dispatches the move via the caller. Reuses the design
 * system {@link Dialog}; role folders get their localized name so Inbox/Archive/… read consistently.
 */

import type { Id } from '@waxwing/jmap'
import { useTranslation } from 'react-i18next'
import { type MailboxRow, useMailboxes } from '../sync'
import { Dialog } from '../ui'
import styles from './reading.module.css'

export interface MoveDialogProps {
  readonly open: boolean
  readonly currentMailboxId: Id | null
  readonly onClose: () => void
  readonly onMove: (target: Id) => void
}

function mailboxLabel(mailbox: MailboxRow, roleName: (role: string) => string): string {
  return mailbox.role !== null ? roleName(mailbox.role) : mailbox.name
}

export function MoveDialog({ open, currentMailboxId, onClose, onMove }: MoveDialogProps) {
  const { t } = useTranslation()
  const mailboxes = useMailboxes() ?? []
  const targets = mailboxes
    .filter((mailbox) => mailbox.id !== currentMailboxId)
    .slice()
    .sort((a, b) =>
      mailboxLabel(a, (r) => t(`mailbox.role.${r}`)).localeCompare(
        mailboxLabel(b, (r) => t(`mailbox.role.${r}`)),
      ),
    )

  return (
    <Dialog open={open} onClose={onClose} title={t('reading.moveTitle')} size="sm">
      <ul className={styles.moveList}>
        {targets.map((mailbox) => (
          <li key={mailbox.id}>
            <button type="button" className={styles.moveItem} onClick={() => onMove(mailbox.id)}>
              {mailboxLabel(mailbox, (r) => t(`mailbox.role.${r}`))}
            </button>
          </li>
        ))}
        {targets.length === 0 && <li className={styles.moveEmpty}>{t('reading.moveEmpty')}</li>}
      </ul>
    </Dialog>
  )
}
