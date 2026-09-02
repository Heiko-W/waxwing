import { type RefObject, useEffect, useLayoutEffect, useRef } from 'react'
import { isComposingKey } from './composition'

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
  // IME first, exactly as the chord dispatcher does it (R-40). Escape ENDS a composition; taking it
  // here closes the dialog the reader is typing into instead — and with `confirmDiscard` on, asks
  // them whether to discard the text the IME was still holding.
  if (isComposingKey(event)) return
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
 * `onDismiss` may be a fresh closure on every render. It used to have to be memoised, and that was
 * never a contract a caller could be expected to keep: eighteen `<Dialog>` sites pass an inline
 * arrow, so a re-render of the page — a liveQuery tick, a sync-status change — ran this effect's
 * cleanup and body again and moved the DIALOG's stack entry ABOVE the menu opened inside it. One
 * Escape then closed the whole sheet instead of the menu (R-39). Passive effects run child-first,
 * so the dialog landed on top even when both re-registered in the same commit.
 *
 * So the stack entry is bound to the LAYER (`active`, `closeOnEscape`) and the callback is read
 * through a ref at dismiss time — the same `useLayoutEffect(() => { ref.current = … })` trick
 * `ShortcutProvider` plays on its own listener, and for the same reason: the position in the stack
 * is a fact about which overlay is innermost, not about which closure is current.
 */
export function useDismiss(
  active: boolean,
  ref: RefObject<HTMLElement | null>,
  onDismiss: () => void,
  options: DismissOptions = {},
): void {
  const { escape: closeOnEscape = true, outsidePointer = true, extraRefs } = options

  // `useLayoutEffect`, not `useEffect`: both listeners are native and can fire between the commit
  // and a passive effect, and a dismiss that ran the PREVIOUS render's closure would act on state
  // the reader can no longer see.
  const dismissRef = useRef(onDismiss)
  useLayoutEffect(() => {
    dismissRef.current = onDismiss
  })

  useEffect(() => {
    if (!active || !closeOnEscape) return
    const entry = { dismiss: () => dismissRef.current() }
    escapeStack.push(entry)
    ensureEscapeListener()
    return () => {
      const index = escapeStack.indexOf(entry)
      if (index !== -1) escapeStack.splice(index, 1)
    }
  }, [active, closeOnEscape])

  useEffect(() => {
    if (!active || !outsidePointer) return

    function onPointerDown(event: PointerEvent): void {
      const target = event.target as Node | null
      if (!target) return
      const inside =
        ref.current?.contains(target) || extraRefs?.some((extra) => extra.current?.contains(target))
      if (!inside) dismissRef.current()
    }

    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [active, outsidePointer, ref, extraRefs])
}
