/**
 * "Manage folders" — the sidebar in edit mode (JMAP gap analysis M-5).
 *
 * Two server-stored properties that Waxwing kept to itself until now live here, and they live
 * TOGETHER because that is where the user already expects them: iOS Mail's mailbox list has one
 * "Edit" affordance behind which both the grabbers and the show/hide ticks appear. Putting either
 * of them on the row of the tree itself would have meant a permanent grabber in a 28 px navigation
 * row and a second meaning for a drag that already means "re-file this folder" (ADR-012).
 *
 * - **Order** (`sortOrder`). Dragged with pointer events, exactly as ADR-026 does it for the filter
 *   rules — same grabber, same `touch-action: none`, same 4 px slop, same window listeners, and the
 *   same keyboard path that is a peer rather than a courtesy (Space picks up, arrows move, Space
 *   drops, Escape puts back). A folder only ever moves among ITS OWN siblings: `sortOrder` is a
 *   hint among siblings, and moving it elsewhere is a re-parent, which the tree already offers.
 * - **Visibility** (`isSubscribed`). JMAP's own "do not show me this folder", which the phone and
 *   Thunderbird respect too. This list is the reason hiding is not a trap: it shows EVERY folder,
 *   hidden ones included, so nothing can become unfindable by being switched off here.
 *
 * The standard folders (Inbox, Drafts, Sent, Archive, Junk, Trash) carry neither control. They are
 * pinned to the top of the tree by role, so an order on them would be written and then ignored, and
 * RFC 8621 §2 says they should stay subscribed.
 */

import { GripVertical } from 'lucide-react'
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import type { MailboxRow } from '../sync'
import { Button, Dialog, IconButton, Switch, VisuallyHidden } from '../ui'
import {
  changedSortOrders,
  dropIndex,
  isStandardFolder,
  orderableSiblings,
  reorderSiblings,
} from './folder-order'
import { buildFolderTree, folderDisplayName, visibleRows } from './folder-tree'
import styles from './folder-tree.module.css'

/**
 * How far a pointer must travel before a press on the grabber counts as a drag. Without it a plain
 * click reorders: the drop index is a real index on the very first `pointermove`, and a mouse moves
 * a pixel or two between press and release. (ADR-026, same number and same reason.)
 */
const DRAG_SLOP_PX = 4

export interface FolderManageDialogProps {
  /** EVERY folder of the account, hidden ones included — that is what makes this list safe. */
  readonly mailboxes: readonly MailboxRow[]
  readonly onClose: () => void
  /** Called once, on drop, with only the `sortOrder` values that actually changed. */
  readonly onReorder: (
    order: ReadonlyArray<{ readonly id: string; readonly sortOrder: number }>,
  ) => void
  readonly onSetSubscribed: (id: string, isSubscribed: boolean) => void
}

