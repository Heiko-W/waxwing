/**
 * The ordered list of filter rules (M5.2, FR-SIEVE-01) — and the reorder that Sieve makes
 * mandatory rather than nice to have.
 *
 * **Order is the semantics.** A rule carrying `stop` ends processing, and everything below it
 * never runs; two rules filing into different folders are decided by which one comes first. A
 * builder that can only append is therefore a builder in which a wrong order can only be fixed by
 * deleting rules and typing them in again.
 *
 * Two ways to do it, one operation underneath (`moveItem`), because neither alone is enough:
 *
 * - **Drag the grabber.** Pointer events, not HTML5 drag & drop, so a finger works the same as a
 *   mouse — see ADR-026. The grabber is the only drag surface: the row itself stays a plain row,
 *   so tapping a rule name never becomes a gesture.
 * - **Or don't drag at all.** Focus the grabber, press Space to pick the rule up, move it with the
 *   arrow keys, Space to drop it, Escape to put it back. WCAG 2.2 SC 2.5.7 requires a non-dragging
 *   path for every drag; this is also the only path that works from a keyboard, and the only one
 *   this jsdom can execute at all (it has no layout, so every rectangle here is zero).
 *
 * Nothing is written to the server until the rule is dropped. A drag that crosses four rows is one
 * save, not four.
 */

import { GripVertical } from 'lucide-react'
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useId,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import { Button, IconButton, Switch, VisuallyHidden } from '../../ui'
import settings from '../settings.module.css'
import styles from './filters.module.css'
import { dropIndex, moveItem, type SieveRule } from './rule-model'

export interface RuleListProps {
  readonly rules: readonly SieveRule[]
  /** Every write is refused — offline, or a save in flight. */
  readonly disabled: boolean
  onToggle(rule: SieveRule, enabled: boolean): void
  onEdit(rule: SieveRule): void
  onDelete(rule: SieveRule): void
  /** Called once, on drop, with the new order. */
  onReorder(rules: readonly SieveRule[]): void
}

/**
 * How far a pointer must travel before a press on the grabber counts as a drag.
 *
 * Without it a plain click reorders: `dropIndex` answers with a real index for the very first
 * `pointermove`, and a mouse moves a pixel or two between press and release.
 */
const DRAG_SLOP_PX = 4

