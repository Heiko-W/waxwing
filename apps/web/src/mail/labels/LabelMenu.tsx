/**
 * Label picker popover (M3.2) — a controlled `role="menu"` of `menuitemcheckbox` toggles, one per
 * label, whose `aria-checked` is three-state: checked when ALL given messages carry the keyword,
 * `mixed` when only some do, unchecked otherwise (so color is never the sole signal). Toggling
 * dispatches a `setKeyword` intent over every given id. A trailing "New label…" entry opens the
 * shared create dialog.
 *
 * Controlled: the parent owns open/close and supplies the `anchorRef` the popover positions against
 * (a bulk-bar button, the reading-view action bar, or the list container for the `l` shortcut). The
 * parent unmounts this to close. Keyboard: Up/Down/Home/End roving, Enter/Space toggle, Escape/Tab
 * close, focus returns to the anchor on close.
 */

import type { Id } from '@waxwing/jmap'
import { Check, Minus, Plus } from 'lucide-react'
import { type KeyboardEvent, type RefObject, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { type EmailRow, emailsByIds, useReplicaQuery } from '../../sync'
import { getActiveEngine } from '../../sync/engine'
import { Portal } from '../../ui'
import { useMessageActions } from '../use-message-actions'
import { LabelFormDialog } from './LabelFormDialog'
import { LabelSwatch } from './LabelSwatch'
import styles from './labels.module.css'
import { type LabelSummary, useLabelActions, useLabels } from './use-labels'

export interface LabelMenuProps {
  readonly ids: Id[]
  readonly anchorRef: RefObject<HTMLElement | null>
  readonly onClose: () => void
}

type CheckState = boolean | 'mixed'

/**
 * Whether ALL / SOME / NONE of the selection carry the keyword. `known` are the hydrated rows;
 * `total` is the full selection size. "Checked" (all) is claimed ONLY when every selected message is
 * known AND carries it — so a partially-hydrated selection never shows a misleading full checkmark.
 */
function membership(known: EmailRow[], total: number, keyword: string): CheckState {
  let count = 0
  for (const row of known) if (row.keywords[keyword] === true) count += 1
  if (count === 0) return false
  return count === total ? true : 'mixed'
}

export function LabelMenu({ ids, anchorRef, onClose }: LabelMenuProps) {
  const { t } = useTranslation()
  const idsKey = ids.join(',')
  // Membership must reflect ALL selected messages, not just the visible/hydrated slice — a large
  // select-all can include ids whose envelopes aren't loaded. Pull the missing ones into the replica,
  // then compute the three-state over the complete set (the live query refines it as they land).
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the stable idsKey, not the array ref.
  useEffect(() => {
    void getActiveEngine()?.fetchEnvelopes(ids)
  }, [idsKey])
  const known = (
    useReplicaQuery(({ db, accountId }) => emailsByIds(db, accountId, ids), [idsKey]) ?? []
  ).filter((row): row is EmailRow => row !== undefined)
  const labels = useLabels()
  const actions = useMessageActions()
  const labelActions = useLabelActions()
  const menuRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const [focusedIndex, setFocusedIndex] = useState(0)
  const [coords, setCoords] = useState({ top: 0, left: 0 })
  const [createOpen, setCreateOpen] = useState(false)

  const list = labels ?? []
  const total = list.length + 1 // +1 for the "New label…" entry
  const createIndex = list.length

  // Position against the anchor on mount.
  useEffect(() => {
    const rect = anchorRef.current?.getBoundingClientRect()
    if (rect) setCoords({ top: rect.bottom + 4, left: rect.left })
  }, [anchorRef])

  // Focus the currently-roved item (skip while the create dialog is up — it owns focus). `list.length`
  // is a dep on purpose: when the async labels arrive (0→N) focus must re-land on the first real item
  // rather than stay on the initial "New label…" placeholder.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run when the labels list first populates.
  useEffect(() => {
    if (!createOpen) itemRefs.current[focusedIndex]?.focus()
  }, [focusedIndex, createOpen, list.length])

  function close(): void {
    anchorRef.current?.focus()
    onClose()
  }

  // Escape + outside-pointer dismissal (the anchor counts as "inside" so its own click just closes).
  useEffect(() => {
    if (createOpen) return
    function onKey(event: globalThis.KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.stopPropagation()
        anchorRef.current?.focus()
        onClose()
      }
    }
    function onPointerDown(event: PointerEvent): void {
      const target = event.target as Node | null
      if (target === null) return
      if (menuRef.current?.contains(target) || anchorRef.current?.contains(target)) return
      onClose()
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [createOpen, anchorRef, onClose])

  function toggle(label: LabelSummary): void {
    const state = membership(known, ids.length, label.keyword)
    actions.setKeyword(ids, label.keyword, state !== true)
  }

  function activate(index: number): void {
    if (index === createIndex) {
      setCreateOpen(true)
      return
    }
    const label = list[index]
    if (label) toggle(label)
  }

  function move(delta: number): void {
    if (total === 0) return
    setFocusedIndex((current) => (current + delta + total) % total)
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        move(1)
        break
      case 'ArrowUp':
        event.preventDefault()
        move(-1)
        break
      case 'Home':
        event.preventDefault()
        setFocusedIndex(0)
        break
      case 'End':
        event.preventDefault()
        setFocusedIndex(total - 1)
        break
      case 'Enter':
      case ' ':
        event.preventDefault()
        activate(focusedIndex)
        break
      case 'Tab':
        close()
        break
    }
  }

  if (createOpen) {
    return (
      <LabelFormDialog
        mode="create"
        existingKeywords={list.filter((label) => !label.discovered).map((label) => label.keyword)}
        onClose={() => {
          setCreateOpen(false)
          close()
        }}
        onSubmit={(name, color) => {
          labelActions.create(name, color)
          setCreateOpen(false)
          close()
        }}
      />
    )
  }

  return (
    <Portal>
      <div
        ref={menuRef}
        role="menu"
        aria-label={t('labels.menuTitle')}
        className={styles.menu}
        style={{ position: 'fixed', top: coords.top, left: coords.left }}
        onKeyDown={onKeyDown}
      >
        {list.map((label, index) => {
          const state = membership(known, ids.length, label.keyword)
          return (
            <button
              key={label.keyword}
              ref={(node) => {
                itemRefs.current[index] = node
              }}
              type="button"
              role="menuitemcheckbox"
              aria-checked={state === 'mixed' ? 'mixed' : state}
              tabIndex={-1}
              className={styles.menuItem}
              onClick={() => toggle(label)}
            >
              <span className={styles.check}>
                {state === true ? (
                  <Check aria-hidden="true" />
                ) : state === 'mixed' ? (
                  <Minus aria-hidden="true" />
                ) : null}
              </span>
              <LabelSwatch color={label.color} size="sm" />
              <span className={styles.menuItemLabel}>{label.name}</span>
            </button>
          )
        })}
        <div className={styles.separator} aria-hidden="true" />
        <button
          ref={(node) => {
            itemRefs.current[createIndex] = node
          }}
          type="button"
          role="menuitem"
          tabIndex={-1}
          className={styles.menuItem}
          onClick={() => setCreateOpen(true)}
        >
          <Plus aria-hidden="true" className={styles.check} />
          <span className={styles.menuItemLabel}>{t('labels.newEllipsis')}</span>
        </button>
      </div>
    </Portal>
  )
}
