import { act, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OVERFLOW_TRIGGER_ATTR, useActionOverflow } from './use-action-overflow'

/*
 * jsdom has no layout: every width is 0, which is the case the hook answers with "show everything".
 * To test the arithmetic at all, width has to come from somewhere — here from a `data-w` attribute
 * read through prototype getters, so the numbers in each test read as what they are (a pane width
 * and a control width) instead of as observer plumbing.
 */
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

function Harness({ bar, unit, count }: { bar: number; unit: number; count: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const visible = useActionOverflow(ref, count)
  return (
    <div ref={ref} data-w={bar} style={{ columnGap: '4px' }}>
      <span {...{ [OVERFLOW_TRIGGER_ATTR]: '' }}>
        <button type="button" data-w={unit}>
          more
        </button>
      </span>
      <output data-testid="visible">{visible}</output>
    </div>
  )
}

const visible = () => Number(screen.getByTestId('visible').textContent)

describe('useActionOverflow', () => {
  // The measurement B49 is about, in the two shapes the same pane takes. Ten actions plus the
  // trigger at 44px + 4px gap need 524px; a 270px pane fits five of them, one of which is the
  // trigger — which is the four visible actions the owner chose.
  it('keeps four actions beside the trigger in a 270px pane at touch size', () => {
    render(<Harness bar={270} unit={44} count={10} />)
    expect(visible()).toBe(4)
  })

  it('shows every action when they all fit, spending no slot on the trigger', () => {
    render(<Harness bar={1000} unit={44} count={10} />)
    expect(visible()).toBe(10)
  })

  // The same pane on a pointer device: 34px controls, so more of them fit. A table of breakpoints
  // would need a second row for this; measuring a rendered control gets it for nothing.
  it('fits more of the same actions at pointer size than at touch size', () => {
    const { unmount } = render(<Harness bar={270} unit={34} count={10} />)
    const coarse = 4
    expect(visible()).toBeGreaterThan(coarse)
    unmount()
  })

  // Exactly enough room for ten actions and the trigger — the boundary the `count + 1` comparison
  // decides, and the one an off-by-one would hide a real action behind the menu at.
  it('does not hide an action at the width where everything just fits', () => {
    render(<Harness bar={524} unit={44} count={10} />)
    expect(visible()).toBe(10)
  })

  it('hides one more as soon as that width is lost', () => {
    render(<Harness bar={523} unit={44} count={10} />)
    expect(visible()).toBe(9)
  })

  // Without layout there is nothing to measure, and an empty bar would be a worse answer than a
  // full one: every jsdom test in this repo renders the bar without widths.
  it('shows everything when there is nothing to measure', () => {
    render(<Harness bar={0} unit={0} count={10} />)
    expect(visible()).toBe(10)
  })

  // A pane narrower than one control: the trigger alone, and nothing lost — the actions are all in
  // the menu behind it rather than clipped out of reach.
  it('falls back to the trigger alone in a pane too narrow for one action', () => {
    render(<Harness bar={40} unit={44} count={10} />)
    expect(visible()).toBe(0)
  })

  // The splitter case. The observer is on the BAR, not the window, because dragging a pane edge is
  // not a viewport change — the bug B49 grew out of was a rule that asked the wrong one.
  it('re-measures when the bar itself is resized', () => {
    const { rerender } = render(<Harness bar={1000} unit={44} count={10} />)
    expect(visible()).toBe(10)
    rerender(<Harness bar={270} unit={44} count={10} />)
    act(() => {
      for (const fire of observers) fire([], {} as ResizeObserver)
    })
    expect(visible()).toBe(4)
  })
})
