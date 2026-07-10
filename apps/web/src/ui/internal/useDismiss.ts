import { type RefObject, useEffect } from 'react'

interface DismissOptions {
  /** Close on Escape. Default true. */
  escape?: boolean
  /** Close on a pointer press outside the ref(s). Default true. */
  outsidePointer?: boolean
  /** Additional elements (e.g. the trigger) that count as "inside" for outside-press. */
  extraRefs?: RefObject<HTMLElement | null>[]
}

/**
 * Dismiss an open popover/menu on Escape and/or an outside pointer press (APG dismissal
 * behaviour). Listeners are attached in the capture phase so a dismissal is detected even
 * when inner handlers stop propagation; Escape's own event is stopped so a single press
 * closes only the innermost layer.
 *
 * `onDismiss` should be stable (wrap in useCallback) — it is a dependency, so an unstable
 * reference re-subscribes the listeners on every render.
 */
export function useDismiss(
  active: boolean,
  ref: RefObject<HTMLElement | null>,
  onDismiss: () => void,
  options: DismissOptions = {},
): void {
  const { escape: closeOnEscape = true, outsidePointer = true, extraRefs } = options

  useEffect(() => {
    if (!active) return

    function onKeyDown(event: KeyboardEvent): void {
      if (closeOnEscape && event.key === 'Escape') {
        event.stopPropagation()
        onDismiss()
      }
    }

    function onPointerDown(event: PointerEvent): void {
      if (!outsidePointer) return
      const target = event.target as Node | null
      if (!target) return
      const inside =
        ref.current?.contains(target) || extraRefs?.some((extra) => extra.current?.contains(target))
      if (!inside) onDismiss()
    }

    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [active, ref, onDismiss, closeOnEscape, outsidePointer, extraRefs])
}
