/**
 * Folder info — and the one thing in it that matters (JMAP gap analysis M-6): what this folder is
 * FOR.
 *
 * A folder Waxwing creates has no `role`, and without one no other client recognises it. A folder
 * called "Archiv" is, to the phone and to Thunderbird, just a folder called "Archiv": the Archive
 * button files elsewhere, and the two clients disagree about where archived mail lives. Setting the
 * role is what makes the answer travel.
 *
 * ## Why it is here and not in the row's menu
 *
 * "Role" is protocol vocabulary, and a menu of protocol vocabulary hanging off every folder in the
 * sidebar would put a rarely-wanted, consequential setting one slip away at all times. Apple Mail
 * keeps the same decision behind Get Info and phrases it as a sentence — *use this mailbox as* —
 * and that is what this dialog is. The list's menu carries one quiet entry that opens it, offered
 * only where there is something to change: a folder the user owns and may rename.
 *
 * ## What is offered
 *
 * {@link assignableRoles} — measured against the live server, not taken from the IANA registry, and
 * minus whatever is already spoken for in this account. Both halves are load-bearing: this Stalwart
 * refuses `templates` outright, and refuses any role a second folder already holds. Offering either
 * would produce a dead-letter conflict for a setting the user could not have known was impossible.
 */

import { type FormEvent, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MailboxRow } from '../sync'
import { Button, Dialog, Select } from '../ui'
import { assignableRoles } from './folder-order'
import { folderDisplayName } from './folder-tree'
import styles from './folder-tree.module.css'

export interface FolderInfoDialogProps {
  readonly mailbox: MailboxRow
  /** Every folder of the account — the roles already taken come from here. */
  readonly mailboxes: readonly MailboxRow[]
  readonly onClose: () => void
  /** `null` turns the folder back into an ordinary one. */
  readonly onSetRole: (role: string | null) => void
}

/** The `<option>` value standing for "no role"; `""` because a `<select>` value is always a string. */
const NO_ROLE = ''

export function FolderInfoDialog({
  mailbox,
  mailboxes,
  onClose,
  onSetRole,
}: FolderInfoDialogProps) {
  const { t } = useTranslation()
  const formId = useId()
  const selectId = useId()
  const hintId = useId()
  const [role, setRole] = useState<string>(mailbox.role ?? NO_ROLE)

  const options = assignableRoles(mailboxes, mailbox.id)

  function submit(event: FormEvent): void {
    event.preventDefault()
    const next = role === NO_ROLE ? null : role
    if (next !== mailbox.role) onSetRole(next)
    onClose()
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('mailbox.info.title', { name: folderDisplayName(mailbox, t) })}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('mailbox.cancel')}
          </Button>
          <Button variant="primary" type="submit" form={formId}>
            {t('mailbox.info.submit')}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className={styles.form}>
        <label htmlFor={selectId} className={styles.formLabel}>
          {t('mailbox.info.useAs')}
        </label>
        <Select
          id={selectId}
          value={role}
          aria-describedby={hintId}
          onChange={(event) => setRole(event.target.value)}
        >
          <option value={NO_ROLE}>{t('mailbox.info.useAsNone')}</option>
          {options.map((option) => (
            <option key={option} value={option}>
              {t(`mailbox.role.${option}`)}
            </option>
          ))}
        </Select>
        <p id={hintId} className={styles.formHint}>
          {t('mailbox.info.useAsHint')}
        </p>
      </form>
    </Dialog>
  )
}
