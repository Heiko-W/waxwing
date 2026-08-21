import { act, createEvent, fireEvent, render, screen } from '@testing-library/react'
import type { Id } from '@waxwing/jmap'
import { useLayoutEffect, useRef, useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type ResolvedSwipe,
  type RowSwipe,
  SWIPE_COMMIT_PX,
  SWIPE_SLOP_PX,
  useRowSwipe,
} from './use-swipe'

/**
 * The gesture in isolation — no list, no replica, no triage. What is pinned here is the arithmetic
 * that decides whether a finger movement is a swipe at all: the pointer-type gate, the axis lock,
 * the commit threshold, and the two ways a gesture ends without acting. The meaning of a direction
 * (which mailbox, which keyword) is the caller's, and is pinned in `MessageList.test.tsx`.
 */

const ROW_ID = 'e1' as Id
const ARCHIVE: ResolvedSwipe = { kind: 'archive' }

const resolve = vi.fn<(id: Id, direction: 'left' | 'right') => ResolvedSwipe | null>(() => ARCHIVE)
const commit = vi.fn<(id: Id, resolved: ResolvedSwipe) => void>()

/** Set by the harness on every render so the imperative `isSwipeActive` can be read mid-gesture. */
let api: RowSwipe | null = null
/** Renders of the swiping component. The gesture must not cause a single one — see the file header. */
let renders = 0

function Harness() {
  const swipe = useRowSwipe({ resolve, commit, swipingClassName: 'swiping' })
  api = swipe
  const count = useRef(0)
  count.current += 1
  renders = count.current
  // `role="presentation"` mirrors the row wrapper the swipe actually binds to (MessageList).
  return <div data-testid="row" role="presentation" onPointerDown={swipe.onPointerDown(ROW_ID)} />
}

function row(): HTMLElement {
  return screen.getByTestId('row')
}

/**
 * Drive one gesture. Two moves, because the first is what the axis lock reads: a single jump to the
 * end coordinate would prove nothing about the decision the hook makes on the way there.
 */
function swipe(el: HTMLElement, dx: number, dy = 0, pointerType = 'touch'): void {
  const init = { pointerId: 1, pointerType, isPrimary: true, buttons: 1, bubbles: true }
  fireEvent.pointerDown(el, { ...init, clientX: 300, clientY: 40 })
  fireEvent.pointerMove(window, { ...init, clientX: 300 + dx / 2, clientY: 40 + dy / 2 })
  fireEvent.pointerMove(window, { ...init, clientX: 300 + dx, clientY: 40 + dy })
  fireEvent.pointerUp(window, { ...init, clientX: 300 + dx, clientY: 40 + dy })
}

beforeEach(() => {
  api = null
  renders = 0
  resolve.mockClear()
  resolve.mockReturnValue(ARCHIVE)
  commit.mockClear()
})

