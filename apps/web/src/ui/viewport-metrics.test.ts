import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  initViewportMetrics,
  updateViewportMetrics,
  VIEWPORT_BLOCK_PROPERTY,
  VIEWPORT_OFFSET_PROPERTY,
} from './viewport-metrics'

/**
 * The measurement behind "Send is under the keyboard".
 *
 * jsdom has no `visualViewport` and no layout, so the object is faked outright — which is the
 * honest shape for this test anyway: what is being checked is the DECISION (which number is
 * published, and when it is not), not a browser's geometry. The device half of the finding stays
 * a device question and is marked as one in the audit.
 */

interface FakeVisualViewport {
  height: number
  offsetTop: number
  scale: number
  addEventListener: (type: string, listener: () => void) => void
  removeEventListener: (type: string, listener: () => void) => void
}

/** A window with a visual viewport under our control, and a record of what it subscribed to. */
function fakeWindow(
  visual: Partial<FakeVisualViewport> | null,
  innerHeight = 800,
): { win: Window; listeners: string[]; removed: string[] } {
  const listeners: string[] = []
  const removed: string[] = []
  const doc = document.implementation.createHTMLDocument('t')
  const visualViewport =
    visual === null
      ? undefined
      : {
          height: 800,
          offsetTop: 0,
          scale: 1,
          ...visual,
          addEventListener: (type: string) => listeners.push(type),
          removeEventListener: (type: string) => removed.push(type),
        }
  const win = {
    innerHeight,
    visualViewport,
    document: doc,
    addEventListener: (type: string) => listeners.push(type),
    removeEventListener: (type: string) => removed.push(type),
  } as unknown as Window
  return { win, listeners, removed }
}

const read = (win: Window, property: string): string =>
  win.document.documentElement.style.getPropertyValue(property)

afterEach(() => {
  document.documentElement.style.removeProperty(VIEWPORT_BLOCK_PROPERTY)
  document.documentElement.style.removeProperty(VIEWPORT_OFFSET_PROPERTY)
  vi.restoreAllMocks()
})

describe('viewport metrics', () => {
  it('publishes the visible height, not the window height', () => {
    // The whole point: with a 320px keyboard open, `innerHeight` still says 800 and every
    // bottom-anchored control in the app believes it.
    const { win } = fakeWindow({ height: 480, offsetTop: 0 })
    updateViewportMetrics(win)
    expect(read(win, VIEWPORT_BLOCK_PROPERTY)).toBe('480px')
  })

  it('publishes how far the visible band has slid down', () => {
    // Publishing only the height fixes the footer and puts the header off the top of the screen:
    // a fixed element at `inset-block-start: 0` is pinned to the LAYOUT viewport.
    const { win } = fakeWindow({ height: 480, offsetTop: 96 })
    updateViewportMetrics(win)
    expect(read(win, VIEWPORT_OFFSET_PROPERTY)).toBe('96px')
  })

  it('ignores a pinch zoom', () => {
    // A reader who zooms in wants the page magnified, not the layout rebuilt around the
    // magnifier. Without this the shell would collapse to the size of the zoom rectangle.
    const { win } = fakeWindow({ height: 200, offsetTop: 300, scale: 2 })
    updateViewportMetrics(win)
    expect(read(win, VIEWPORT_BLOCK_PROPERTY)).toBe('800px')
    expect(read(win, VIEWPORT_OFFSET_PROPERTY)).toBe('0px')
  })

  it('treats a scale of almost exactly 1 as no zoom', () => {
    // Safari reports 1.0000001 after an orientation change. Reading that as a zoom would freeze
    // the shell at `innerHeight` for the rest of the session — the defect, wearing the fix's hat.
    const { win } = fakeWindow({ height: 480, offsetTop: 40, scale: 1.000001 })
    updateViewportMetrics(win)
    expect(read(win, VIEWPORT_BLOCK_PROPERTY)).toBe('480px')
    expect(read(win, VIEWPORT_OFFSET_PROPERTY)).toBe('40px')
  })

  it('rounds to whole pixels', () => {
    const { win } = fakeWindow({ height: 480.4, offsetTop: 95.6 })
    updateViewportMetrics(win)
    expect(read(win, VIEWPORT_BLOCK_PROPERTY)).toBe('480px')
    expect(read(win, VIEWPORT_OFFSET_PROPERTY)).toBe('96px')
  })

  it('falls back to the window height where visualViewport does not exist', () => {
    // Older engines and jsdom. The property is published either way, so the stylesheets never see
    // it set on one engine and absent on another.
    const { win } = fakeWindow(null, 640)
    updateViewportMetrics(win)
    expect(read(win, VIEWPORT_BLOCK_PROPERTY)).toBe('640px')
    expect(read(win, VIEWPORT_OFFSET_PROPERTY)).toBe('0px')
  })

  it('subscribes to resize AND scroll', () => {
    // The keyboard opening is a resize; the browser sliding the band to keep the focused field in
    // view is a scroll. One without the other leaves the offset stale.
    const { win, listeners } = fakeWindow({ height: 480 })
    initViewportMetrics(win)
    expect(listeners).toEqual(['resize', 'scroll'])
  })

  it('publishes once before any event arrives', () => {
    const { win } = fakeWindow({ height: 480 })
    initViewportMetrics(win)
    expect(read(win, VIEWPORT_BLOCK_PROPERTY)).toBe('480px')
  })

  it('unsubscribes both listeners', () => {
    const { win, removed } = fakeWindow({ height: 480 })
    initViewportMetrics(win)()
    expect(removed).toEqual(['resize', 'scroll'])
  })

  it('still subscribes on an engine without visualViewport', () => {
    const { win, listeners, removed } = fakeWindow(null)
    initViewportMetrics(win)()
    expect(listeners).toEqual(['resize'])
    expect(removed).toEqual(['resize'])
  })
})
