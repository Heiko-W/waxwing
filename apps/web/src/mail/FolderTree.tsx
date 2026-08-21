/**
 * Folder tree container (M1.5). Binds {@link FolderTreeView} to the replica (liveQuery) and the
 * router, persists collapse state locally (FR-MBX-04), and owns the create/rename/delete dialogs
 * whose confirmed actions flow through the sync engine's outbox (FR-MBX-02). Rights are honored in
 * the UI: the view only offers actions a mailbox's `myRights` permit, and the delete dialog warns
 * when the folder is non-empty.
 */

import { FolderPlus, SlidersHorizontal } from 'lucide-react'
import {
  type FormEvent,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import { mailPath, useNavigate, useRoute } from '../app/route'
import { useSessionOptional } from '../app/session/context'
import { type MailboxRow, setPref, useLocalPref, useMailboxes, useReplica } from '../sync'
import { Button, Dialog, IconButton, Spinner, TextInput, useToast } from '../ui'
import { DeleteOlderDialog, EmptyFolderDialog } from './cleanup/CleanupDialogs'
import { useCleanupActions } from './cleanup/use-cleanup-actions'
import {
  canDropMailbox,
  canDropMessages,
  clearActiveDrag,
  getActiveDrag,
  setActiveDrag,
} from './dnd'
import { makeEmlImporter } from './eml-import'

const EmlImportDialog = lazy(() => import('./EmlImportDialog'))

import { FolderInfoDialog } from './FolderInfoDialog'
import { FolderManageDialog } from './FolderManageDialog'
import { FolderMoveDialog } from './FolderMoveDialog'
import { FolderTreeView } from './FolderTreeView'
import {
  isStandardFolder,
  nextSortOrder,
  orderableSiblings,
  visibleMailboxes,
} from './folder-order'
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
  | { readonly kind: 'import'; readonly mailbox: MailboxRow }
  | { readonly kind: 'info'; readonly mailbox: MailboxRow }
  | { readonly kind: 'manage' }

export interface FolderTreeProps {
  /**
   * What selecting a mailbox does. Defaults to a plain route change to that mailbox — today's, and
   * the pass-through sidebar's, behaviour. The account-grouped sidebar (M4.4) overrides it to ALSO
   * switch the active account before navigating.
   */
  readonly onSelectMailbox?: (mailboxId: string) => void
  /**
   * Whether this tree owns the current route selection (M4.4). In the account-grouped sidebar only
   * the ACTIVE account's tree highlights the open mailbox: the per-account short mailbox ids collide,
   * so without this every account's matching row would show as selected. Defaults to `true` — the
   * single tree of the pass-through sidebar always owns the selection.
   */
  readonly active?: boolean
  /**
   * Fired whenever the user picks a folder — INCLUDING the one that is already open.
   *
   * The narrow layout uses it to close the drawer. That used to be inferred in `MailScreen` from a
   * change in the selected mailbox, which is not the same question: tapping the folder you are
   * already in produces no change, so the drawer stayed open with no visible way out (no close
   * button, Escape needs a keyboard, and the backdrop is a 102 px strip beside a full-height panel).
   * A user opening the drawer to check where they are, then tapping the highlighted row, was stuck.
   */
  readonly onNavigate?: (() => void) | undefined
}

export function FolderTree({ onSelectMailbox, active = true, onNavigate }: FolderTreeProps = {}) {
  const { t } = useTranslation()
  const mailboxes = useMailboxes()
  const { db, accountId } = useReplica()
  const connected = useSessionOptional()
  // Memoized: an unmemoized importer would be a new object on every render, and the dialog holds it
  // across an async loop.
  const importer = useMemo(
    () => (connected === null ? null : makeEmlImporter(connected.client, accountId)),
    [connected, accountId],
  )
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

  /**
   * Picking a folder. Two things the bare `navigate(mailPath(id))` this replaces did not do:
   *
   *  - it pushed a history entry even when the target was the folder already open, so using the
   *    drawer to check where you are left a duplicate entry the back gesture then appeared to
   *    ignore;
   *  - it told nobody, so the drawer could only guess from the resulting state change (see
   *    {@link FolderTreeProps.onNavigate}).
   */
  const selectMailbox = useCallback(
    (id: string) => {
      if (onSelectMailbox !== undefined) onSelectMailbox(id)
      else if (id !== route.params.mailboxId) navigate(mailPath(id))
      onNavigate?.()
    },
    [onSelectMailbox, navigate, route.params.mailboxId, onNavigate],
  )

  /**
   * What the sidebar shows: everything the user has not switched off in "Manage folders" (M-5). The
   * routed folder is exempt — being inside an invisible folder is the one state hiding must not
   * produce — and `legalParents` below is deliberately given the UNFILTERED list, so a hidden
   * folder is still a legal destination for a move.
   */
  const shown = useMemo(
    () => visibleMailboxes(mailboxes ?? [], route.params.mailboxId),
    [mailboxes, route.params.mailboxId],
  )
  const tree = useMemo(() => buildFolderTree(shown), [shown])
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

  // B20.8: `null` while the liveQuery is in flight rendered NOTHING — the sidebar looked like an
  // account with no folders, and said nothing at all, while the message list beside it showed a
  // spinner. Same affordance as the list, so the two panes explain themselves the same way.
  if (mailboxes === undefined) {
    return (
      <div className={styles.loading}>
        <Spinner size="sm" label={t('shell.folders.loading')} />
      </div>
    )
  }
  if (mailboxes.length === 0) {
    return <p className={styles.empty}>{t('shell.folders.empty')}</p>
  }

  const trashMailbox = mailboxes.find((mailbox) => mailbox.role === 'trash')
  /** The names already in use beside a folder — the "name taken" check of the name dialogs. */
  const takenNames = (parentId: string | null, excludeId?: string): string[] =>
    mailboxes
      .filter((mailbox) => mailbox.parentId === parentId && mailbox.id !== excludeId)
      .map((mailbox) => mailbox.name)
  /** Is there anything here that "Manage folders" could do something to? */
  const manageable = mailboxes.some((mailbox) => !isStandardFolder(mailbox))

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <span className={styles.headerTitle}>{t('shell.folders.title')}</span>
        <span className={styles.headerActions}>
          {manageable && (
            // The "Edit" affordance of an iOS mailbox list: order and visibility, behind one quiet
            // button rather than on every row. Always present once there is a folder of one's own,
            // so a hidden folder is never more than one click from being visible again.
            <IconButton
              label={t('mailbox.actions.manage')}
              variant="ghost"
              size="sm"
              onClick={() => setDialog({ kind: 'manage' })}
            >
              <SlidersHorizontal />
            </IconButton>
          )}
          <IconButton
            label={t('mailbox.actions.newFolder')}
            variant="ghost"
            size="sm"
            onClick={() => setDialog({ kind: 'create', parentId: null })}
          >
            <FolderPlus />
          </IconButton>
        </span>
      </div>

      <FolderTreeView
        tree={tree}
        selectedMailboxId={active ? route.params.mailboxId : undefined}
        collapsed={collapsed}
        onToggleCollapse={toggleCollapse}
        onSelect={selectMailbox}
        onRequestCreate={(parentId) => setDialog({ kind: 'create', parentId })}
        onRequestRename={(mailbox) => setDialog({ kind: 'rename', mailbox })}
        onRequestMove={(mailbox) => setDialog({ kind: 'move', mailbox })}
        onRequestDelete={(mailbox) => setDialog({ kind: 'delete', mailbox })}
        onRequestImport={(mailbox) => setDialog({ kind: 'import', mailbox })}
        onRequestInfo={(mailbox) => setDialog({ kind: 'info', mailbox })}
        onRequestEmpty={(mailbox) => setDialog({ kind: 'empty', mailbox })}
        onRequestDeleteOlder={(mailbox) => setDialog({ kind: 'deleteOlder', mailbox })}
        onDragStartMailbox={(mailbox) =>
          setActiveDrag({
            kind: 'mailbox',
            accountId,
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
          if (drag?.kind === 'messages') return canDropMessages(mailbox, drag)
          if (drag?.kind === 'mailbox') return canDropMailbox(mailbox, drag)
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
          taken={takenNames(dialog.parentId)}
          onClose={() => setDialog(null)}
          onSubmit={(name) => {
            // Land at the END of a group the user has ordered by hand; `undefined` (an untouched
            // group) leaves the server's 0 and the alphabetical tie-break alone.
            actions.createChild(
              dialog.parentId,
              name,
              nextSortOrder(orderableSiblings(mailboxes, dialog.parentId)),
            )
            setDialog(null)
          }}
        />
      )}

      {dialog?.kind === 'rename' && (
        <NameDialog
          title={t('mailbox.rename.title')}
          submitLabel={t('mailbox.rename.submit')}
          initialName={dialog.mailbox.name}
          taken={takenNames(dialog.mailbox.parentId, dialog.mailbox.id)}
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

      {dialog?.kind === 'info' && (
        <FolderInfoDialog
          mailbox={dialog.mailbox}
          mailboxes={mailboxes}
          onClose={() => setDialog(null)}
          onSetRole={(role) => actions.setRole(dialog.mailbox.id, role)}
        />
      )}

      {dialog?.kind === 'manage' && (
        // The UNFILTERED list on purpose: this is the one surface a hidden folder is still on.
        <FolderManageDialog
          mailboxes={mailboxes}
          onClose={() => setDialog(null)}
          onReorder={(order) => actions.reorder(order)}
          onSetSubscribed={(id, isSubscribed) => actions.setSubscribed(id, isSubscribed)}
        />
      )}

      {dialog?.kind === 'import' && importer !== null && (
        // Lazy: restoring an archived message is a rare, deliberate act.
        <Suspense fallback={null}>
          <EmlImportDialog
            folderName={folderDisplayName(dialog.mailbox, t)}
            mailboxId={dialog.mailbox.id}
            importer={importer}
            onClose={() => setDialog(null)}
          />
        </Suspense>
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
          // `role="alert"`, as its twin in `LabelFormDialog` has: both dialogs ask for a name,
          // validate it and render the refusal in the same place, and only one of them announced
          // it. axe does not check live regions, so this stayed green while being wrong.
          <p id={errorId} role="alert" className={styles.formError}>
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
