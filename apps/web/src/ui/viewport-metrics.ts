/**
 * How much of the window the reader can actually SEE, published as CSS custom properties.
 *
 * ## The defect
 *
 * Nothing in the app read `window.visualViewport` (measured: zero occurrences before 2026-08-24),
 * and the shell is nailed to the layout viewport — `.app` is `100dvh` with `overflow: hidden`.
 * `dvh` follows a mobile browser's collapsing toolbars; it does NOT follow the on-screen keyboard.
 * So on iOS everything anchored to the bottom of the window kept its place while the keyboard
 * covered it:
 *
 *   - the composer's footer (Send, Send later, Attach, Options, Discard) — a full-screen fixed
 *     panel on a phone, whose last flex child is exactly that row;
 *   - the footer of every form dialog (Cancel / Save) — the panel measures against the viewport
 *     and the backdrop is `position: fixed`;
 *   - the attachment sheet, which is `block-size: 100vh` on a phone.
 *
 * With a ~300 px keyboard on an iPhone and ~350 px on an iPad, the primary action of the app's
 * central task was under it. HIG `virtual-keyboards`: "Use the keyboard layout guide … to keep
 * important parts of your interface visible while the virtual keyboard is onscreen."
 *
 * ## Why JS, and why two properties
 *
 * There is no CSS unit for "the part of the window the keyboard has not covered". `svh`/`dvh`/`lvh`
 * all describe the browser's own chrome, not a keyboard; `interactive-widget=resizes-content` in
 * the viewport meta does describe it, and Safari ignores it (it is set anyway — it costs a token
 * and Chromium honours it).
 *
 * Two properties, because the keyboard does two things at once. It shrinks the visible band
 * (`height`) AND scrolls it within the layout viewport (`offsetTop`) — a fixed element pinned to
 * `inset-block-start: 0` is pinned to the LAYOUT viewport, so when the visual one has slid down,
 * the top of that element is off-screen above. Publishing only the height fixes the footer and
 * loses the header.
 *
 * ## The pinch-zoom trap
 *
 * `visualViewport` also reports a pinch zoom, and a reader who zooms in wants the page magnified,
 * not the layout rebuilt around the magnifying glass. `scale` separates the two: it is 1 while a
 * keyboard is open and > 1 while zoomed, so a zoom falls back to `innerHeight` and the shell holds
 * still.
 */

/** Visible height of the window, in CSS pixels. Read as `var(--waxwing-viewport-block, 100dvh)`. */
export const VIEWPORT_BLOCK_PROPERTY = '--waxwing-viewport-block'

/** How far the visible band has slid down inside the layout viewport, in CSS pixels. */
export const VIEWPORT_OFFSET_PROPERTY = '--waxwing-viewport-offset'

/**
 * Above this, `scale` is a pinch zoom rather than rounding noise.
 *
 * Not `> 1`: Safari reports scales like 1.0000001 after an orientation change, and treating those
 * as a zoom would freeze the shell at `innerHeight` for the rest of the session — the failure would
 * look exactly like the defect this module exists to fix.
 */
const ZOOM_EPSILON = 1.01

function publish(win: Window, height: number, offset: number): void {
  const root = win.document.documentElement
  root.style.setProperty(VIEWPORT_BLOCK_PROPERTY, `${Math.round(height)}px`)
  root.style.setProperty(VIEWPORT_OFFSET_PROPERTY, `${Math.round(offset)}px`)
}

/**
 * Write the current visible geometry to `<html>`.
 *
 * Exported for the test and for the boot call; the subscription below is what keeps it current.
 */
export function updateViewportMetrics(win: Window = window): void {
  const visual = win.visualViewport
  if (!visual) {
    // No support (older engines, and jsdom): fall back to the window's own height, which is what
    // `100dvh` would have resolved to anyway. The CSS fallback covers the same case; this makes
    // the property present and consistent rather than absent on some engines and set on others.
    publish(win, win.innerHeight, 0)
    return
  }
  const zoomed = visual.scale > ZOOM_EPSILON
  publish(win, zoomed ? win.innerHeight : visual.height, zoomed ? 0 : visual.offsetTop)
}

/**
 * Subscribe to the visible viewport and keep the two properties current.
 *
 * Returns an unsubscribe function; the app calls this once at boot and never unsubscribes, but a
 * test that does not clean up leaks listeners into the next one.
 *
 * `resize` AND `scroll`: the keyboard opening is a resize, and the browser sliding the visible band
 * to keep the focused field in view is a scroll. Listening for only one of them fixes the height
 * and leaves the offset stale, which puts the shell's header off the top of the screen.
 */
export function initViewportMetrics(win: Window = window): () => void {
  updateViewportMetrics(win)
  const visual = win.visualViewport
  if (!visual) {
    const onResize = (): void => updateViewportMetrics(win)
    win.addEventListener('resize', onResize)
    return () => win.removeEventListener('resize', onResize)
  }
  const onChange = (): void => updateViewportMetrics(win)
  visual.addEventListener('resize', onChange)
  visual.addEventListener('scroll', onChange)
  return () => {
    visual.removeEventListener('resize', onChange)
    visual.removeEventListener('scroll', onChange)
  }
}
