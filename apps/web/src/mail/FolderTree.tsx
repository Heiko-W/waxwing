/**
 * Folder tree container (M1.5). Binds {@link FolderTreeView} to the replica (liveQuery) and the
 * router, persists collapse state locally (FR-MBX-04), and owns the create/rename/delete dialogs
 * whose confirmed actions flow through the sync engine's outbox (FR-MBX-02). Rights are honored in
 * the UI: the view only offers actions a mailbox's `myRights` permit, and the delete dialog warns
 * when the folder is non-empty.
 */

import { FolderPlus } from 'lucide-react'
import { type FormEvent, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { mailPath, useNavigate, useRoute } from '../app/route'
import { type MailboxRow, setPref, useLocalPref, useMailboxes, useReplica } from '../sync'
import { Button, Dialog, IconButton, TextInput } from '../ui'
import { DeleteOlderDialog, EmptyFolderDialog } from './cleanup/CleanupDialogs'
import { useCleanupActions } from './cleanup/use-cleanup-actions'
import { FolderTreeView } from './FolderTreeView'
import { buildFolderTree, folderDisplayName } from './folder-tree'
import styles from './folder-tree.module.css'
import { useFolderActions } from './use-folder-actions'

/** JMAP `maxSizeMailboxName` default (Stalwart fixture = 255); a real cap comes from the capability. */
const MAX_NAME_LENGTH = 255
const COLLAPSED_PREF = 'folders.collapsed'

type DialogState =
  | { readonly kind: 'create'; readonly parentId: string | null }
  | { readonly kind: 'rename'; readonly mailbox: MailboxRow }
  | { readonly kind: 'delete'; readonly mailbox: MailboxRow }
  | { readonly kind: 'empty'; readonly mailbox: MailboxRow }
  | { readonly kind: 'deleteOlder'; readonly mailbox: MailboxRow }

export function FolderTree() {
  const { t } = useTranslation()
  const mailboxes = useMailboxes()
  const { db, accountId } = useReplica()
  const route = useRoute()
  const navigate = useNavigate()
  const actions = useFolderActions()
  const cleanup = useCleanupActions()
  const collapsedList = useLocalPref<string[]>(COLLAPSED_PREF)

  const [dialog, setDialog] = useState<DialogState | null>(null)

  const tree = useMemo(() => buildFolderTree(mailboxes ?? []), [mailboxes])
  const collapsed = useMemo(() => new Set(collapsedList ?? []), [collapsedList])

  function toggleCollapse(id: string): void {
    const next = new Set(collapsed)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    void setPref(db, accountId, COLLAPSED_PREF, [...next])
  }

  if (mailboxes === undefined) return null
  if (mailboxes.length === 0) {
    return <p className={styles.empty}>{t('shell.folders.empty')}</p>
  }

  const trashMailbox = mailboxes.find((mailbox) => mailbox.role === 'trash')
  const siblingsOf = (parentId: string | null, excludeId?: string): MailboxRow[] =>
    mailboxes.filter((mailbox) => mailbox.parentId === parentId && mailbox.id !== excludeId)

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <span className={styles.headerTitle}>{t('shell.folders.title')}</span>
        <IconButton
          label={t('mailbox.actions.newFolder')}
          variant="ghost"
          size="sm"
          onClick={() => setDialog({ kind: 'create', parentId: null })}
        >
          <FolderPlus />
        </IconButton>
      </div>

      <FolderTreeView
        tree={tree}
        selectedMailboxId={route.params.mailboxId}
        collapsed={collapsed}
        onToggleCollapse={toggleCollapse}
        onSelect={(id) => navigate(mailPath(id))}
        onRequestCreate={(parentId) => setDialog({ kind: 'create', parentId })}
        onRequestRename={(mailbox) => setDialog({ kind: 'rename', mailbox })}
        onRequestDelete={(mailbox) => setDialog({ kind: 'delete', mailbox })}
        onRequestEmpty={(mailbox) => setDialog({ kind: 'empty', mailbox })}
        onRequestDeleteOlder={(mailbox) => setDialog({ kind: 'deleteOlder', mailbox })}
      />

      {dialog?.kind === 'create' && (
        <NameDialog
          title={
            dialog.parentId === null
              ? t('mailbox.create.title')
              : t('mailbox.create.titleChild', {
                  parent: parentLabel(mailboxes, dialog.parentId, t),
                })
          }
          submitLabel={t('mailbox.create.submit')}
          initialName=""
          taken={siblingsOf(dialog.parentId).map((mailbox) => mailbox.name)}
          onClose={() => setDialog(null)}
          onSubmit={(name) => {
            actions.createChild(dialog.parentId, name)
            setDialog(null)
          }}
        />
      )}

      {dialog?.kind === 'rename' && (
        <NameDialog
          title={t('mailbox.rename.title')}
          submitLabel={t('mailbox.rename.submit')}
          initialName={dialog.mailbox.name}
          taken={siblingsOf(dialog.mailbox.parentId, dialog.mailbox.id).map(
            (mailbox) => mailbox.name,
          )}
          onClose={() => setDialog(null)}
          onSubmit={(name) => {
            actions.rename(dialog.mailbox.id, name)
            setDialog(null)
          }}
        />
      )}

      {dialog?.kind === 'delete' && (
        <DeleteDialog
          mailbox={dialog.mailbox}
          onClose={() => setDialog(null)}
          onConfirm={() => {
            actions.remove(dialog.mailbox.id)
            setDialog(null)
          }}
        />
      )}

      {dialog?.kind === 'empty' && (
        <EmptyFolderDialog
          mailbox={dialog.mailbox}
          onClose={() => setDialog(null)}
          onConfirm={() => {
            void cleanup.emptyMailbox(dialog.mailbox.id)
            setDialog(null)
          }}
        />
      )}

      {dialog?.kind === 'deleteOlder' && (
        <DeleteOlderDialog
          mailbox={dialog.mailbox}
          mode={olderMode(dialog.mailbox, trashMailbox)}
          onClose={() => setDialog(null)}
          onConfirm={(days) => {
            const mailbox = dialog.mailbox
            if (olderMode(mailbox, trashMailbox) === 'trash' && trashMailbox) {
              void cleanup.trashOlderThan(mailbox.id, trashMailbox.id, days)
            } else {
              void cleanup.deleteOlderThan(mailbox.id, days)
            }
            setDialog(null)
          }}
        />
      )}
    </div>
  )
}

