/**
 * The APG toolbar keyboard model, over whatever controls the container happens to render (B20.2).
 *
 * `role="toolbar"` is a PROMISE: a screen reader announces "toolbar", and the reader then expects
 * one tab stop with arrow keys inside it. A container that declares the role and implements none of
 * the model is worse than a plain `<div>` — the announcement teaches a navigation that does not
 * work, and eleven separate tab stops stand between the reader and whatever follows.
 *
 * **Why it works off the DOM rather than a ref array.** The reading-pane action bar renders icon
 * buttons, a text button, a popover anchor and a `Menu` whose trigger this file cannot reach with a
 * ref. Threading refs through all of them would mean changing four components to serve one hook,
 * and every control added later would silently opt out of the toolbar by forgetting one. A query
 * for the focusable controls inside the container cannot be forgotten, and it is what makes the
 * hook usable from a call site that does not own its children.
 *
 * **Disabled controls.** APG recommends keeping disabled toolbar controls reachable so their
 * existence and their state stay discoverable, and this app already does that where it matters:
 * `IconButton`'s `unavailableReason` marks a control `aria-disabled` and leaves it focusable, so a
 * screen reader can say WHY it cannot be used (B34). Those are included here. A control with the
 * native `disabled` attribute is not — the platform refuses it focus, so an index pointing at one
 * would leave the arrow key doing visibly nothing.
 */

import { type KeyboardEvent, type RefObject, useCallback, useEffect, useRef } from 'react'

/**
 * Focusable controls, in DOM order — the order the arrow keys walk. `:not(:disabled)` is not
 * decoration: `HTMLElement.focus()` on a natively disabled control is a no-op, so including one
 * would make a single arrow press appear to do nothing at all.
 */
const CONTROLS = [
  'button:not(:disabled)',
  '[role="button"]:not([aria-disabled="true"])',
  'a[href]',
  'input:not(:disabled)',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
].join(', ')

export interface ToolbarRoving<T extends HTMLElement> {
  /** Attach to the element carrying `role="toolbar"`. */
  readonly ref: RefObject<T | null>
  /** Spread on the same element. */
  readonly containerProps: {
    readonly onKeyDown: (event: KeyboardEvent<T>) => void
    readonly onFocus: (event: React.FocusEvent<T>) => void
  }
}

export function useToolbarRoving<T extends HTMLElement>(): ToolbarRoving<T> {
  const ref = useRef<T>(null)
  // Which control is the tab stop. Held in a ref, not state: nothing renders from it — the tabIndex
  // attributes are written directly — so making it state would re-render the whole toolbar on every
  // arrow press for no visible change.
  const activeRef = useRef(0)

  const controls = useCallback(
    (): HTMLElement[] => [...(ref.current?.querySelectorAll<HTMLElement>(CONTROLS) ?? [])],
    [],
  )

  /** Exactly one control tabbable, everything else reachable only by arrow. */
  const apply = useCallback(
    (index: number) => {
      const items = controls()
      if (items.length === 0) return
      const clamped = (index + items.length) % items.length
      activeRef.current = clamped
      items.forEach((item, i) => {
        item.tabIndex = i === clamped ? 0 : -1
      })
    },
    [controls],
  )

  // Re-apply after every render: the action bar adds and removes controls (Move to… is gated by a
  // right, the overflow menu by its item list), and a control rendered fresh carries no tabIndex —
  // so it would be tabbable alongside the real tab stop, quietly giving the toolbar two.
  useEffect(() => {
    apply(activeRef.current)
  })

  const move = useCallback(
    (index: number) => {
      apply(index)
      controls()[activeRef.current]?.focus()
    },
    [apply, controls],
  )

  const onKeyDown = useCallback(
    (event: KeyboardEvent<T>) => {
      // A chord belongs to the app, not the toolbar: ⌘←/⌥← are word/line motion and browser Back.
      if (event.metaKey || event.ctrlKey || event.altKey) return
      switch (event.key) {
        case 'ArrowRight':
          event.preventDefault()
          move(activeRef.current + 1)
          break
        case 'ArrowLeft':
          event.preventDefault()
          move(activeRef.current - 1)
          break
        case 'Home':
          event.preventDefault()
          move(0)
          break
        case 'End':
          event.preventDefault()
          move(controls().length - 1)
          break
        default:
          break
      }
    },
    [move, controls],
  )

  // A pointer click focuses a control directly, bypassing the arrow keys. Without this the roving
  // index and the actual focus disagree from that moment on: the next arrow press jumps back to
  // wherever the index had been left, which reads as the toolbar losing the user's place.
  const onFocus = useCallback(
    (event: React.FocusEvent<T>) => {
      const index = controls().indexOf(event.target as HTMLElement)
      if (index >= 0) apply(index)
    },
    [apply, controls],
  )

  return { ref, containerProps: { onKeyDown, onFocus } }
}
