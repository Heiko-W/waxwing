/**
 * Row swipe gestures on touch (M3.9, FR-LST-06) — the gesture, and nothing else.
 *
 * This module knows how a finger moves. It does not know what a swipe means: the caller resolves a
 * direction to an action ({@link RowSwipeOptions.resolve}) and performs it ({@link
 * RowSwipeOptions.commit}), so every gate that decides whether a swipe is allowed at all — the row is
 * hydrated, the source mailbox is known, the target is not the mailbox already on screen — lives with
 * the data, next to `useTriage`, and this file stays testable without a replica.
 *
 * ## Pointer events, not touch events — forced, not preferred
 * React 19 registers `touchstart`/`touchmove`/`wheel` as PASSIVE listeners, so an `onTouchMove`
 * handler could never `preventDefault`. Pointer events are not in that list. `pointerType` is also
 * the only touch/mouse discriminator that needs no stub in jsdom (`matchMedia` and
 * `navigator.maxTouchPoints` are both undefined there).
 *
 * The swipe is touch-only, but the drag is NOT mouse-only: ADR-012's original claim that HTML5 DnD
 * cannot start from touch is false, and was corrected on 2026-07-19 (Chrome-Android since Chrome 100,
 * iOS Safari via `UIDragInteraction`). Both gestures therefore live on the same node under the same
 * finger, and are separated by what the finger DOES — see {@link RowSwipe.isSwipeActive}.
 *
 * ## No `setPointerCapture` — ever
 * It does not exist in this jsdom (which is why `SplitPane`'s pointer drag is tested only by
 * keyboard: `fireEvent.pointerDown` on it throws). So `pointermove`/`pointerup`/`pointercancel` are
 * attached to `window` for the life of the gesture instead — the same imperative-listener shape
 * `useDismiss` uses for its document-level dismissers.
 *
 * ## Zero React state while the finger is down
 * A `setState` per `pointermove` would re-render `MessageList` and every virtual row at 60 Hz
 * (FR-LST-01, NFR-PERF-02). The gesture is driven imperatively instead: the `--swipe-x` custom
 * property, two `data-` flags and one class on the wrapper. React's style diff only writes the keys
 * present in its own style object, so all four survive a re-render untouched, and `transform`
 * changes no layout box — nothing a swipe does can feed back into the virtualiser.
 */

import type { Id } from '@waxwing/jmap'
import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef } from 'react'

/**
 * Movement that decides the axis. Fixed pixels, never a fraction of the row or of the viewport:
 * a px threshold is density-independent by construction (rows are 76/54 px), and a width-relative
 * one would be untestable — `getBoundingClientRect` is stubbed to a constant in the list tests.
 *
 * Exported with {@link SWIPE_COMMIT_PX} so tests derive their pointer distances from the thresholds
 * instead of restating them: a hardcoded fixture keeps passing after a threshold moves.
 */
export const SWIPE_SLOP_PX = 10

/** Displacement past which the lift commits. Under it, the row rubber-bands and nothing happens. */
export const SWIPE_COMMIT_PX = 96

export interface ResolvedSwipe {
  readonly kind: 'archive' | 'trash' | 'read'
  /** For `kind: 'read'`: the `$seen` value to write, resolved against the row's CURRENT state (D2). */
  readonly seen?: boolean
}

export interface RowSwipeOptions {
  /**
   * What this direction does on this row, or `null` if it does nothing — an unconfigured direction,
   * or a target mailbox the user is already looking at. `null` means genuinely inert: the row does
   * not follow the finger that way and no layer is revealed, so a suppressed direction is silent
   * rather than promising an action it will not perform.
   *
   * Called once per gesture, at the moment the axis locks, and its answer is what commits on lift.
   */
  readonly resolve: (id: Id, direction: 'left' | 'right') => ResolvedSwipe | null
  /** Perform the resolved action. Called at most once per gesture, on `pointerup` past the threshold. */
  readonly commit: (id: Id, resolved: ResolvedSwipe) => void
  /** Class marking "a finger is on this row" — the caller's CSS uses it to suppress the transition. */
  readonly swipingClassName: string
}

