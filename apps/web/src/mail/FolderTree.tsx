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
import { Button, Dialog, IconButton, TextInput, useToast } from '../ui'
import { DeleteOlderDialog, EmptyFolderDialog } from './cleanup/CleanupDialogs'
import { useCleanupActions } from './cleanup/use-cleanup-actions'
import { canDropMessages, clearActiveDrag, getActiveDrag, setActiveDrag } from './dnd'
import { FolderMoveDialog } from './FolderMoveDialog'
import { FolderTreeView } from './FolderTreeView'
import { buildFolderTree, folderDisplayName, legalParents } from './folder-tree'
import styles from './folder-tree.module.css'
import { useListStore } from './list-store'
import { usePinActions, usePinnedMailboxes } from './pinned/use-pinned-folders'
import { useFolderActions } from './use-folder-actions'
import { useMoveLimits } from './use-move-limits'
import { useTriage } from './use-triage'

/** JMAP `maxSizeMailboxName` default (Stalwart fixture = 255); a real cap comes from the capability. */
const MAX_NAME_LENGTH = 255
const COLLAPSED_PREF = 'folders.collapsed'
/** Stable empty set for the first render, before the pins liveQuery resolves (no re-render churn). */
const EMPTY_PINS: ReadonlySet<string> = new Set()

type DialogState =
  | { readonly kind: 'create'; readonly parentId: string | null }
  | { readonly kind: 'rename'; readonly mailbox: MailboxRow }
  | { readonly kind: 'move'; readonly mailbox: MailboxRow }
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
  const pinned = usePinnedMailboxes()
  const pins = usePinActions()
  // Drop targets (M3.9 5b): a message drop routes through the SAME triage seam the `v` chord and the
  // bulk bar use, so it inherits the "Moved to …" Undo toast; a folder drop calls `actions.move`.
  const triage = useTriage()
  const clearSelection = useListStore((state) => state.select)
  const limits = useMoveLimits()
  const { toast } = useToast()

  const [dialog, setDialog] = useState<DialogState | null>(null)

  const tree = useMemo(() => buildFolderTree(mailboxes ?? []), [mailboxes])
  const collapsed = useMemo(() => new Set(collapsedList ?? []), [collapsedList])

  function toggleCollapse(id: string): void {
    const next = new Set(collapsed)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    void setPref(db, accountId, COLLAPSED_PREF, [...next])
  }

  /**
   * Start a cleanup and make sure the user hears about it if it does not happen.
   *
   * Every OTHER destructive action in this tree (create/rename/move/delete, and a message drop) is
   * outbox-backed: it is enqueued locally first, so it survives being offline and a server refusal
   * lands in the dead-letter queue that `use-outbox-problems.ts` surfaces. Cleanup does not get that
   * for free. `Engine.destroyMatching`/`moveMatching` must page the matching ids with a live
   * `Email/query` (`collectMatchingIds`) BEFORE they enqueue anything, so the network is reached
   * ahead of the outbox: offline, or on any server error, the promise rejects with nothing queued
   * and nothing for that surface to report. These handlers fired it floating (`void …`), which meant
   * the confirm dialog closed and the user was left believing a folder had been emptied.
   *
   * `undefined` — `useCleanupActions` returns it when no engine is running — is the same outcome
   * from the user's side and is reported identically.
   *
   * What this does NOT do is queue the cleanup for retry, and the wording is chosen to match: it
   * says the action did not go through, and does not claim nothing was changed. A large purge is
   * enqueued in `maxObjectsInSet` chunks, so a failure part-way through the dispatch loop can leave
   * earlier chunks already queued. Making the whole cleanup path outbox-backed (so an offline
   * "Empty Trash" replays on reconnect) is a sync-engine change; it is filed, not smuggled in here.
   */
  function runCleanup(name: string, started: Promise<unknown> | undefined): void {
    const report = (): void => {
      toast({
        title: t('cleanup.failed.title', { name }),
        description: t('cleanup.failed.body'),
        tone: 'danger',
      })
    }
    if (started === undefined) {
      report()
      return
    }
    void started.catch(report)
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
        onRequestMove={(mailbox) => setDialog({ kind: 'move', mailbox })}
        onRequestDelete={(mailbox) => setDialog({ kind: 'delete', mailbox })}
        onRequestEmpty={(mailbox) => setDialog({ kind: 'empty', mailbox })}
        onRequestDeleteOlder={(mailbox) => setDialog({ kind: 'deleteOlder', mailbox })}
        onDragStartMailbox={(mailbox) =>
          setActiveDrag({
            kind: 'mailbox',
            id: mailbox.id,
            // Compute the legal parents ONCE at dragstart — `legalParents` runs `buildFolderTree`
            // per candidate, and `dragover` fires continuously. `null` (top level) is dropped: the
            // tree has no node to drop onto for it, and the picker owns that target.
            legal: new Set(
              legalParents(mailboxes, mailbox.id, limits).filter((p): p is string => p !== null),
            ),
          })
        }
        canDropOn={(mailbox) => {
          const drag = getActiveDrag()
          if (drag?.kind === 'messages') return canDropMessages(mailbox, drag.from)
          if (drag?.kind === 'mailbox') return drag.legal.has(mailbox.id)
          return false
        }}
        onDropOn={(mailbox) => {
          const drag = getActiveDrag()
          if (drag?.kind === 'messages') {
            triage.moveTo([...drag.ids], drag.from, mailbox.id, folderDisplayName(mailbox, t))
            // The tree does not go through MessageList's move path, so it must clear the selection
            // itself — otherwise a follow-up action runs against a stale `from`.
            clearSelection({ type: 'clear' })
          } else if (drag?.kind === 'mailbox') {
            actions.move(drag.id, mailbox.id)
          }
          clearActiveDrag()
        }}
        pinned={pinned ?? EMPTY_PINS}
        onTogglePin={(mailbox) => pins.toggle(mailbox.id)}
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

      {dialog?.kind === 'move' && (
        <FolderMoveDialog
          mailbox={dialog.mailbox}
          onClose={() => setDialog(null)}
          onMove={(parentId) => {
            actions.move(dialog.mailbox.id, parentId)
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
            runCleanup(dialog.mailbox.name, cleanup.emptyMailbox(dialog.mailbox.id))
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
            runCleanup(
              mailbox.name,
              olderMode(mailbox, trashMailbox) === 'trash' && trashMailbox
                ? cleanup.trashOlderThan(mailbox.id, trashMailbox.id, days)
                : cleanup.deleteOlderThan(mailbox.id, days),
            )
            setDialog(null)
          }}
        />
      )}
    </div>
  )
}

