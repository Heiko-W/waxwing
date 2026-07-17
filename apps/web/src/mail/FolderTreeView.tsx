/**
 * Folder tree — presentational APG `tree` (M1.5, FR-MBX-01/02). Pure function of props: it renders
 * the visible rows of a {@link FolderNode} tree with roving focus, localized role names, live unread
 * badges and a per-folder action menu gated by `myRights`. All state (selection, collapse, dialogs)
 * lives in the container; the view only raises intent.
 *
 * A11y: one roving tab stop over `role="treeitem"` rows carrying `aria-level`/`aria-selected`/
 * `aria-expanded`; keyboard per the APG tree pattern (Up/Down, Left/Right to collapse/expand or move
 * to parent/child, Home/End, Enter/Space to open). The focusable treeitem holds ONLY non-interactive
 * content — the action `Menu` is a sibling inside a presentational wrapper — so no interactive
 * control nests inside another (axe `nested-interactive`).
 */

import {
  Archive,
  Ban,
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  Inbox,
  type LucideIcon,
  MoreHorizontal,
  Pin,
  Send,
  Trash2,
} from 'lucide-react'
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MailboxRow } from '../sync'
import { Badge, Menu, type MenuItemSpec, VisuallyHidden } from '../ui'
import { MAILBOX_MIME, MESSAGES_MIME } from './dnd'
import { type FolderNode, folderDisplayName, visibleRows } from './folder-tree'
import styles from './folder-tree.module.css'

const ROLE_ICONS: Record<string, LucideIcon> = {
  inbox: Inbox,
  drafts: FileText,
  sent: Send,
  archive: Archive,
  junk: Ban,
  trash: Trash2,
}

export interface FolderTreeViewProps {
  readonly tree: FolderNode[]
  readonly selectedMailboxId: string | undefined
  readonly collapsed: ReadonlySet<string>
  readonly onToggleCollapse: (id: string) => void
  readonly onSelect: (id: string) => void
  readonly onRequestCreate: (parentId: string | null) => void
  readonly onRequestRename: (mailbox: MailboxRow) => void
  readonly onRequestDelete: (mailbox: MailboxRow) => void
  /** Re-parent a folder (M3.9, FR-MBX-03) — the non-pointer path SC 2.5.7 requires; omit to hide. */
  readonly onRequestMove?: (mailbox: MailboxRow) => void
  /** May the drag in flight drop on this mailbox? Omit to disable drop entirely (M3.9 5b). */
  readonly canDropOn?: (mailbox: MailboxRow) => boolean
  /** A drag was dropped on this mailbox — carry out the move (M3.9 5b). */
  readonly onDropOn?: (mailbox: MailboxRow) => void
  /** A folder re-parent drag started on this mailbox (M3.9 5b); omit to disable folder dragging. */
  readonly onDragStartMailbox?: (mailbox: MailboxRow) => void
  /** Empty a Trash/Junk mailbox (M3.2 cleanup); omit to hide the entry. */
  readonly onRequestEmpty?: (mailbox: MailboxRow) => void
  /** Delete messages older than N days from any purgeable mailbox (M3.2 cleanup); omit to hide. */
  readonly onRequestDeleteOlder?: (mailbox: MailboxRow) => void
  /** Mailboxes kept offline (M3.4) — exempt from eviction and prefetched. */
  readonly pinned?: ReadonlySet<string>
  /** Toggle a folder's "keep offline" pin (M3.4); omit to hide the entry. */
  readonly onTogglePin?: (mailbox: MailboxRow) => void
}