export interface RowSwipe {
  /** Bind to the row wrapper: `onPointerDown={swipe.onPointerDown(id)}`. Stable across renders. */
  readonly onPointerDown: (id: Id) => (event: ReactPointerEvent<HTMLElement>) => void
  /**
   * Whether a swipe has **locked horizontally** on this list and is following a finger. Read it from
   * `onDragStart` to cancel a drag that started on the same node (ADR-012, amended): one finger must
   * not move the row two ways at once.
   *
   * Deliberately NOT "a finger is down". A long press without movement is exactly how Chrome-Android
   * and iOS Safari enter a drag, and that gesture never locks an axis — so reporting `true` from the
   * first `pointerdown` would silently disable touch drag & drop altogether, which is the opposite of
   * the coexistence decision recorded in ADR-012. The two gestures divide cleanly: hold still and the
   * drag takes it, move sideways and the swipe does.
   */
  readonly isSwipeActive: () => boolean
}

interface Gesture {
  readonly id: Id
  readonly pointerId: number
  readonly wrap: HTMLElement
  readonly startX: number
  readonly startY: number
  /** Captured at pointerdown so the class that is removed is the one that was added. */
  readonly swipingClassName: string
  /** `null` until the axis lock resolves; the gesture only follows the finger once it is set. */
  direction: 'left' | 'right' | null
  resolved: ResolvedSwipe | null
  armed: boolean
  detach(): void
}

