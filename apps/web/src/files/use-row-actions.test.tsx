/**
 * The row-action arithmetic (N-1), against fed widths rather than rendered pixels.
 *
 * jsdom lays nothing out, so there is no browser in which "33px of file name" could be observed
 * from a test — and pixels were never the invariant anyway. The invariant is the sentence the
 * geometry states: whatever else a row holds, `nameMin` of it belongs to the name. So the widths
 * come in through a harness, exactly as `mail/use-action-overflow.test.tsx` feeds a pane width and
 * a control width, and what is checked is the split that follows from them.
 *
 * The numbers below are the measured ones from the 21 August walkthrough, so a failure here reads
 * as the defect it guards: a 390px phone gives the row 342px of content, the size column takes 48,
 * the two gaps 24, and five 44px controls want 236.
 */

import { act, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ROW_PART, type RowGeometry, useRowGeometry, visibleRowActions } from './use-row-actions'

/** The phone the walkthrough measured: a 358px padding box, 8px of padding on each side. */
const PHONE_ROW = 358
/** The same rows on an 820px tablet, where all five controls have always fitted. */
const TABLET_ROW = 675

/** Widths come from `data-w`, so each number in a test reads as the box it describes. */
const widthGetter = {
  configurable: true,
  get(this: HTMLElement): number {
    return Number(this.dataset.w ?? 0)
  },
}

/** The ResizeObserver callbacks currently registered, so a test can re-fire one. */
let observers: ResizeObserverCallback[] = []

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', widthGetter)
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', widthGetter)
  observers = []
  window.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) {
      observers.push(callback)
    }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})

afterEach(() => {
  Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth')
  Reflect.deleteProperty(HTMLElement.prototype, 'offsetWidth')
})

/** A geometry stated in full, so each test only names the numbers it is about. */
function geometry(over: Partial<RowGeometry> = {}): RowGeometry {
  return { row: 342, nameMin: 192, size: 48, rowGap: 12, unit: 44, actionGap: 4, ...over }
}

describe('visibleRowActions', () => {
  it('keeps nothing but the menu beside the name on a 390px phone', () => {
    // The defect, arithmetically: 342 − 192 − 48 − 24 leaves 78px, which is one 44px control. One
    // control is the trigger, so the row shows `⋯` and the name gets the 226px it had been denied.
    expect(visibleRowActions(geometry(), 5)).toBe(0)
  })

  it('leaves the tablet exactly as it was — all five in the row', () => {
    // 659 − 192 − 48 − 24 = 395px, room for eight controls where five are wanted. The walkthrough
    // measured 351px of name here and reported nothing wrong; this fix must not take that away.
    expect(visibleRowActions(geometry({ row: 659 }), 5)).toBe(5)
  })

  it('spends the phone row on an action once controls are pointer-sized', () => {
    // 34px controls (no `pointer: coarse`) fit two in the same 78px, so one action stays beside the
    // trigger. The same table of breakpoints would have needed a second row for this case.
    expect(visibleRowActions(geometry({ unit: 34 }), 5)).toBe(1)
  })

  it('does not hide an action at the width where all of them just fit', () => {
    // Five controls are 5×44 + 4×4 = 236px. At exactly that much room nothing needs a menu, and an
    // off-by-one here would put a real action behind `⋯` on a screen with space for it.
    const room = 236
    expect(visibleRowActions(geometry({ row: 192 + 48 + 24 + room }), 5)).toBe(5)
  })

  it('hides two as soon as that width is lost by a pixel', () => {
    // 235px seats four controls (4×44 + 3×4 = 188) but not five (236). One of the four is the
    // trigger, so three actions stay — the row never claims room it does not have.
    expect(visibleRowActions(geometry({ row: 192 + 48 + 24 + 235 }), 5)).toBe(3)
  })

  it('answers per row, because a folder offers one action fewer than a file', () => {
    // Two controls' worth of room. A file (five actions) and a folder (three) both need the menu,
    // and both keep one action beside it — the count is an argument, not a second measurement.
    const room = 92
    expect(visibleRowActions(geometry({ row: 192 + 48 + 24 + room }), 5)).toBe(1)
    expect(visibleRowActions(geometry({ row: 192 + 48 + 24 + room }), 3)).toBe(1)
  })

  it('never returns a negative count when the row is narrower than the reserve', () => {
    expect(visibleRowActions(geometry({ row: 100 }), 5)).toBe(0)
  })

  it('shows everything when there is nothing to measure', () => {
    // Every jsdom test in this repo renders the list without widths, and a row with no actions at
    // all would be a worse answer than a full one.
    expect(
      visibleRowActions({ row: 0, nameMin: 0, size: 0, rowGap: 0, unit: 0, actionGap: 0 }, 5),
    ).toBe(5)
  })
})