describe('useRowSwipe — what counts as a swipe', () => {
  it('jsdom constructs a PointerEvent that round-trips pointerType', () => {
    // Precondition, pinned: every gate below is a `pointerType` check, so a jsdom that dropped the
    // field would make this whole file pass for the wrong reason.
    render(<Harness />)
    const seen: string[] = []
    resolve.mockImplementation((_id, direction) => {
      seen.push(direction)
      return ARCHIVE
    })
    swipe(row(), -150)
    expect(seen).toEqual(['left'])
  })

  it('IGNORES a mouse — the drag owns that pointer, not the swipe (ADR-012)', () => {
    render(<Harness />)
    swipe(row(), -150, 0, 'mouse')
    expect(resolve).not.toHaveBeenCalled()
    expect(commit).not.toHaveBeenCalled()
  })

  it('ignores a non-primary touch, so a second finger cannot start a second gesture', () => {
    render(<Harness />)
    const init = { pointerId: 2, pointerType: 'touch', isPrimary: false, bubbles: true }
    fireEvent.pointerDown(row(), { ...init, clientX: 300, clientY: 40 })
    fireEvent.pointerMove(window, { ...init, clientX: 150, clientY: 40 })
    fireEvent.pointerUp(window, { ...init, clientX: 150, clientY: 40 })
    expect(commit).not.toHaveBeenCalled()
  })

  it('commits once past the threshold, with the action resolved at the axis lock', () => {
    render(<Harness />)
    swipe(row(), -(SWIPE_COMMIT_PX + 1))
    expect(commit).toHaveBeenCalledExactlyOnceWith(ROW_ID, ARCHIVE)
    expect(resolve).toHaveBeenCalledExactlyOnceWith(ROW_ID, 'left')
  })

  it('resolves the OPPOSITE direction for a rightward swipe', () => {
    render(<Harness />)
    swipe(row(), SWIPE_COMMIT_PX + 1)
    expect(resolve).toHaveBeenCalledExactlyOnceWith(ROW_ID, 'right')
    expect(commit).toHaveBeenCalledOnce()
  })

  it('does NOT commit under the threshold — a short swipe rubber-bands', () => {
    render(<Harness />)
    swipe(row(), -(SWIPE_COMMIT_PX - 1))
    // Resolved, because the axis locked and the row followed the finger; just never armed.
    expect(resolve).toHaveBeenCalledOnce()
    expect(commit).not.toHaveBeenCalled()
  })

  // One pixel apart, both derived from the constant, so the PAIR pins the comparison rather than a
  // fixture: with `-150` against `-40` any threshold in (40, 150] kept both green, and a retune from
  // 96 to 150 — tripling the travel a thumb has to make — shipped invisibly.
  it('commits AT the threshold exactly — the boundary is inclusive', () => {
    render(<Harness />)
    swipe(row(), -SWIPE_COMMIT_PX)
    expect(commit).toHaveBeenCalledOnce()
  })

  it('does NOT commit a vertical drag, however far it also travels sideways', () => {
    render(<Harness />)
    swipe(row(), -150, 200)
    // Dead at the first move, so the direction is never even resolved: a fling down the list must
    // not turn into an archive when the thumb drifts.
    expect(resolve).not.toHaveBeenCalled()
    expect(commit).not.toHaveBeenCalled()
  })

  it('gives an exact diagonal to the scroller', () => {
    render(<Harness />)
    swipe(row(), -60, 60)
    // `resolve`, not `commit`: this gesture travels 60 px, and the commit threshold is 96, so
    // `commit` is unreachable here whatever the axis lock decides — asserting on it proved only that
    // 60 < 96. `resolve` is what the tie-break actually controls. Flip both tie-breakers
    // (`absY >= absX` → `>`, `absX <= absY` → `<`) and the diagonal locks LEFT: the row follows the
    // finger and the strip opens under a thumb that was scrolling. That is the mutation this catches.
    expect(resolve).not.toHaveBeenCalled()
    expect(commit).not.toHaveBeenCalled()
    // Nothing was written to the row either — an abandoned gesture leaves the DOM as it found it.
    expect(row().dataset.swipe).toBeUndefined()
    expect(row().style.getPropertyValue('--swipe-x')).toBe('')
  })

  it('stays dead once judged vertical, even if the finger turns horizontal afterwards', () => {
    render(<Harness />)
    const init = { pointerId: 1, pointerType: 'touch', isPrimary: true, bubbles: true }
    fireEvent.pointerDown(row(), { ...init, clientX: 300, clientY: 40 })
    fireEvent.pointerMove(window, { ...init, clientX: 300, clientY: 140 })
    fireEvent.pointerMove(window, { ...init, clientX: 100, clientY: 140 })
    fireEvent.pointerUp(window, { ...init, clientX: 100, clientY: 140 })
    expect(commit).not.toHaveBeenCalled()
  })

  it('does not act below the slop at all', () => {
    render(<Harness />)
    swipe(row(), -(SWIPE_SLOP_PX - 1))
    expect(resolve).not.toHaveBeenCalled()
    expect(commit).not.toHaveBeenCalled()
  })

  it('locks AT the slop exactly — the boundary is inclusive', () => {
    render(<Harness />)
    swipe(row(), -SWIPE_SLOP_PX)
    // Locked (the strip opens and the row follows) but nowhere near armed, so a finger that twitches
    // 10 px and lifts still does nothing.
    expect(resolve).toHaveBeenCalledExactlyOnceWith(ROW_ID, 'left')
    expect(commit).not.toHaveBeenCalled()
  })

  /**
   * The two numbers themselves, not just the comparisons around them. Every other test here derives
   * its pointer distances FROM these constants, which is what keeps them honest about the boundary —
   * but it also means the whole file follows a retune silently. These are product decisions with a
   * feel: 10 px is the twitch a thumb makes while reading and must stay below the ~16 px a scroll
   * fling starts at, and 96 px is roughly a thumb's comfortable travel — an eighth of a 390 px phone
   * viewport, far enough that a scroll cannot reach it by accident and near enough to do one-handed.
   * Change either and this fails: not to forbid the change, but to make it a decision someone took.
   */
  it('pins the two thresholds as VALUES, since every fixture here is derived from them', () => {
    expect(SWIPE_SLOP_PX).toBe(10)
    expect(SWIPE_COMMIT_PX).toBe(96)
  })
})

