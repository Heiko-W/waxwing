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
 * Shared LIFO stack of active Escape dismissers. Only the top-most (most recently opened)
 * overlay responds to Escape, so a single press closes exactly the innermost layer — a Menu
 * opened inside a Dialog closes the Menu, leaving the Dialog open. This CANNOT be done with a
 * per-instance listener + stopPropagation: `stopPropagation` does not stop sibling listeners
 * on the same node (document), and same-node listeners fire in registration order (outermost
 * first). A single coordinator dispatching to the top of the stack is the correct model.
 */
const escapeStack: { dismiss: () => void }[] = []
let escapeListenerAttached = false

function onDocumentEscape(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  const top = escapeStack[escapeStack.length - 1]
  if (!top) return
  event.stopPropagation()
  top.dismiss()
}

function ensureEscapeListener(): void {
  if (escapeListenerAttached) return
  document.addEventListener('keydown', onDocumentEscape, true)
  escapeListenerAttached = true
}

/**
 * Dismiss an open popover/menu on Escape and/or an outside pointer press (APG dismissal
 * behaviour). Escape goes through the shared stack above (innermost-only). The outside-pointer
 * listener is per-instance (each layer decides "outside" against its own ref), attached in the
 * capture phase so it survives inner `stopPropagation`.
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
    if (!active || !closeOnEscape) return
    const entry = { dismiss: onDismiss }
    escapeStack.push(entry)
    ensureEscapeListener()
    return () => {
      const index = escapeStack.indexOf(entry)
      if (index !== -1) escapeStack.splice(index, 1)
    }
  }, [active, closeOnEscape, onDismiss])

  useEffect(() => {
    if (!active || !outsidePointer) return

    function onPointerDown(event: PointerEvent): void {
      const target = event.target as Node | null
      if (!target) return
      const inside =
        ref.current?.contains(target) || extraRefs?.some((extra) => extra.current?.contains(target))
      if (!inside) onDismiss()
    }

    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [active, outsidePointer, ref, onDismiss, extraRefs])
}