export function RuleList(props: RuleListProps) {
  const { t } = useTranslation()
  const instructionsId = useId()

  /** The order being shown while a reorder is in flight; `null` = whatever the props say. */
  const [draft, setDraft] = useState<readonly SieveRule[] | null>(null)
  /** The rule picked up from the keyboard, if any. */
  const [lifted, setLifted] = useState<string | null>(null)
  /** The rule under a finger or a mouse button, if any. */
  const [dragging, setDragging] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState('')

  const rows = useRef(new Map<string, HTMLLIElement>())
  /** The listeners on `window` cannot read React state, so the live order is mirrored here. */
  const liveDraft = useRef<readonly SieveRule[]>([])

  const current = draft ?? props.rules

  const announce = useCallback(
    (rules: readonly SieveRule[], id: string) => {
      const index = rules.findIndex((rule) => rule.id === id)
      const rule = rules[index]
      if (rule === undefined) return
      setAnnouncement(
        t('settings.filters.rule.movedTo', {
          name: rule.name,
          position: index + 1,
          count: rules.length,
        }),
      )
    },
    [t],
  )

  /** Ends a reorder, writing it only when it changed something. */
  const commit = useCallback(
    (next: readonly SieveRule[] | null) => {
      setDraft(null)
      setLifted(null)
      setDragging(null)
      if (next === null) return
      const changed = next.some((rule, index) => rule.id !== props.rules[index]?.id)
      if (changed) props.onReorder(next)
    },
    [props],
  )

  const move = useCallback(
    (id: string, delta: number) => {
      const from = current.findIndex((rule) => rule.id === id)
      if (from === -1) return
      const next = moveItem(current, from, from + delta)
      if (next === current) return
      liveDraft.current = next
      setDraft(next)
      announce(next, id)
    },
    [current, announce],
  )

  function onHandleKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, rule: SieveRule) {
    if (props.disabled) return
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault()
      if (lifted === rule.id) {
        commit(draft)
        setAnnouncement(t('settings.filters.rule.dropped', { name: rule.name }))
        return
      }
      liveDraft.current = current
      setDraft(current)
      setLifted(rule.id)
      announce(current, rule.id)
      return
    }
    if (lifted !== rule.id) return
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault()
      move(rule.id, event.key === 'ArrowUp' ? -1 : 1)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      // Put it back where it was: the props are still the saved order, nothing was written.
      commit(null)
      setAnnouncement(t('settings.filters.rule.dropCanceled', { name: rule.name }))
    }
  }

  function onHandlePointerDown(event: ReactPointerEvent<HTMLButtonElement>, rule: SieveRule) {
    if (props.disabled) return
    if (event.pointerType === 'mouse' && event.button !== 0) return
    // Stops the browser turning the press into a text selection or a scroll; `touch-action: none`
    // on the grabber does the compositor half, which `preventDefault` cannot reach once the
    // gesture has been claimed.
    event.preventDefault()

    const startY = event.clientY
    liveDraft.current = current
    setDraft(current)
    setDragging(rule.id)
    let moved = false

    const onMove = (moveEvent: globalThis.PointerEvent) => {
      if (!moved && Math.abs(moveEvent.clientY - startY) < DRAG_SLOP_PX) return
      moved = true
      const order = liveDraft.current
      const midpoints = order.map((entry) => {
        const element = rows.current.get(entry.id)
        if (element === undefined) return Number.POSITIVE_INFINITY
        const rect = element.getBoundingClientRect()
        return rect.top + rect.height / 2
      })
      const from = order.findIndex((entry) => entry.id === rule.id)
      const to = dropIndex(midpoints, moveEvent.clientY)
      if (from === -1 || to === from) return
      const next = moveItem(order, from, to)
      liveDraft.current = next
      setDraft(next)
      announce(next, rule.id)
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
    // A `pointercancel` is the browser taking the gesture (a scroll, a system drag). Treat it as
    // "abandon", the way the row swipe does — a half-finished reorder must not be saved.
    const onCancel = () => {
      detach()
      commit(null)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
  }

  return (
    <>
      <ul className={styles.ruleList}>
        {current.map((rule, index) => (
          <li
            key={rule.id}
            ref={(element) => {
              if (element === null) rows.current.delete(rule.id)
              else rows.current.set(rule.id, element)
            }}
            className={styles.ruleRow}
            data-dragging={dragging === rule.id ? 'true' : undefined}
            data-lifted={lifted === rule.id ? 'true' : undefined}
            data-rule-position={index + 1}
          >
            <Switch
              checked={rule.enabled}
              label={t('settings.filters.rule.enabled')}
              disabled={props.disabled}
              onCheckedChange={(enabled) => props.onToggle(rule, enabled)}
            />
            <span className={styles.ruleName}>{rule.name}</span>
            <div className={settings.rowActions}>
              <Button
                variant="ghost"
                size="sm"
                disabled={props.disabled}
                onClick={() => props.onEdit(rule)}
              >
                {t('settings.filters.rule.edit')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={props.disabled}
                onClick={() => props.onDelete(rule)}
              >
                {t('settings.filters.rule.delete')}
              </Button>
              {/* Trailing edge, the way an iOS list puts its grabber — and the only thing on the
                  row that a drag starts from. */}
              <IconButton
                className={styles.handle}
                label={t('settings.filters.rule.reorder', { name: rule.name })}
                aria-pressed={lifted === rule.id}
                aria-describedby={instructionsId}
                disabled={props.disabled}
                onKeyDown={(event) => onHandleKeyDown(event, rule)}
                onPointerDown={(event) => onHandlePointerDown(event, rule)}
              >
                <GripVertical aria-hidden="true" />
              </IconButton>
            </div>
          </li>
        ))}
      </ul>

      <VisuallyHidden id={instructionsId}>{t('settings.filters.rule.reorderHint')}</VisuallyHidden>
      <VisuallyHidden aria-live="polite">{announcement}</VisuallyHidden>
    </>
  )
}
