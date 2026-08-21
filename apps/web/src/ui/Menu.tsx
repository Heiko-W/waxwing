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
  /** Trigger `tabIndex`, e.g. to make the button part of a parent roving-focus widget (APG tree). */
  triggerTabIndex?: number
  /**
   * Drop the trigger's border and fill, matching `IconButton`'s ghost variant.
   *
   * For menus that sit INSIDE a list row rather than beside content. The folder tree reveals its
   * per-row menu on hover, which is right — but touch has no hover, so the fallback shows all of
   * them at once, and with the default bordered trigger that turned the drawer into a column of six
   * identical framed tiles, visually louder than the folder names they belong to.
   *
   * `'toolbar'` is the third case: a trigger standing among ghost IconButtons in an action bar. It
   * differs from `'ghost'` only in keeping `--waxwing-text`, because a dimmed `⋯` beside glyphs
   * that are not dimmed reads as disabled.
   */
  triggerVariant?: 'default' | 'ghost' | 'toolbar'
}

/** The gap between trigger and menu, in px — matches the 4px this has always used. */
const MENU_GAP = 4

/**
 * A rough menu height, for deciding whether one fits below its trigger. Deliberately an estimate:
 * measuring would mean rendering the menu first and moving it afterwards, which is a visible jump.
 * Roughly six items plus padding — enough that a genuinely cramped position is recognised.
 */
const MENU_ESTIMATED_BLOCK = 240

/**
 * Menu button (APG menu-button pattern). The trigger carries `aria-haspopup`/`aria-expanded`;
 * the popup is a `role="menu"` of `role="menuitem"`s with roving focus. Keyboard: Down/Up to
 * open and move, Home/End to the ends, type-ahead to jump, Enter/Space to activate, Escape or
 * an outside press to close. Focus returns to the trigger on close, always.
 */
export function Menu({
  triggerLabel,
  trigger,
  items,
  align = 'start',
  className,
  triggerTabIndex,
  triggerVariant = 'default',
}: MenuProps) {
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
  const [coords, setCoords] = useState({ top: 0, left: 0, flipped: false })
  const [focusedIndex, setFocusedIndex] = useState(-1)

  /** Whether the menu reserves an icon column at all — see the note at the render site. */
  const anyIcon = items.some((item) => item.icon !== undefined)
  const firstEnabled = items.findIndex((item) => !item.disabled)
  const lastEnabled = items.reduce((last, item, index) => (item.disabled ? last : index), -1)

  const openMenu = useCallback(
    (toIndex: number) => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (rect) {
        // NOTE (FR-I18N-02): start/end here resolve to physical left/right, which is correct
        // for the LTR locales V1 ships (en, de). When an RTL locale is added, mirror this
        // against the trigger's writing direction.
        //
        // FLIPPED UPWARD when there is no room below. The position was computed from the trigger
        // alone and never consulted the viewport, so a menu opened near the bottom of the window —
        // the last folder in the rail, a row action on a short screen — was drawn past the edge with
        // its items unreachable by pointer. The menu is `position: fixed`, so viewport coordinates
        // are the frame to reason in.
        //
        // An ESTIMATE rather than a measurement, deliberately: measuring means rendering first and
        // moving afterwards, which is a visible jump. The estimate only has to answer "is there
        // obviously not enough room", and the flip is additionally gated on the space above being
        // larger — so a short menu in a short window stays where it was.
        const below = window.innerHeight - rect.bottom
        const flip = below < MENU_ESTIMATED_BLOCK && rect.top > below
        setCoords({
          top: flip ? rect.top - MENU_GAP : rect.bottom + MENU_GAP,
          left: align === 'end' ? rect.right : rect.left,
          flipped: flip,
        })
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
        {...(triggerTabIndex === undefined ? {} : { tabIndex: triggerTabIndex })}
        className={cx(
          styles.trigger,
          triggerVariant === 'ghost' && styles.triggerGhost,
          triggerVariant === 'toolbar' && styles.triggerToolbar,
          className,
        )}
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
            className={cx(
              styles.menu,
              align === 'end' && styles.alignEnd,
              coords.flipped && styles.flipped,
            )}
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
                  {/* One text edge for the whole menu. The folder menu carries an icon on exactly
                      one of its seven entries ("Keep offline"), which indented that entry's label
                      past the other six — a menu with two left edges, and the single glyph pulling
                      the eye to the least important row. Reserving the column where ANY entry uses
                      it costs nothing and removes the choice between "an icon on all seven" and
                      "no icons at all". */}
                  {anyIcon ? (
                    <span className={styles.iconSlot}>
                      {Icon ? <Icon aria-hidden="true" className={styles.icon} /> : null}
                    </span>
                  ) : null}
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
