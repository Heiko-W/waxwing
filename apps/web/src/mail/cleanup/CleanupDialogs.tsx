/**
 * Folder-cleanup confirmation dialogs (M3.2):
 *  - {@link EmptyFolderDialog} — destructive confirm for "Empty Trash/Junk", showing the current
 *    message count and a static retention caution (JMAP has no server retention policy);
 *  - {@link DeleteOlderDialog} — a day-count input (default 30) + destructive confirm for
 *    "Delete older than…".
 * Both raise intent only; the {@link FolderTree} container wires the confirmed action to the engine.
 */

import { type FormEvent, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useConfig } from '../../app/config-context'
import type { MailboxRow } from '../../sync'
import { Button, Dialog, TextInput } from '../../ui'
import styles from './cleanup.module.css'

export interface EmptyFolderDialogProps {
  readonly mailbox: MailboxRow
  readonly onClose: () => void
  readonly onConfirm: () => void
}

export function EmptyFolderDialog({ mailbox, onClose, onConfirm }: EmptyFolderDialogProps) {
  const { t } = useTranslation()
  const product = useConfig().branding.productName
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('cleanup.empty.title', { name: mailbox.name })}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('cleanup.cancel')}
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            {t('cleanup.empty.confirm')}
          </Button>
        </>
      }
    >
      <div className={styles.body}>
        <p>{t('cleanup.empty.message', { name: mailbox.name, count: mailbox.totalEmails })}</p>
        <p className={styles.retention}>{t('cleanup.empty.retention', { product })}</p>
      </div>
    </Dialog>
  )
}

export interface DeleteOlderDialogProps {
  readonly mailbox: MailboxRow
  /** `trash` moves matched messages to the Trash (recoverable); `destroy` deletes them permanently. */
  readonly mode: 'trash' | 'destroy'
  readonly onClose: () => void
  readonly onConfirm: (days: number) => void
}

const DEFAULT_DAYS = 30
/** Upper bound so an absurd value can't push `daysAgoIso` past the representable Date range. */
const MAX_DAYS = 3650

export function DeleteOlderDialog({ mailbox, mode, onClose, onConfirm }: DeleteOlderDialogProps) {
  const { t } = useTranslation()
  const product = useConfig().branding.productName
  const fieldId = useId()
  const errorId = useId()
  const formId = useId()
  const [value, setValue] = useState(String(DEFAULT_DAYS))
  const [error, setError] = useState<string | null>(null)

  const days = Number.parseInt(value, 10)
  const valid = Number.isInteger(days) && days >= 1 && days <= MAX_DAYS
  const count = valid ? days : DEFAULT_DAYS

  function submit(event: FormEvent): void {
    event.preventDefault()
    if (!valid) {
      setError(t('cleanup.older.invalid'))
      return
    }
    onConfirm(days)
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('cleanup.older.title')}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('cleanup.cancel')}
          </Button>
          <Button variant="destructive" type="submit" form={formId}>
            {t(mode === 'trash' ? 'cleanup.older.confirmTrash' : 'cleanup.older.confirmDestroy')}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className={styles.body}>
        <div className={styles.field}>
          <label htmlFor={fieldId} className={styles.fieldLabel}>
            {t('cleanup.older.daysLabel')}
          </label>
          <TextInput
            id={fieldId}
            type="number"
            min={1}
            max={MAX_DAYS}
            inputMode="numeric"
            className={styles.daysInput}
            value={value}
            invalid={error !== null}
            aria-describedby={error !== null ? errorId : undefined}
            onChange={(event) => {
              setValue(event.target.value)
              if (error !== null) setError(null)
            }}
          />
          {error !== null && (
            <p id={errorId} className={styles.error}>
              {error}
            </p>
          )}
        </div>
        <p>
          {t(mode === 'trash' ? 'cleanup.older.messageTrash' : 'cleanup.older.messageDestroy', {
            name: mailbox.name,
            count,
          })}
        </p>
        <p className={styles.retention}>
          {mode === 'trash'
            ? t('cleanup.older.noteTrash')
            : t('cleanup.older.retention', { product })}
        </p>
      </form>
    </Dialog>
  )
}