export function useRowSwipe(options: RowSwipeOptions): RowSwipe {
  const gestureRef = useRef<Gesture | null>(null)

  // The handlers below are stable, but must act on the CURRENT callbacks: `resolve` reads row state
  // that changes under the gesture, and neither callback can be a dependency without re-binding
  // `onPointerDown` on every render of the list.
  const optionsRef = useRef(options)
  useEffect(() => {
    optionsRef.current = options
  })

  const endGesture = useCallback((commit: boolean): void => {
    const gesture = gestureRef.current
    if (gesture === null) return
    // Cleared BEFORE anything else: a second `pointerup` — or a `pointercancel` chasing the lift —
    // must find no gesture, so an action can never fire twice for one finger.
    gestureRef.current = null
    gesture.detach()

    // Only a gesture that locked ever wrote to the row; one abandoned to the scroller leaves the
    // DOM exactly as it found it. Restore the resting position first, then act: the action may
    // unmount this row.
    if (gesture.direction !== null) {
      const { wrap } = gesture
      wrap.classList.remove(gesture.swipingClassName)
      wrap.style.setProperty('--swipe-x', '0px')
      wrap.dataset.swipeArmed = ''
      // `data-swipe` deliberately survives, but NOT for CSS: no selector reads it — the layer colours
      // come from classes React applies unconditionally. It is the e2e suite's only view of which
      // direction locked, and clearing it here would erase that just as the assertion runs. The next
      // axis lock overwrites it.
    }

    if (commit && gesture.armed && gesture.resolved !== null) {
      optionsRef.current.commit(gesture.id, gesture.resolved)
    }
  }, [])

  const onPointerDown = useCallback(
    (id: Id) =>
      (event: ReactPointerEvent<HTMLElement>): void => {
        // `pointerType` is the ONLY discriminator: a mouse or a pen never swipes a row, and a
        // second finger never joins one. This gate is one-directional — the drag side cannot make
        // the same check, because a `DragEvent` extends `MouseEvent` and has no `pointerType`.
        if (event.pointerType !== 'touch' || !event.isPrimary) return
        if (gestureRef.current !== null) return

        // Read synchronously: React nulls `currentTarget` the moment this handler returns.
        const wrap = event.currentTarget

        function detach(): void {
          window.removeEventListener('pointermove', onWindowPointerMove)
          window.removeEventListener('pointerup', onWindowPointerUp)
          window.removeEventListener('pointercancel', onWindowPointerCancel)
        }

        function onWindowPointerMove(moveEvent: PointerEvent): void {
          const gesture = gestureRef.current
          if (gesture === null || moveEvent.pointerId !== gesture.pointerId) return
          const dx = moveEvent.clientX - gesture.startX
          const dy = moveEvent.clientY - gesture.startY

          if (gesture.direction === null) {
            const absX = Math.abs(dx)
            const absY = Math.abs(dy)
            // A tie goes to the scroller: reading the list past a row is the far commoner intent,
            // and a gesture judged vertical is dead for good — it must not become a swipe halfway
            // down a fling. (In a real browser `touch-action: pan-y` has usually already handed
            // this to the compositor and fired `pointercancel` at us; this is the first few pixels,
            // and the whole mechanism in jsdom, where `touch-action` means nothing.)
            if (absY >= SWIPE_SLOP_PX && absY >= absX) {
              endGesture(false)
              return
            }
            if (absX < SWIPE_SLOP_PX || absX <= absY) return

            const direction = dx < 0 ? 'left' : 'right'
            const resolved = optionsRef.current.resolve(gesture.id, direction)
            if (resolved === null) {
              endGesture(false)
              return
            }
            gesture.direction = direction
            gesture.resolved = resolved
            gesture.wrap.dataset.swipe = direction
            gesture.wrap.classList.add(gesture.swipingClassName)
          }

          // Locked: `dy` is irrelevant from here, and so is the far side of the origin. Dragging
          // back past the start returns the row to rest rather than revealing the opposite action —
          // that direction was never resolved, and may well be one that is suppressed.
          const offset = gesture.direction === 'left' ? Math.min(dx, 0) : Math.max(dx, 0)
          gesture.armed = Math.abs(offset) >= SWIPE_COMMIT_PX
          gesture.wrap.style.setProperty('--swipe-x', `${offset}px`)
          gesture.wrap.dataset.swipeArmed = gesture.armed ? 'true' : ''
        }

        function onWindowPointerUp(upEvent: PointerEvent): void {
          if (upEvent.pointerId !== gestureRef.current?.pointerId) return
          endGesture(true)
        }

        function onWindowPointerCancel(cancelEvent: PointerEvent): void {
          if (cancelEvent.pointerId !== gestureRef.current?.pointerId) return
          // The browser has taken the pointer — it is scrolling, or the OS back-swipe claimed the
          // screen edge. Never commit on a gesture we no longer own; rubber-band and forget it.
          endGesture(false)
        }

        gestureRef.current = {
          id,
          pointerId: event.pointerId,
          wrap,
          startX: event.clientX,
          startY: event.clientY,
          swipingClassName: optionsRef.current.swipingClassName,
          direction: null,
          resolved: null,
          armed: false,
          detach,
        }

        // Not `setPointerCapture` (see the header): without capture the rest of the gesture is only
        // reachable on `window`, and it must be — a finger that leaves the row still owns the swipe.
        window.addEventListener('pointermove', onWindowPointerMove)
        window.addEventListener('pointerup', onWindowPointerUp)
        window.addEventListener('pointercancel', onWindowPointerCancel)
      },
    [endGesture],
  )

  // Unmounting the LIST mid-gesture — this hook runs once per `MessageList`, not once per row — would
  // otherwise leave three window listeners behind, and a later `pointerup` would call `commit` from a
  // dead tree. This says nothing about a single row unmounting under the finger (the list re-windows,
  // or the action removes it): no cleanup runs for that at all. It needs none — the listeners live on
  // `window`, the gesture keeps writing to a detached node where nothing can see it, and the lift
  // still reaches `endGesture`, which detaches and commits by id.
  useEffect(() => {
    return () => {
      gestureRef.current?.detach()
      gestureRef.current = null
    }
  }, [])

  // `direction !== null`, not `gesture !== null`: see the doc on RowSwipe.isSwipeActive. A pointer
  // that is merely down has not committed to being a swipe yet, and a long press must stay free to
  // become a drag.
  const isSwipeActive = useCallback((): boolean => gestureRef.current?.direction != null, [])

  return { onPointerDown, isSwipeActive }
}