/**
 * Delete-older-than is RECOVERABLE (move to Trash) for a normal folder, but PERMANENT for Trash/Junk
 * itself (or when no Trash exists) — so a message multi-filed elsewhere is never destroyed everywhere
 * from a routine cleanup.
 */
function olderMode(mailbox: MailboxRow, trash: MailboxRow | undefined): 'trash' | 'destroy' {
  if (mailbox.role === 'trash' || mailbox.role === 'junk') return 'destroy'
  if (trash === undefined || trash.id === mailbox.id) return 'destroy'
  return 'trash'
}

/** The localized display label for a parent mailbox (role name for roles, else the server name). */
function parentLabel(
  mailboxes: MailboxRow[],
  parentId: string,
  t: (key: string) => string,
): string {
  const parent = mailboxes.find((mailbox) => mailbox.id === parentId)
  return parent ? folderDisplayName(parent, t) : ''
}

interface NameDialogProps {
  readonly title: string
  readonly submitLabel: string
  readonly initialName: string
  readonly taken: string[]
  readonly onClose: () => void
  readonly onSubmit: (name: string) => void
}

function NameDialog({
  title,
  submitLabel,
  initialName,
  taken,
  onClose,
  onSubmit,
}: NameDialogProps) {
  const { t } = useTranslation()
  const formId = useId()
  const errorId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState(initialName)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setName(initialName)
    setError(null)
  }, [initialName])

  function validate(value: string): string | null {
    const trimmed = value.trim()
    if (trimmed.length === 0) return t('mailbox.error.nameRequired')
    if (trimmed.length > MAX_NAME_LENGTH) return t('mailbox.error.nameTooLong')
    if (taken.some((existing) => existing.toLowerCase() === trimmed.toLowerCase())) {
      return t('mailbox.error.nameTaken')
    }
    return null
  }

  function submit(event: FormEvent): void {
    event.preventDefault()
    const message = validate(name)
    if (message !== null) {
      setError(message)
      return
    }
    onSubmit(name.trim())
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      size="sm"
      initialFocusRef={inputRef}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('mailbox.cancel')}
          </Button>
          <Button variant="primary" type="submit" form={formId}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className={styles.form}>
        <label htmlFor={`${formId}-input`} className={styles.formLabel}>
          {t('mailbox.create.nameLabel')}
        </label>
        <TextInput
          id={`${formId}-input`}
          ref={inputRef}
          value={name}
          maxLength={MAX_NAME_LENGTH}
          invalid={error !== null}
          aria-describedby={error !== null ? errorId : undefined}
          onChange={(event) => {
            setName(event.target.value)
            if (error !== null) setError(null)
          }}
        />
        {error !== null && (
          <p id={errorId} className={styles.formError}>
            {error}
          </p>
        )}
      </form>
    </Dialog>
  )
}

interface DeleteDialogProps {
  readonly mailbox: MailboxRow
  readonly onClose: () => void
  readonly onConfirm: () => void
}

function DeleteDialog({ mailbox, onClose, onConfirm }: DeleteDialogProps) {
  const { t } = useTranslation()
  const message =
    mailbox.totalEmails > 0
      ? t('mailbox.delete.messageNonEmpty', { name: mailbox.name, count: mailbox.totalEmails })
      : t('mailbox.delete.message', { name: mailbox.name })
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('mailbox.delete.title')}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('mailbox.cancel')}
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            {t('mailbox.delete.confirm')}
          </Button>
        </>
      }
    >
      <p>{message}</p>
    </Dialog>
  )
}
