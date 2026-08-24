import type { LucideIcon } from 'lucide-react'
import {
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
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
  /**
   * Which band of the menu this item belongs to. Items sharing a value are drawn together and a
   * separator is placed wherever the value changes (HIG `menus`: "Consider grouping logically
   * related items. … To help people visually distinguish such groups, use a separator").
   *
   * A string rather than a boolean "startsGroup", so the grouping survives an item being filtered
   * out by a permission — which is the normal case here: the folder menu builds itself from up to
   * ten rights and any of them can be absent. With a "starts a group" flag, dropping the first
   * item of a band silently moves the separator onto the wrong row.
   *
   * Items with no group come first, ungrouped — an existing menu keeps its exact shape.
   */
  group?: string
}

/** The imperative surface of {@link Menu}. */
export interface MenuHandle {
  /** Open the popup at a viewport point, focusing its first enabled item. */
  openAt(x: number, y: number): void
}

export interface MenuProps {
  /** Accessible name for the trigger button. */
  triggerLabel: string
  /**
   * Visible trigger content (icon and/or text).
   *
   * `null` renders no button at all — the popup then belongs entirely to {@link contextTarget}, and
   * the menu is reached by a secondary click. Every command in such a menu must also exist in the
   * main interface (HIG `context-menus`: "Always make context menu items available in the main
   * interface, too"), because a menu with no visible affordance is a menu nobody discovers.
   */
  trigger: ReactNode | null
  /**
   * Also open this menu on a secondary click (right-click, two-finger tap, Shift+F10 / the menu
   * key) anywhere inside this element.
   *
   * `onContextMenu` did not appear once in the source tree before this. HIG `pointing-devices` lists
   * secondary click as "Reveal contextual menus" for both macOS pointer devices, and `context-menus`
   * uses a Mail message in the Inbox as its worked example.
   */
  contextTarget?: RefObject<HTMLElement | null> | (() => HTMLElement | null)
  /**
   * Open the popup at a point, from the outside.
   *
   * For a list whose rows share ONE menu: the row under the pointer decides what the items are, so
   * the caller has to set that first and open in the effect that follows. Subscribing a listener
   * per row instead would mean one live-query subscription per visible row for the rights each item
   * gates on — see the note in MessageList.
   */
  ref?: Ref<MenuHandle>
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
 * How tall this menu wants to be, for deciding whether it fits below its trigger.
 *
 * Still an estimate — measuring means rendering first and moving afterwards, which is a visible
 * jump — but an estimate that COUNTS THE ITEMS rather than assuming six. The fixed 240px it replaces
 * was written when the longest menu in the app was five entries; the folder-actions menu now carries
 * nine, and measured 406px on a 390 × 844 phone. With 279px of room below the trigger the flip
 * therefore declined to fire, and the menu ran 131px past the bottom of the screen with "Folder
 * info…" and "Share…" — both added this round — off the edge and unreachable.
 *
 * 44 is `--waxwing-control-min` at its touch value, which is what `.item`'s `min-block-size`
 * resolves to on the viewport where this matters. Overestimating on a pointer device is harmless:
 * it only makes the menu flip a little sooner.
 */
const MENU_ROW_BLOCK = 44
/** `.menu`'s own padding, both edges (`--waxwing-space-1` × 2). */
const MENU_PADDING_BLOCK = 8
/** A group separator: 1px rule plus `--waxwing-space-1` above and below. */
const MENU_SEPARATOR_BLOCK = 9

/**
 * Separators count. They are the reason the estimate exists at all — it was written after a
 * nine-item folder menu ran 131 px off the bottom of a phone because the old constant assumed six
 * items, and adding two rules to that same menu without counting them would put the estimate 18 px
 * back under the truth.
 */
function estimatedBlock(items: readonly MenuItemSpec[]): number {
  const separators = items.filter(
    (item, index) => index > 0 && items[index - 1]?.group !== item.group,
  ).length
  return items.length * MENU_ROW_BLOCK + separators * MENU_SEPARATOR_BLOCK + MENU_PADDING_BLOCK
}

/**
 * Menu button (APG menu-button pattern). The trigger carries `aria-haspopup`/`aria-expanded`;
 * the popup is a `role="menu"` of `role="menuitem"`s with roving focus. Keyboard: Down/Up to
 * open and move, Home/End to the ends, type-ahead to jump, Enter/Space to activate, Escape or
 * an outside press to close. Focus returns to the trigger on close, always.
 */
export function Menu({
  triggerLabel,
  trigger,
  contextTarget,
  items,
  align = 'start',
  className,
  triggerTabIndex,
  triggerVariant = 'default',
  ref,
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
  const [coords, setCoords] = useState({ top: 0, left: 0, flipped: false, maxBlock: 0 })
  const [focusedIndex, setFocusedIndex] = useState(-1)

  /** Whether the menu reserves an icon column at all — see the note at the render site. */
  const anyIcon = items.some((item) => item.icon !== undefined)
  /** How tall this menu will be, separators included — the input to the flip decision below. */
  const menuBlock = estimatedBlock(items)
  const firstEnabled = items.findIndex((item) => !item.disabled)
  const lastEnabled = items.reduce((last, item, index) => (item.disabled ? last : index), -1)

  /**
   * Open at a POINT rather than against the trigger — the context-menu path.
   *
   * Same flip and ceiling logic as below, with a 1x1 rect standing in for the trigger, so a menu
   * summoned near the bottom of the window behaves exactly like one opened from a button there.
   */
  const openAt = useCallback(
    (x: number, y: number, toIndex: number) => {
      const below = window.innerHeight - y - MENU_GAP
      const above = y - MENU_GAP
      const flip = menuBlock > below && above > below
      setCoords({
        top: flip ? y - MENU_GAP : y + MENU_GAP,
        left: x,
        flipped: flip,
        maxBlock: Math.max(flip ? above : below, 0),
      })
      setFocusedIndex(toIndex)
      setOpen(true)
    },
    [menuBlock],
  )

  useImperativeHandle(ref, () => ({ openAt: (x, y) => openAt(x, y, firstEnabled) }), [
    openAt,
    firstEnabled,
  ])

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
        //
        // And then a CEILING, which the flip alone never was. Flipping picks the roomier side; it
        // does not make a menu that is taller than BOTH sides fit into either. Nine items is 406px,
        // and half of a 844px phone is less than that whichever way it opens — so the chosen side's
        // room is handed to the menu as a maximum and `.menu` scrolls inside it. That is what makes
        // the last item reachable at any item count, rather than at the ones we thought to check.
        const below = window.innerHeight - rect.bottom - MENU_GAP
        const above = rect.top - MENU_GAP
        const flip = menuBlock > below && above > below
        setCoords({
          top: flip ? rect.top - MENU_GAP : rect.bottom + MENU_GAP,
          left: align === 'end' ? rect.right : rect.left,
          flipped: flip,
          maxBlock: Math.max(flip ? above : below, 0),
        })
      }
      setFocusedIndex(toIndex)
      setOpen(true)
    },
    // `menuBlock`, not `items`: a caller that rebuilds its array every render would otherwise
    // rebuild this callback every render too, and the only thing the position depends on is how
    // TALL the menu will be. It replaces `items.length`, which stopped being the whole answer once
    // group separators started adding height of their own.
    [align, menuBlock],
  )

  const close = useCallback(() => {
    setOpen(false)
    // Back where it came from: the trigger when there is one, otherwise the row that was
    // right-clicked — closing a menu must never drop focus to <body>, which sends the next Tab to
    // the top of the document (WCAG 2.4.3).
    const restore =
      triggerRef.current ??
      (typeof contextTarget === 'function' ? contextTarget() : contextTarget?.current)
    restore?.focus()
  }, [contextTarget])

  /*
   * The secondary-click seam.
   *
   * `preventDefault()` is the deliberate part: the browser's own menu is suppressed here, so this
   * one must carry the two entries a reader can lose by that ("open in a new tab", "copy link") if
   * the target has a URL — the callers that pass those do. Shift+right-click is let through
   * untouched, which is the platform's own escape hatch back to the browser menu.
   *
   * Shift+F10 and the Menu key are the keyboard equivalents and are dispatched by the browser as a
   * `contextmenu` event on the focused element, so they arrive here for free — a keyboard user gets
   * the same commands, which is what makes this an addition rather than a pointer-only shortcut.
   */
  useEffect(() => {
    // A ref OR a getter. The getter form exists for rows built in a `.map()`, where a per-row
    // `useRef` is not available and the element lives in the list's own ref map.
    const node = typeof contextTarget === 'function' ? contextTarget() : contextTarget?.current
    if (!node) return
    const onContextMenu = (event: MouseEvent): void => {
      if (event.shiftKey) return
      event.preventDefault()
      // A keyboard-raised menu reports (0, 0) or the element's corner; anchor those to the element
      // rather than to the top-left of the window.
      const point =
        event.clientX === 0 && event.clientY === 0
          ? (() => {
              const rect = node.getBoundingClientRect()
              return { x: rect.left, y: rect.bottom }
            })()
          : { x: event.clientX, y: event.clientY }
      openAt(point.x, point.y, firstEnabled)
    }
    node.addEventListener('contextmenu', onContextMenu)
    return () => node.removeEventListener('contextmenu', onContextMenu)
  }, [contextTarget, openAt, firstEnabled])

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
      {trigger === null ? null : (
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
      )}
      {open ? (
        <Portal>
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            {...(trigger === null
              ? { 'aria-label': triggerLabel }
              : { 'aria-labelledby': triggerId })}
            className={cx(
              styles.menu,
              align === 'end' && styles.alignEnd,
              coords.flipped && styles.flipped,
            )}
            // `maxBlockSize` is the room on whichever side the menu opened to; `.menu` scrolls
            // inside it. Inline rather than in the stylesheet because the number is the viewport's,
            // not the design's. Zero means the rect was never read (jsdom, or a trigger that has
            // not laid out), and no ceiling is the right answer there.
            style={{
              position: 'fixed',
              top: coords.top,
              left: coords.left,
              ...(coords.maxBlock > 0 ? { maxBlockSize: coords.maxBlock } : {}),
            }}
            onKeyDown={onMenuKeyDown}
          >
            {items.map((item, index) => {
              const Icon = item.icon
              // A boundary between two bands, drawn before the first item of the new one. `index > 0`
              // keeps a leading separator off the top of the menu when the first band is empty.
              const startsGroup = index > 0 && items[index - 1]?.group !== item.group
              return (
                <Fragment key={item.id}>
                  {/* An `<hr>`, not a `div[role=separator]`: the implicit role is the same one, and
                      a separator with a ROLE attribute reads as the focusable window-splitter kind
                      (which is what SplitPane draws). This one is a divider and takes no focus. */}
                  {startsGroup ? <hr className={styles.separator} /> : null}
                  <button
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
                    {/* One text edge for the whole menu: reserve the icon column as soon as ANY entry
                      uses one, so a single glyph cannot indent its own label past every other.

                      This was written when the folder menu carried an icon on two of its ten
                      entries. HIG `menus` asks for the other answer — "provide icons for all menu
                      items in a group, or none of them" — and for that menu "none" was the
                      honest one, because Rename, Folder info and "Delete older than…" have no
                      symbol that means them. The reservation stays: it is what keeps a menu that
                      DOES use icons from having two left edges, and it is what makes "none" a
                      choice about meaning rather than about alignment. */}
                    {anyIcon ? (
                      <span className={styles.iconSlot}>
                        {Icon ? <Icon aria-hidden="true" className={styles.icon} /> : null}
                      </span>
                    ) : null}
                    <span className={styles.itemLabel}>{item.label}</span>
                  </button>
                </Fragment>
              )
            })}
          </div>
        </Portal>
      ) : null}
    </>
  )
}