describe('useRowSwipe — the ways a gesture ends without acting', () => {
  it('ABORTS on pointercancel: the browser took the pointer, so nothing may commit', () => {
    render(<Harness />)
    const init = { pointerId: 1, pointerType: 'touch', isPrimary: true, bubbles: true }
    fireEvent.pointerDown(row(), { ...init, clientX: 300, clientY: 40 })
    fireEvent.pointerMove(window, { ...init, clientX: 100, clientY: 40 })
    fireEvent.pointerCancel(window, { ...init, clientX: 100, clientY: 40 })
    // The lift that follows a cancel belongs to nobody.
    fireEvent.pointerUp(window, { ...init, clientX: 100, clientY: 40 })
    expect(commit).not.toHaveBeenCalled()
    expect(row().style.getPropertyValue('--swipe-x')).toBe('0px')
  })

  it('does not follow the finger into a direction that resolves to nothing', () => {
    resolve.mockReturnValue(null)
    render(<Harness />)
    swipe(row(), -150)
    expect(commit).not.toHaveBeenCalled()
    // No layer, no offset: an inert direction is silent rather than promising an action.
    expect(row().style.getPropertyValue('--swipe-x')).toBe('')
    expect(row().dataset.swipe).toBeUndefined()
  })

  /**
   * B44. The axis lock calls `resolve` through a ref, because the window listeners are bound once
   * and must still see the CURRENT decision. WHICH render's decision that is, is the whole question.
   *
   * `pointermove` arrives from a native window listener — outside React's tree — and a passive
   * effect does not run at commit: React schedules it, and input can be delivered first. In that
   * window the ref still holds the PREVIOUS render's callbacks, so a direction the committed render
   * has already made inert (`resolve` → `null`) still resolves to the action it had one render ago.
   * Not hypothetical: it is the account-loses-its-Archive failure, where the reveal strips — the
   * SAME `resolve`, called during render — correctly showed nothing while the finger still armed an
   * Archive and marked the row `data-swipe="left"`.
   *
   * The window is opened here exactly where it really is: a layout effect runs INSIDE the commit of
   * the inert render, after React has written the DOM and before any passive effect. `useRowSwipe`
   * is called first in this component, so its own commit-time refresh (the fix) is registered before
   * the effect below and runs before it — which is the point: everything that can observe the new
   * DOM must see the new decision with it.
   */
  it('resolves against the LAST COMMITTED render, not the last one whose effects have run (B44)', () => {
    const MOVE = {
      pointerId: 1,
      pointerType: 'touch',
      isPrimary: true,
      bubbles: true,
      clientX: 150,
      clientY: 40,
    }
    let setInert: ((value: boolean) => void) | null = null
    function StatefulHarness() {
      const [inert, setInertState] = useState(false)
      setInert = setInertState
      // A NEW closure per render, as `MessageList`'s `resolveSwipe` is: it is memoised on the
      // account's mailboxes, so its identity changes exactly when a role folder appears or goes.
      const swipe = useRowSwipe({
        resolve: () => (inert ? null : ARCHIVE),
        commit,
        swipingClassName: 'swiping',
      })
      useLayoutEffect(() => {
        if (!inert) return
        // Raw dispatch, not `fireEvent`: that wraps in `act`, and an `act` inside a commit is not
        // the thing under test.
        window.dispatchEvent(createEvent.pointerMove(window, MOVE))
        window.dispatchEvent(createEvent.pointerUp(window, MOVE))
      }, [inert])
      return (
        <div data-testid="row" role="presentation" onPointerDown={swipe.onPointerDown(ROW_ID)} />
      )
    }
    render(<StatefulHarness />)
    const el = row()
    fireEvent.pointerDown(el, {
      pointerId: 1,
      pointerType: 'touch',
      isPrimary: true,
      bubbles: true,
      clientX: 300,
      clientY: 40,
    })
    act(() => setInert?.(true))

    // Inert in the three ways the caller and the reader can perceive it.
    expect(el.dataset.swipe).toBeUndefined()
    expect(el.style.getPropertyValue('--swipe-x')).toBe('')
    expect(commit).not.toHaveBeenCalled()
  })

  it('detaches on unmount, so a row re-windowed mid-gesture leaves no window listeners', () => {
    const view = render(<Harness />)
    const el = row()
    const init = { pointerId: 1, pointerType: 'touch', isPrimary: true, bubbles: true }
    fireEvent.pointerDown(el, { ...init, clientX: 300, clientY: 40 })
    view.unmount()
    fireEvent.pointerMove(window, { ...init, clientX: 100, clientY: 40 })
    fireEvent.pointerUp(window, { ...init, clientX: 100, clientY: 40 })
    expect(commit).not.toHaveBeenCalled()
  })
})

