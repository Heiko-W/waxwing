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
  Send,
  Trash2,
} from 'lucide-react'
import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MailboxRow } from '../sync'
import { Badge, Menu, type MenuItemSpec, VisuallyHidden } from '../ui'
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
  /** Empty a Trash/Junk mailbox (M3.2 cleanup); omit to hide the entry. */
  readonly onRequestEmpty?: (mailbox: MailboxRow) => void
  /** Delete messages older than N days from any purgeable mailbox (M3.2 cleanup); omit to hide. */
  readonly onRequestDeleteOlder?: (mailbox: MailboxRow) => void
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
  onRequestEmpty,
  onRequestDeleteOlder,
}: FolderTreeViewProps) {
  const { t } = useTranslation()
  const rows = visibleRows(tree, (id) => collapsed.has(id))
  const itemRefs = useRef(new Map<string, HTMLDivElement>())
  // The single tabbable row (roving focus). `undefined` until the user navigates, so the tree never
  // steals focus on mount.
  const [focusId, setFocusId] = useState<string | undefined>(undefined)

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
        const menuItems = actionItems(mailbox, t, {
          onRequestCreate,
          onRequestRename,
          onRequestDelete,
          onRequestEmpty,
          onRequestDeleteOlder,
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
            className={styles.item}
            style={{
              paddingInlineStart: `calc(${depth} * var(--waxwing-space-4) + var(--waxwing-space-2))`,
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
  )
}

function actionItems(
  mailbox: MailboxRow,
  t: (key: string) => string,
  handlers: {
    onRequestCreate: (parentId: string | null) => void
    onRequestRename: (mailbox: MailboxRow) => void
    onRequestDelete: (mailbox: MailboxRow) => void
    onRequestEmpty?: ((mailbox: MailboxRow) => void) | undefined
    onRequestDeleteOlder?: ((mailbox: MailboxRow) => void) | undefined
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
