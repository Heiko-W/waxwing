import { type RefObject, useEffect } from 'react'
import { getFocusableElements } from './focusables'

interface FocusTrapOptions {
  /** Element to focus when the trap activates. Defaults to the first focusable, else the container. */
  initialFocusRef?: RefObject<HTMLElement | null> | undefined
}

/**
 * Confine keyboard focus to `containerRef` while `active` (APG modal-dialog pattern).
 *
 * On activation it records the previously focused element, moves focus inside, and wraps
 * Tab/Shift+Tab at the ends. On deactivation it restores focus to where it was — so
 * closing a dialog returns the user to the control that opened it. The container should
 * carry `tabIndex={-1}` so it can receive focus when it holds no focusable children.
 *
 * Escape-to-close is intentionally NOT handled here: the owning component decides dismissal
 * (see useDismiss), keeping this hook a pure focus concern.
 */
export function useFocusTrap(
  active: boolean,
  containerRef: RefObject<HTMLElement | null>,
  options: FocusTrapOptions = {},
): void {
  const { initialFocusRef } = options

  useEffect(() => {
    if (!active) return
    const container = containerRef.current
    if (!container) return

    const previouslyFocused = document.activeElement as HTMLElement | null

    const initial = initialFocusRef?.current ?? getFocusableElements(container)[0] ?? container
    initial.focus()

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Tab') return
      const focusables = getFocusableElements(container as HTMLElement)
      if (focusables.length === 0) {
        event.preventDefault()
        ;(container as HTMLElement).focus()
        return
      }
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (!first || !last) return
      const activeEl = document.activeElement
      const outside = !(container as HTMLElement).contains(activeEl)
      if (event.shiftKey) {
        if (activeEl === first || outside) {
          event.preventDefault()
          last.focus()
        }
      } else if (activeEl === last || outside) {
        event.preventDefault()
        first.focus()
      }
    }

    container.addEventListener('keydown', onKeyDown)
    return () => {
      container.removeEventListener('keydown', onKeyDown)
      // Restore focus only if it is still inside the (now-closing) container, so we do not
      // yank focus away from wherever the app deliberately moved it.
      if (container.contains(document.activeElement) || document.activeElement === document.body) {
        previouslyFocused?.focus?.()
      }
    }
  }, [active, containerRef, initialFocusRef])
}