describe('useRowSwipe — how it drives the row', () => {
  it('writes the offset, the direction and the armed flag imperatively', () => {
    render(<Harness />)
    const el = row()
    const init = { pointerId: 1, pointerType: 'touch', isPrimary: true, bubbles: true }
    fireEvent.pointerDown(el, { ...init, clientX: 300, clientY: 40 })

    fireEvent.pointerMove(window, { ...init, clientX: 270, clientY: 40 })
    expect(el.style.getPropertyValue('--swipe-x')).toBe('-30px')
    expect(el.dataset.swipe).toBe('left')
    expect(el.dataset.swipeArmed).toBe('')
    expect(el.classList.contains('swiping')).toBe(true)

    fireEvent.pointerMove(window, { ...init, clientX: 150, clientY: 40 })
    expect(el.style.getPropertyValue('--swipe-x')).toBe('-150px')
    expect(el.dataset.swipeArmed).toBe('true')

    fireEvent.pointerUp(window, { ...init, clientX: 150, clientY: 40 })
    // Back to rest, and the transition re-enabled, so the snap-back is a CSS concern only.
    expect(el.style.getPropertyValue('--swipe-x')).toBe('0px')
    expect(el.classList.contains('swiping')).toBe(false)
    expect(el.dataset.swipeArmed).toBe('')
  })

  it('clamps to the locked side rather than revealing the direction it never resolved', () => {
    render(<Harness />)
    const el = row()
    const init = { pointerId: 1, pointerType: 'touch', isPrimary: true, bubbles: true }
    fireEvent.pointerDown(el, { ...init, clientX: 300, clientY: 40 })
    fireEvent.pointerMove(window, { ...init, clientX: 150, clientY: 40 })
    fireEvent.pointerMove(window, { ...init, clientX: 460, clientY: 40 })
    expect(el.style.getPropertyValue('--swipe-x')).toBe('0px')
    fireEvent.pointerUp(window, { ...init, clientX: 460, clientY: 40 })
    // Dragged back past the start, so the left action is disarmed and the right one never resolves.
    expect(resolve).toHaveBeenCalledExactlyOnceWith(ROW_ID, 'left')
    expect(commit).not.toHaveBeenCalled()
  })

  it('re-renders NOTHING while the finger is down', () => {
    render(<Harness />)
    const before = renders
    swipe(row(), -150)
    // A setState per pointermove would re-render every virtual row at 60 Hz (NFR-PERF-02).
    expect(renders).toBe(before)
  })

  it('reports isSwipeActive only once the axis locks, not from pointerdown (ADR-012)', () => {
    render(<Harness />)
    const el = row()
    const init = { pointerId: 1, pointerType: 'touch', isPrimary: true, bubbles: true }
    expect(api?.isSwipeActive()).toBe(false)

    // A press that has not moved is NOT a swipe. This is the state a long-press sits in, and it is
    // how Chrome-Android and iOS Safari enter an HTML5 drag — reporting `true` here would cancel
    // every touch drag in the app (ADR-012 keeps both gestures, separated by what the finger does).
    fireEvent.pointerDown(el, { ...init, clientX: 300, clientY: 40 })
    expect(api?.isSwipeActive()).toBe(false)

    fireEvent.pointerMove(window, { ...init, clientX: 260, clientY: 40 })
    expect(api?.isSwipeActive()).toBe(true)

    fireEvent.pointerUp(window, { ...init, clientX: 260, clientY: 40 })
    expect(api?.isSwipeActive()).toBe(false)
  })

  it('stays inactive for a gesture the scroller took (vertical)', () => {
    render(<Harness />)
    const init = { pointerId: 1, pointerType: 'touch', isPrimary: true, bubbles: true }
    fireEvent.pointerDown(row(), { ...init, clientX: 300, clientY: 40 })
    fireEvent.pointerMove(window, { ...init, clientX: 300, clientY: 200 })
    // Judged vertical and dead for good — it must not report ownership of the pointer it gave up.
    expect(api?.isSwipeActive()).toBe(false)
  })

  it('is not active for a mouse press', () => {
    render(<Harness />)
    fireEvent.pointerDown(row(), {
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
      clientX: 300,
      clientY: 40,
      bubbles: true,
    })
    expect(api?.isSwipeActive()).toBe(false)
  })
})