/**
 * The list as the hook finds it: one row, marked parts, and the two declarations the reserve is
 * stated in (`.name`'s minimum width and a control's) as inline styles, which is what jsdom's
 * `getComputedStyle` can report.
 */
function Harness({
  row,
  size,
  nameMin,
  unit,
  count,
}: {
  row: number
  size: number
  nameMin: number
  unit: number
  count: number
}) {
  const ref = useRef<HTMLUListElement>(null)
  const measured = useRowGeometry(ref, count)
  return (
    <>
      <ul ref={ref}>
        <li
          {...{ [ROW_PART.row]: '' }}
          data-w={row}
          style={{ paddingLeft: '8px', paddingRight: '8px', columnGap: '12px' }}
        >
          <span {...{ [ROW_PART.name]: '' }} style={{ minWidth: `${nameMin}px` }} />
          <span {...{ [ROW_PART.size]: '' }} data-w={size} />
          <span {...{ [ROW_PART.actions]: '' }} style={{ columnGap: '4px' }}>
            <button type="button" style={{ minWidth: `${unit}px` }}>
              first
            </button>
          </span>
        </li>
      </ul>
      <output data-testid="visible">{visibleRowActions(measured, count)}</output>
    </>
  )
}

const visible = () => Number(screen.getByTestId('visible').textContent)

describe('useRowGeometry', () => {
  it('reads the reserve off the stylesheet rather than carrying a number of its own', () => {
    // The point of the round trip: `.name`'s `min-inline-size` is what actually keeps the name
    // readable, so the split has to follow whatever that rule says. Raise it and fewer controls
    // stay — no second constant to keep in step.
    render(<Harness row={PHONE_ROW} size={48} nameMin={192} unit={44} count={5} />)
    expect(visible()).toBe(0)
  })

  it('subtracts the row padding, not just the row', () => {
    // `clientWidth` is the padding box: 358px here, of which 16 belong to the row's own inset and
    // never to its contents. Taken whole it would seat a third control and show two actions, which
    // is the row claiming 16px it does not have — a small lie, and the direction that clips names.
    render(<Harness row={PHONE_ROW} size={48} nameMin={140} unit={44} count={5} />)
    expect(visible()).toBe(1)
  })

  it('leaves the tablet row whole', () => {
    render(<Harness row={TABLET_ROW} size={48} nameMin={192} unit={44} count={5} />)
    expect(visible()).toBe(5)
  })

  it('shows everything where there is no layout to read', () => {
    render(<Harness row={0} size={0} nameMin={0} unit={0} count={5} />)
    expect(visible()).toBe(5)
  })

  it('re-measures when the list itself is resized', () => {
    // A rotated phone, or a pane edge dragged — neither of which the initial measurement saw. The
    // observer is on the list because that is the box whose width decides every row in it.
    const { rerender } = render(
      <Harness row={TABLET_ROW} size={48} nameMin={192} unit={44} count={5} />,
    )
    expect(visible()).toBe(5)
    rerender(<Harness row={PHONE_ROW} size={48} nameMin={192} unit={44} count={5} />)
    act(() => {
      for (const fire of observers) fire([], {} as ResizeObserver)
    })
    expect(visible()).toBe(0)
  })
})
