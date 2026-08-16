/**
 * Label list — presentational APG single-level `tree` (M3.2). Pure function of props: swatch + name
 * + unread `Badge` + a per-label action `Menu`, with one roving tab stop over the `role="treeitem"`
 * rows (Up/Down/Home/End, Enter/Space to open). All state (active label, dialogs) lives in the
 * {@link Labels} container; the view only raises intent. Mirrors {@link FolderTreeView} — a flat tree,
 * not a listbox, because a `listbox`/`option` cannot host the per-row action button without tripping
 * axe's nested-interactive rule, whereas the tree pattern places it in a presentational wrapper.
 */

import { MoreHorizontal } from 'lucide-react'
import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge, Menu, type MenuItemSpec, VisuallyHidden } from '../../ui'
import { LabelSwatch } from './LabelSwatch'
import styles from './labels.module.css'
import type { LabelSummary } from './use-labels'

export interface LabelListProps {
  readonly labels: LabelSummary[]
  readonly activeKeyword: string | undefined
  readonly onSelect: (keyword: string) => void
  readonly onRename: (label: LabelSummary) => void
  readonly onRecolor: (label: LabelSummary) => void
  readonly onDelete: (label: LabelSummary) => void
  readonly onAddToLabels: (label: LabelSummary) => void
}

export function LabelList({
  labels,
  activeKeyword,
  onSelect,
  onRename,
  onRecolor,
  onDelete,
  onAddToLabels,
}: LabelListProps) {
  const { t } = useTranslation()
  const itemRefs = useRef(new Map<string, HTMLDivElement>())
  const [focusKeyword, setFocusKeyword] = useState<string | undefined>(undefined)

  // Exactly one roving tab stop: the last-focused, else the active label, else the first row —
  // only when it is a real row, so a stale keyword can never strand the list keyboard-unreachable.
  const keywords = new Set(labels.map((label) => label.keyword))
  const preferred = [focusKeyword, activeKeyword].find(
    (keyword) => keyword !== undefined && keywords.has(keyword),
  )
  const tabbable = preferred ?? labels[0]?.keyword

  useEffect(() => {
    if (focusKeyword !== undefined) itemRefs.current.get(focusKeyword)?.focus()
  }, [focusKeyword])

  function moveTo(index: number): void {
    const label = labels[index]
    if (label) setFocusKeyword(label.keyword)
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (tabbable === undefined) return
    const index = labels.findIndex((label) => label.keyword === tabbable)
    if (index < 0) return
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        moveTo(Math.min(index + 1, labels.length - 1))
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
        moveTo(labels.length - 1)
        break
      case 'Enter':
      case ' ': {
        event.preventDefault()
        const label = labels[index]
        if (label) onSelect(label.keyword)
        break
      }
    }
  }

  return (
    <div role="tree" aria-label={t('labels.title')} className={styles.list} onKeyDown={onKeyDown}>
      {labels.map((label) => {
        const selected = label.keyword === activeKeyword
        const menuItems = actionItems(label, t, { onRename, onRecolor, onDelete, onAddToLabels })
        return (
          // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard is handled at the role=tree container (APG delegation), not per treeitem.
          <div
            key={label.keyword}
            ref={(element) => {
              if (element) itemRefs.current.set(label.keyword, element)
              else itemRefs.current.delete(label.keyword)
            }}
            role="treeitem"
            aria-level={1}
            aria-selected={selected}
            aria-current={selected ? 'page' : undefined}
            tabIndex={label.keyword === tabbable ? 0 : -1}
            className={styles.item}
            onClick={() => {
              setFocusKeyword(label.keyword)
              onSelect(label.keyword)
            }}
          >
            <LabelSwatch color={label.color} size="sm" />
            <span className={`${styles.label}${label.discovered ? ` ${styles.discovered}` : ''}`}>
              {label.name}
            </span>
            {label.unread > 0 && (
              <span className={styles.count}>
                <span aria-hidden="true">
                  <Badge tone="neutral">{label.unread}</Badge>
                </span>
                <VisuallyHidden>{t('labels.unread', { count: label.unread })}</VisuallyHidden>
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
                  // Named after its ROW (B20.5). Without the name, a list of twelve labels exposes
                  // twelve buttons all called "Label actions" — a screen reader's rotor shows a
                  // column of identical entries and voice control has nothing to disambiguate on.
                  triggerLabel={t('labels.actions.menu', { name: label.name })}
                  trigger={<MoreHorizontal aria-hidden="true" className={styles.check} />}
                  items={menuItems}
                  triggerTabIndex={label.keyword === tabbable ? 0 : -1}
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
  label: LabelSummary,
  t: (key: string) => string,
  handlers: {
    onRename: (label: LabelSummary) => void
    onRecolor: (label: LabelSummary) => void
    onDelete: (label: LabelSummary) => void
    onAddToLabels: (label: LabelSummary) => void
  },
): MenuItemSpec[] {
  if (label.discovered) {
    return [
      {
        id: 'add',
        label: t('labels.actions.addToLabels'),
        onSelect: () => handlers.onAddToLabels(label),
      },
      {
        id: 'recolor',
        label: t('labels.actions.recolor'),
        onSelect: () => handlers.onRecolor(label),
      },
    ]
  }
  return [
    { id: 'rename', label: t('labels.actions.rename'), onSelect: () => handlers.onRename(label) },
    {
      id: 'recolor',
      label: t('labels.actions.recolor'),
      onSelect: () => handlers.onRecolor(label),
    },
    {
      id: 'delete',
      label: t('labels.actions.delete'),
      destructive: true,
      onSelect: () => handlers.onDelete(label),
    },
  ]
}