describe('what a locked gesture asks the rest of the screen for', () => {
  /**
   * The compose button is `position: fixed` in the bottom-trailing corner on a phone, so a swipe on
   * the row beneath it reveals the action label behind a solid circle. The strip cannot paint over
   * a fixed overlay and the label cannot move without losing its progressive reveal, so the overlay
   * yields instead — driven by an attribute on `<body>`, which is the only channel between a row in
   * `mail/` and a button in `compose/` that costs no render (M12).
   */
  const marked = () => document.body.dataset.waxwingSwiping === 'true'

  it('marks the document only once the axis lock has resolved', () => {
    render(<Harness />)
    const init = { pointerId: 1, pointerType: 'touch', isPrimary: true, buttons: 1, bubbles: true }
    fireEvent.pointerDown(row(), { ...init, clientX: 300, clientY: 40 })
    expect(marked(), 'a touch that has not moved is not a swipe').toBe(false)

    fireEvent.pointerMove(window, { ...init, clientX: 300 - SWIPE_SLOP_PX - 4, clientY: 40 })
    expect(marked()).toBe(true)

    fireEvent.pointerUp(window, { ...init, clientX: 300 - SWIPE_SLOP_PX - 4, clientY: 40 })
    expect(marked(), 'and it comes back when the finger lifts').toBe(false)
  })

  it('never marks it for a gesture the scroller takes', () => {
    render(<Harness />)
    swipe(row(), 4, SWIPE_SLOP_PX + 20)
    expect(marked()).toBe(false)
  })

  it('unmarks it when the gesture is cancelled rather than lifted', () => {
    render(<Harness />)
    const init = { pointerId: 1, pointerType: 'touch', isPrimary: true, buttons: 1, bubbles: true }
    fireEvent.pointerDown(row(), { ...init, clientX: 300, clientY: 40 })
    fireEvent.pointerMove(window, { ...init, clientX: 300 - SWIPE_COMMIT_PX, clientY: 40 })
    expect(marked()).toBe(true)

    fireEvent.pointerCancel(window, { ...init, clientX: 300 - SWIPE_COMMIT_PX, clientY: 40 })
    expect(marked(), 'a cancelled gesture must not leave the screen half-dressed').toBe(false)
  })
})