export function FolderTreeView({
  tree,
  selectedMailboxId,
  collapsed,
  onToggleCollapse,
  onSelect,
  onRequestCreate,
  onRequestRename,
  onRequestDelete,
  onRequestMove,
  canDropOn,
  onDropOn,
  onDragStartMailbox,
  onRequestEmpty,
  onRequestDeleteOlder,
  pinned,
  onTogglePin,
}: FolderTreeViewProps) {
  const { t } = useTranslation()
  const rows = visibleRows(tree, (id) => collapsed.has(id))
  const rowsById = useMemo(
    () => new Map(rows.map((node) => [node.mailbox.id, node.mailbox])),
    [rows],
  )
  const itemRefs = useRef(new Map<string, HTMLDivElement>())
  // The single tabbable row (roving focus). `undefined` until the user navigates, so the tree never
  // steals focus on mount.
  const [focusId, setFocusId] = useState<string | undefined>(undefined)
  // The mailbox a drag is currently hovering (M3.9 5b); drives the `.dropTarget` ring and the
  // announcer. Null when no drag is over a legal target.
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)

  // Exactly one roving tab stop. The preferred id (last-focused, else the routed selection) is only
  // honored when it is actually a VISIBLE row — otherwise (its ancestor was collapsed, or it was
  // deleted) the whole tree would end up with zero tab stops and become keyboard-unreachable.
  const visibleIds = new Set(rows.map((node) => node.mailbox.id))
  const preferred = [focusId, selectedMailboxId].find(
    (id) => id !== undefined && visibleIds.has(id),
  )
  const tabbableId = preferred ?? rows[0]?.mailbox.id

  useEffect(() => {
    if (focusId !== undefined) itemRefs.current.get(focusId)?.focus()
  }, [focusId])

  function moveTo(index: number): void {
    const node = rows[index]
    if (node) setFocusId(node.mailbox.id)
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const currentId = tabbableId
    if (currentId === undefined) return
    const index = rows.findIndex((node) => node.mailbox.id === currentId)
    if (index < 0) return
    const node = rows[index]
    if (!node) return
    const hasChildren = node.children.length > 0
    const isCollapsed = collapsed.has(node.mailbox.id)

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        moveTo(Math.min(index + 1, rows.length - 1))
        break
      case 'ArrowUp':
        event.preventDefault()
        moveTo(Math.max(index - 1, 0))
        break
      case 'Home':
        event.preventDefault()
        moveTo(0)
        break
      case 'End':
        event.preventDefault()
        moveTo(rows.length - 1)
        break
      case 'ArrowRight':
        event.preventDefault()
        if (hasChildren && isCollapsed) onToggleCollapse(node.mailbox.id)
        else if (hasChildren) moveTo(index + 1) // first child is the next visible row
        break
      case 'ArrowLeft':
        event.preventDefault()
        if (hasChildren && !isCollapsed) onToggleCollapse(node.mailbox.id)
        else {
          const parent = rows.findIndex((n) => n.mailbox.id === node.mailbox.parentId)
          if (parent >= 0) moveTo(parent)
        }
        break
      case 'Enter':
      case ' ':
        event.preventDefault()
        onSelect(node.mailbox.id)
        break
    }
  }

  return (
    <>
      <div
        role="tree"
        aria-label={t('shell.folders.title')}
        className={styles.tree}
        onKeyDown={onKeyDown}
      >
        {rows.map((node) => {
          const { mailbox, depth } = node
          const hasChildren = node.children.length > 0
          const expanded = hasChildren ? !collapsed.has(mailbox.id) : undefined
          const selected = mailbox.id === selectedMailboxId
          const Icon = (mailbox.role !== null && ROLE_ICONS[mailbox.role]) || Folder
          const isPinned = pinned?.has(mailbox.id) ?? false
          const menuItems = actionItems(mailbox, t, isPinned, {
            onRequestCreate,
            onRequestRename,
            onRequestDelete,
            onRequestMove,
            onRequestEmpty,
            onRequestDeleteOlder,
            onTogglePin,
          })
          return (
            // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard is handled at the role=tree container via onKeyDown delegation (APG tree pattern), not per treeitem.
            <div
              key={mailbox.id}
              ref={(element) => {
                if (element) itemRefs.current.set(mailbox.id, element)
                else itemRefs.current.delete(mailbox.id)
              }}
              role="treeitem"
              aria-level={depth + 1}
              aria-setsize={node.setsize}
              aria-posinset={node.posinset}
              aria-selected={selected}
              aria-expanded={expanded}
              aria-current={selected ? 'page' : undefined}
              tabIndex={mailbox.id === tabbableId ? 0 : -1}
              className={`${styles.item}${dropTargetId === mailbox.id ? ` ${styles.dropTarget}` : ''}`}
              style={{
                paddingInlineStart: `calc(${depth} * var(--waxwing-space-4) + var(--waxwing-space-2))`,
              }}
              // A folder re-parents by dragging; the subject-side right is `mayRename`, exactly what the
              // "Move to…" menu item gates on. The legal-target Set is computed once at dragstart.
              draggable={onDragStartMailbox !== undefined && mailbox.myRights.mayRename}
              onDragStart={(event) => {
                event.dataTransfer.setData(MAILBOX_MIME, mailbox.id)
                event.dataTransfer.effectAllowed = 'move'
                onDragStartMailbox?.(mailbox)
              }}
              onDragEnd={() => setDropTargetId(null)}
              onDragOver={(event) => {
                // Only OUR drags, and only where the caller says a drop is legal. By spec `dragover`
                // may read `types` but never the values — which is why the subject rides in module
                // state, not the payload.
                const types = event.dataTransfer.types
                if (!types.includes(MESSAGES_MIME) && !types.includes(MAILBOX_MIME)) return
                if (canDropOn?.(mailbox) !== true) return
                event.preventDefault() // accept the drop
                event.dataTransfer.dropEffect = 'move'
                setDropTargetId(mailbox.id)
              }}
              onDragLeave={(event) => {
                // dragleave fires when the cursor crosses into a CHILD span (chevron/label/count) too;
                // only clear when it truly left the row, or the highlight flickers.
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                  setDropTargetId(null)
                }
              }}
              onDrop={(event) => {
                if (canDropOn?.(mailbox) !== true) return
                event.preventDefault()
                setDropTargetId(null)
                onDropOn?.(mailbox)
              }}
              onClick={(event) => {
                if ((event.target as HTMLElement).closest('[data-chevron]')) {
                  onToggleCollapse(mailbox.id)
                } else {
                  setFocusId(mailbox.id)
                  onSelect(mailbox.id)
                }
              }}
            >
              {hasChildren ? (
                <span data-chevron className={styles.chevron} aria-hidden="true">
                  {expanded ? <ChevronDown /> : <ChevronRight />}
                </span>
              ) : (
                <span className={styles.chevron} aria-hidden="true" />
              )}
              <Icon aria-hidden="true" className={styles.icon} />
              <span className={styles.label}>{folderDisplayName(mailbox, t)}</span>
              {isPinned && (
                // The pin glyph is decorative; the state is announced once, on the row itself.
                <span className={styles.pin}>
                  <Pin aria-hidden="true" className={styles.icon} />
                  <VisuallyHidden>{t('mailbox.keptOffline')}</VisuallyHidden>
                </span>
              )}
              {mailbox.unreadEmails > 0 && (
                <span className={styles.count}>
                  {/* The visible pill is decorative; the count is announced once via VisuallyHidden. */}
                  <span aria-hidden="true">
                    <Badge tone="neutral">{mailbox.unreadEmails}</Badge>
                  </span>
                  <VisuallyHidden>
                    {t('mailbox.unread', { count: mailbox.unreadEmails })}
                  </VisuallyHidden>
                </span>
              )}
              {menuItems.length > 0 && (
                // biome-ignore lint/a11y/noStaticElementInteractions: stops a menu click from selecting the row.
                <span
                  className={styles.rowMenu}
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => event.stopPropagation()}
                >
                  <Menu
                    align="end"
                    triggerLabel={t('mailbox.actions.menu')}
                    trigger={<MoreHorizontal aria-hidden="true" className={styles.icon} />}
                    items={menuItems}
                    // Keep the tree a single tab stop: only the active row's action button is tabbable.
                    triggerTabIndex={mailbox.id === tabbableId ? 0 : -1}
                  />
                </span>
              )}
            </div>
          )
        })}
      </div>
      {/* OUTSIDE role="tree" (a tree may only contain treeitem/group — axe aria-required-children),
          and ALWAYS mounted with its text swapped: a screen reader only announces a live region that
          already existed in the DOM (Toast.tsx says the same). Derived from `dropTargetId`, so it
          changes on target CHANGE, not on the dragover firehose. No `aria-dropeffect` — deprecated. */}
      <VisuallyHidden aria-live="polite">
        {dropTargetId !== null && rowsById.has(dropTargetId)
          ? t('folders.drag.over', {
              folder: folderDisplayName(rowsById.get(dropTargetId) as MailboxRow, t),
            })
          : ''}
      </VisuallyHidden>
    </>
  )
}