export function FolderManageDialog({
  mailboxes,
  onClose,
  onReorder,
  onSetSubscribed,
}: FolderManageDialogProps) {
  const { t } = useTranslation()
  const instructionsId = useId()

  /** The order being shown while a reorder is in flight; `null` = whatever the replica says. */
  const [draft, setDraft] = useState<readonly MailboxRow[] | null>(null)
  /** The folder picked up from the keyboard, if any. */
  const [lifted, setLifted] = useState<string | null>(null)
  /** The folder under a finger or a mouse button, if any. */
  const [dragging, setDragging] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState('')

  const rowRefs = useRef(new Map<string, HTMLLIElement>())
  /** The listeners on `window` cannot read React state, so the live order is mirrored here. */
  const liveDraft = useRef<readonly MailboxRow[]>([])

  const current = draft ?? mailboxes
  // Everything expanded: a folder must not be unreachable here because its parent is collapsed in
  // the tree behind the dialog.
  const rows = useMemo(() => visibleRows(buildFolderTree([...current]), () => false), [current])

  const announce = useCallback(
    (order: readonly MailboxRow[], mailbox: MailboxRow) => {
      const siblings = orderableSiblings(order, mailbox.parentId)
      const index = siblings.findIndex((sibling) => sibling.id === mailbox.id)
      if (index === -1) return
      setAnnouncement(
        t('mailbox.manage.movedTo', {
          name: folderDisplayName(mailbox, t),
          position: index + 1,
          count: siblings.length,
        }),
      )
    },
    [t],
  )

  /** Ends a reorder, writing it only when it changed something. */
  const commit = useCallback(
    (next: readonly MailboxRow[] | null) => {
      setDraft(null)
      setLifted(null)
      setDragging(null)
      if (next === null) return
      const changed = changedSortOrders(mailboxes, next)
      if (changed.length > 0) onReorder(changed)
    },
    [mailboxes, onReorder],
  )

  /**
   * Escape, while a folder is held from the keyboard, puts it back — and must NOT also close the
   * dialog.
   *
   * On `window`, in the CAPTURE phase, and nowhere else. `Dialog` dismisses through `useDismiss`,
   * which listens on `document` in the capture phase; anything later in the flow — a React handler
   * on the grabber, `stopPropagation` included — runs after the dialog has already decided to
   * close. `window` is the one position ahead of it in the propagation path.
   */
  useEffect(() => {
    if (lifted === null) return
    const held = current.find((mailbox) => mailbox.id === lifted)
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      // Nothing has been written, so the props ARE still the saved order: dropping the draft is the
      // whole rollback.
      commit(null)
      if (held !== undefined) {
        setAnnouncement(t('mailbox.manage.dropCanceled', { name: folderDisplayName(held, t) }))
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [lifted, current, commit, t])

  const move = useCallback(
    (mailbox: MailboxRow, delta: number) => {
      const siblings = orderableSiblings(current, mailbox.parentId)
      const from = siblings.findIndex((sibling) => sibling.id === mailbox.id)
      if (from === -1) return
      const next = reorderSiblings(current, mailbox.id, from + delta)
      if (next === current) return
      liveDraft.current = next
      setDraft(next)
      announce(next, mailbox)
    },
    [current, announce],
  )

  function onHandleKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, mailbox: MailboxRow) {
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault()
      if (lifted === mailbox.id) {
        commit(draft)
        setAnnouncement(t('mailbox.manage.dropped', { name: folderDisplayName(mailbox, t) }))
        return
      }
      liveDraft.current = current
      setDraft(current)
      setLifted(mailbox.id)
      announce(current, mailbox)
      return
    }
    if (lifted !== mailbox.id) return
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault()
      move(mailbox, event.key === 'ArrowUp' ? -1 : 1)
    }
  }

  function onHandlePointerDown(event: ReactPointerEvent<HTMLButtonElement>, mailbox: MailboxRow) {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    // Stops the browser turning the press into a text selection; `touch-action: none` on the
    // grabber does the compositor half, which `preventDefault` cannot reach once the gesture has
    // been claimed as a scroll.
    event.preventDefault()

    const startY = event.clientY
    liveDraft.current = current
    setDraft(current)
    setDragging(mailbox.id)
    let moved = false

    const onMove = (moveEvent: globalThis.PointerEvent) => {
      if (!moved && Math.abs(moveEvent.clientY - startY) < DRAG_SLOP_PX) return
      moved = true
      const order = liveDraft.current
      // Only the SIBLINGS' rows are measured: those are the only positions this folder can take.
      const siblings = orderableSiblings(order, mailbox.parentId)
      const midpoints = siblings.map((sibling) => {
        const element = rowRefs.current.get(sibling.id)
        if (element === undefined) return Number.POSITIVE_INFINITY
        const rect = element.getBoundingClientRect()
        return rect.top + rect.height / 2
      })
      const next = reorderSiblings(order, mailbox.id, dropIndex(midpoints, moveEvent.clientY))
      if (next === order) return
      liveDraft.current = next
      setDraft(next)
      announce(next, mailbox)
    }
    const detach = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
    }
    const onUp = () => {
      detach()
      commit(moved ? liveDraft.current : null)
    }
    // A `pointercancel` is the browser taking the gesture. Treat it as "abandon", the way the row
    // swipe does (ADR-013) — a half-finished reorder must not be saved.
    const onCancel = () => {
      detach()
      commit(null)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('mailbox.manage.title')}
      size="md"
      footer={
        <Button variant="primary" onClick={onClose}>
          {t('mailbox.manage.done')}
        </Button>
      }
    >
      <p className={styles.manageHint}>{t('mailbox.manage.hint')}</p>
      <ul className={styles.manageList}>
        {rows.map((node) => {
          const mailbox = node.mailbox
          const name = folderDisplayName(mailbox, t)
          const standard = isStandardFolder(mailbox)
          // A folder's `sortOrder` is written by a `Mailbox/set` update on the folder itself, and
          // `mayRename` is the right that governs one (RFC 8621 §2 has no `mayConfigure`).
          const reorderable = !standard && mailbox.myRights.mayRename
          return (
            <li
              key={mailbox.id}
              ref={(element) => {
                if (element === null) rowRefs.current.delete(mailbox.id)
                else rowRefs.current.set(mailbox.id, element)
              }}
              className={styles.manageRow}
              data-dragging={dragging === mailbox.id ? 'true' : undefined}
              data-lifted={lifted === mailbox.id ? 'true' : undefined}
            >
              {reorderable ? (
                <IconButton
                  className={styles.handle}
                  label={t('mailbox.manage.reorder', { name })}
                  aria-pressed={lifted === mailbox.id}
                  aria-describedby={instructionsId}
                  onKeyDown={(event) => onHandleKeyDown(event, mailbox)}
                  onPointerDown={(event) => onHandlePointerDown(event, mailbox)}
                >
                  <GripVertical />
                </IconButton>
              ) : (
                <span className={styles.handlePlaceholder} aria-hidden="true" />
              )}
              <span
                className={styles.manageName}
                style={{ paddingInlineStart: `calc(${node.depth} * var(--waxwing-space-4))` }}
              >
                {name}
              </span>
              {standard ? (
                <span className={styles.manageStandard}>{t('mailbox.manage.alwaysShown')}</span>
              ) : (
                <Switch
                  checked={mailbox.isSubscribed}
                  aria-label={t('mailbox.manage.show', { name })}
                  onCheckedChange={(checked) => onSetSubscribed(mailbox.id, checked)}
                />
              )}
            </li>
          )
        })}
      </ul>
      <VisuallyHidden id={instructionsId}>{t('mailbox.manage.reorderHint')}</VisuallyHidden>
      <VisuallyHidden aria-live="polite">{announcement}</VisuallyHidden>
    </Dialog>
  )
}