/**
 * Which arm "Delete older than…" takes. RECOVERABLE (move to Trash) for a normal folder — so a
 * message multi-filed elsewhere is not destroyed everywhere by a routine cleanup — and PERMANENT in
 * the two PURGE folders, Trash and Junk, or when there is no Trash to move to.
 *
 * The junk term is the one that looks arbitrary, so: it is not this function's invention. FR-ORG-04
 * names "Empty-trash / empty-junk" as a single feature, `FolderTreeView` puts one Empty entry on
 * BOTH purge roles and picks its label by role ("Empty Trash" / "Empty Junk") — an unconditional
 * destroy either way, with no recoverable arm to pick — and `Engine.deleteOlderThan` is documented
 * "for Trash/Junk cleanup". A recoverable arm here would put this menu entry at odds with the entry
 * directly above it in the same menu.
 *
 * The reach of that argument is exactly the folder-purge family and stops there. It is NOT a general
 * rule that "Junk destroys": `MessageList`'s bulk bar, `MessageView`'s action bar and the `#` chord
 * all resolve their own `inTrash` against the trash role ALONE, so a hand-picked delete in Junk is a
 * recoverable move on all three. An earlier revision of the bulk bar's comment cited THIS function
 * as its authority; it never granted that. Both sides are pinned by tests that name the rule — here
 * "destroys permanently from Junk even though a Trash exists to move to", and in
 * `MessageList.test.tsx` "offers the recoverable move in Junk, not the permanent destroy" — so a
 * future editor cannot flip one and leave the other.
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