function actionItems(
  mailbox: MailboxRow,
  t: (key: string) => string,
  isPinned: boolean,
  handlers: {
    onRequestCreate: (parentId: string | null) => void
    onRequestRename: (mailbox: MailboxRow) => void
    onRequestDelete: (mailbox: MailboxRow) => void
    onRequestMove?: ((mailbox: MailboxRow) => void) | undefined
    onRequestEmpty?: ((mailbox: MailboxRow) => void) | undefined
    onRequestDeleteOlder?: ((mailbox: MailboxRow) => void) | undefined
    onTogglePin?: ((mailbox: MailboxRow) => void) | undefined
  },
): MenuItemSpec[] {
  const items: MenuItemSpec[] = []
  if (mailbox.myRights.mayCreateChild) {
    items.push({
      id: 'new',
      label: t('mailbox.actions.newSubfolder'),
      onSelect: () => handlers.onRequestCreate(mailbox.id),
    })
  }
  if (mailbox.myRights.mayRename) {
    items.push({
      id: 'rename',
      label: t('mailbox.actions.rename'),
      onSelect: () => handlers.onRequestRename(mailbox),
    })
  }
  // A re-parent is a Mailbox/set update on THIS mailbox, so `mayRename` is the right that governs it
  // — there is no `mayMove`. Whether any legal target exists is the dialog's question, not the
  // menu's: gating here would need the whole tree and turn a pure helper into a tree walk.
  if (handlers.onRequestMove && mailbox.myRights.mayRename) {
    const onRequestMove = handlers.onRequestMove
    items.push({
      id: 'move',
      label: t('mailbox.actions.move'),
      onSelect: () => onRequestMove(mailbox),
    })
  }
  // "Keep offline" (M3.4). A menu ITEM has no checked state, and inventing one would be a lie to
  // assistive tech: the APG treatment for a toggle in a plain menu is to name the ACTION, so the
  // label flips instead ("Keep offline" ⇄ "Stop keeping offline"). The current state is on the row.
  if (handlers.onTogglePin && mailbox.myRights.mayReadItems) {
    const onTogglePin = handlers.onTogglePin
    items.push({
      id: 'keepOffline',
      label: isPinned ? t('mailbox.actions.keepOfflineOff') : t('mailbox.actions.keepOffline'),
      icon: Pin,
      onSelect: () => onTogglePin(mailbox),
    })
  }
  // Cleanup (M3.2): empty a Trash/Junk mailbox, or delete older messages from any purgeable one.
  if (handlers.onRequestEmpty && (mailbox.role === 'trash' || mailbox.role === 'junk')) {
    const onRequestEmpty = handlers.onRequestEmpty
    items.push({
      id: 'empty',
      label: mailbox.role === 'trash' ? t('cleanup.menu.emptyTrash') : t('cleanup.menu.emptyJunk'),
      destructive: true,
      onSelect: () => onRequestEmpty(mailbox),
    })
  }
  if (handlers.onRequestDeleteOlder && mailbox.myRights.mayRemoveItems) {
    const onRequestDeleteOlder = handlers.onRequestDeleteOlder
    items.push({
      id: 'deleteOlder',
      label: t('cleanup.menu.deleteOlder'),
      onSelect: () => onRequestDeleteOlder(mailbox),
    })
  }
  if (mailbox.myRights.mayDelete) {
    items.push({
      id: 'delete',
      label: t('mailbox.actions.delete'),
      destructive: true,
      onSelect: () => handlers.onRequestDelete(mailbox),
    })
  }
  return items
}
