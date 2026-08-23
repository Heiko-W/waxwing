import { afterEach, describe, expect, it } from 'vitest'
import {
  initScrollbarMetrics,
  measureScrollbarGutter,
  OVERLAY_SCROLLBAR_LANE,
  OVERLAY_SCROLLBAR_PROPERTY,
} from './scrollbar-metrics'

/**
 * The measurement behind the folder rail's "scrollbar drawn in pieces" defect.
 *
 * jsdom computes no layout, so `offsetWidth` and `clientWidth` are both 0 there — which is
 * indistinguishable from a real overlay scrollbar and is why the classic case is faked explicitly
 * rather than left to the environment. What CAN be checked here is the whole of the decision: the
 * probe leaves nothing behind, and each measured gutter maps to the right published value.
 */

/** Stand in for a platform whose scrollbar takes `width` px of layout room. */
function withGutter(width: number, run: () => void): void {
  const offset = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')
  const client = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 100 })
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    value: 100 - width,
  })
  try {
    run()
  } finally {
    if (offset) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', offset)
    if (client) Object.defineProperty(HTMLElement.prototype, 'clientWidth', client)
  }
}

afterEach(() => {
  document.documentElement.style.removeProperty(OVERLAY_SCROLLBAR_PROPERTY)
})

describe('scrollbar metrics', () => {
  it('reports the gutter a classic scrollbar takes', () => {
    withGutter(15, () => {
      expect(measureScrollbarGutter()).toBe(15)
    })
  })

  it('reports 0 for an overlay scrollbar', () => {
    withGutter(0, () => {
      expect(measureScrollbarGutter()).toBe(0)
    })
  })

  it('leaves no probe behind — it is measured and removed within the call', () => {
    const before = document.body.childElementCount
    measureScrollbarGutter()
    expect(document.body.childElementCount).toBe(before)
  })

  it('reserves a lane only where the bar overlays the content', () => {
    withGutter(0, () => initScrollbarMetrics())
    expect(document.documentElement.style.getPropertyValue(OVERLAY_SCROLLBAR_PROPERTY)).toBe(
      OVERLAY_SCROLLBAR_LANE,
    )

    // A classic bar lives in its own gutter, so nothing in the content can reach it and nothing
    // should be subtracted from a header that has an account name to fit.
    withGutter(15, () => initScrollbarMetrics())
    expect(document.documentElement.style.getPropertyValue(OVERLAY_SCROLLBAR_PROPERTY)).toBe('0px')
  })
})
