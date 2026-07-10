import type { LucideIcon } from 'lucide-react'
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import { cx } from './internal/cx'
import { Portal } from './internal/Portal'
import { useDismiss } from './internal/useDismiss'
import styles from './Menu.module.css'

export interface MenuItemSpec {
  id: string
  label: string
  icon?: LucideIcon
  onSelect: () => void
  disabled?: boolean
  destructive?: boolean
}

export interface MenuProps {
  /** Accessible name for the trigger button. */
  triggerLabel: string
  /** Visible trigger content (icon and/or text). */
  trigger: ReactNode
  items: MenuItemSpec[]
  /** Which trigger edge the menu aligns to. Default 'start'. */
  align?: 'start' | 'end'
  className?: string
}

/**
 * Menu button (APG menu-button pattern). The trigger carries `aria-haspopup`/`aria-expanded`;
 * the popup is a `role="menu"` of `role="menuitem"`s with roving focus. Keyboard: Down/Up to
 * open and move, Home/End to the ends, type-ahead to jump, Enter/Space to activate, Escape or
 * an outside press to close. Focus returns to the trigger on close, always.
 */
export function Menu({ triggerLabel, trigger, items, align = 'start', className }: MenuProps) {
  const triggerId = useId()
  const menuId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const typeahead = useRef<{ buffer: string; timer: ReturnType<typeof setTimeout> | undefined }>({
    buffer: '',
    timer: undefined,
  })

  const [open, setOpen] = useState(false)
  const [coords, setCoords] = useState({ top: 0, left: 0 })
  const [focusedIndex, setFocusedIndex] = useState(-1)

  const firstEnabled = items.findIndex((item) => !item.disabled)
  const lastEnabled = items.reduce((last, item, index) => (item.disabled ? last : index), -1)

  const openMenu = useCallback(
    (toIndex: number) => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (rect) {
        // NOTE (FR-I18N-02): start/end here resolve to physical left/right, which is correct
        // for the LTR locales V1 ships (en, de). When an RTL locale is added, mirror this
        // against the trigger's writing direction.
        setCoords({ top: rect.bottom + 4, left: align === 'end' ? rect.right : rect.left })
      }
      setFocusedIndex(toIndex)
      setOpen(true)
    },
    [align],
  )

  const close = useCallback(() => {
    setOpen(false)
    triggerRef.current?.focus()
  }, [])

  // Move focus to the newly-focused menu item after it renders.
  useEffect(() => {
    if (open && focusedIndex >= 0) itemRefs.current[focusedIndex]?.focus()
  }, [open, focusedIndex])

  useDismiss(open, menuRef, close, {
    escape: true,
    outsidePointer: true,
    extraRefs: [triggerRef],
  })

  function activate(index: number): void {
    const item = items[index]
    if (!item || item.disabled) return
    setOpen(false)
    triggerRef.current?.focus()
    item.onSelect()
  }

  function moveFocus(delta: number): void {
    const count = items.length
    if (count === 0) return
    let index = focusedIndex
    for (let step = 0; step < count; step++) {
      index = (index + delta + count) % count
      if (!items[index]?.disabled) {
        setFocusedIndex(index)
        return
      }
    }
  }

  function onTypeahead(char: string): void {
    if (typeahead.current.timer) clearTimeout(typeahead.current.timer)
    const lower = char.toLowerCase()
    // Repeating the same single character cycles through items starting with it (APG); any
    // other key extends the search buffer to narrow within the timeout window.
    const isRepeat = typeahead.current.buffer === lower
    typeahead.current.buffer = isRepeat ? lower : typeahead.current.buffer + lower
    const { buffer } = typeahead.current
    // On a repeat, search strictly after the current item so focus advances; when narrowing,
    // include the current item so a longer prefix can still match where focus already is.
    const startOffset = isRepeat ? 1 : 0
    for (let step = 0; step < items.length; step++) {
      const index = (Math.max(focusedIndex, 0) + startOffset + step) % items.length
      const item = items[index]
      if (item && !item.disabled && item.label.toLowerCase().startsWith(buffer)) {
        setFocusedIndex(index)
        break
      }
    }
    typeahead.current.timer = setTimeout(() => {
      typeahead.current.buffer = ''
    }, 500)
  }

  function onTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      openMenu(firstEnabled)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      openMenu(lastEnabled)
    }
  }

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        moveFocus(1)
        break
      case 'ArrowUp':
        event.preventDefault()
        moveFocus(-1)
        break
      case 'Home':
        event.preventDefault()
        setFocusedIndex(firstEnabled)
        break
      case 'End':
        event.preventDefault()
        setFocusedIndex(lastEnabled)
        break
      case 'Enter':
      case ' ':
        event.preventDefault()
        activate(focusedIndex)
        break
      case 'Tab':
        close()
        break
      default:
        if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
          onTypeahead(event.key)
        }
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        aria-label={triggerLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        className={cx(styles.trigger, className)}
        onClick={() => (open ? close() : openMenu(firstEnabled))}
        onKeyDown={onTriggerKeyDown}
      >
        {trigger}
      </button>
      {open ? (
        <Portal>
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-labelledby={triggerId}
            className={cx(styles.menu, align === 'end' && styles.alignEnd)}
            style={{ position: 'fixed', top: coords.top, left: coords.left }}
            onKeyDown={onMenuKeyDown}
          >
            {items.map((item, index) => {
              const Icon = item.icon
              return (
                <button
                  key={item.id}
                  ref={(node) => {
                    itemRefs.current[index] = node
                  }}
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  // aria-disabled (not native `disabled`) so the item stays perceivable to a
                  // screen reader; activate() is a no-op for it and roving focus skips it.
                  aria-disabled={item.disabled || undefined}
                  className={cx(styles.item, item.destructive && styles.destructive)}
                  onClick={() => activate(index)}
                >
                  {Icon ? <Icon aria-hidden="true" className={styles.icon} /> : null}
                  <span className={styles.itemLabel}>{item.label}</span>
                </button>
              )
            })}
          </div>
        </Portal>
      ) : null}
    </>
  )
}
