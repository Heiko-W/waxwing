/**
 * Whether this platform's scrollbar sits OVER the content, and how much room to leave it.
 *
 * ## The defect
 *
 * Reported from the live app with a screenshot (2026-08-23): the folder rail's scrollbar was drawn
 * in PIECES, broken at the account headers. Measured against the fixture in both engines, the rail
 * holds exactly ONE scroll container — so two thumb segments in one column cannot be two scrollers,
 * and the gaps line up with something covering the thumb instead.
 *
 * That something is `.accountHeader`: `position: sticky`, opaque, and `z-index: 1`. The z-index is
 * what makes it a stacking context of its own, and a stacking context is what gets painted over an
 * OVERLAY scrollbar — the folder rows beside it, which are `position: relative` with no z-index,
 * leave the thumb alone, which is exactly what the screenshot shows.
 *
 * It cannot happen where the scrollbar is CLASSIC: there the bar lives in a gutter outside the
 * content box (`scrollbar-gutter: stable` reserves it), so nothing in the content can reach it. It
 * happens on every platform that draws an overlay bar — macOS by default, which is where it was
 * reported, and which is why no Chromium-on-Linux suite here could have seen it.
 *
 * ## Why measured rather than assumed
 *
 * There is no media feature for "the scrollbar overlays the content", and guessing from the user
 * agent is guessing: the macOS setting is *"Show scroll bars: automatically / when scrolling /
 * always"*, and the last of those makes a Mac behave like Windows. So the app measures the real
 * gutter once at boot — a probe element with `overflow-y: scroll`, whose `offsetWidth -
 * clientWidth` is the bar's width in the layout, and 0 exactly when it takes no layout room at all.
 *
 * The result is published as `--waxwing-scrollbar-overlay`: 0 where the bar has its own gutter,
 * and a lane where it does not. Only the rules that would otherwise PAINT OVER the bar consume it,
 * so nothing pays for this on a classic-scrollbar platform.
 */

/**
 * The lane to leave clear where the bar overlays the content.
 *
 * macOS draws its thumb about 7px wide with ~2px of edge inset, and widens it to roughly 15px with
 * a track while the pointer is on it. 0.75rem (12px) clears the resting state completely and most
 * of the hovered one — chosen over 1rem because this is subtracted from a header that has to hold
 * an account name, and over 0.5rem because a bar that is half-covered still reads as broken.
 */
export const OVERLAY_SCROLLBAR_LANE = '0.75rem'

/** The custom property the stylesheets read. Declared with a `0px` default in `tokens.css`. */
export const OVERLAY_SCROLLBAR_PROPERTY = '--waxwing-scrollbar-overlay'

/**
 * The width the platform's scrollbar takes IN THE LAYOUT, in CSS pixels.
 *
 * 0 means an overlay bar (or no bar at all). The probe is measured and removed within one call, so
 * it never reaches paint; `position: absolute` off-screen keeps it out of the document flow while
 * it is there.
 */
export function measureScrollbarGutter(doc: Document = document): number {
  const probe = doc.createElement('div')
  probe.style.cssText =
    'position:absolute;top:-9999px;inline-size:100px;block-size:100px;overflow-y:scroll'
  doc.body.append(probe)
  const gutter = probe.offsetWidth - probe.clientWidth
  probe.remove()
  return gutter
}

/**
 * Publish the lane as a custom property on `<html>`. Called once at boot, before the first paint of
 * anything that reads it.
 */
export function initScrollbarMetrics(doc: Document = document): void {
  const overlays = measureScrollbarGutter(doc) === 0
  doc.documentElement.style.setProperty(
    OVERLAY_SCROLLBAR_PROPERTY,
    overlays ? OVERLAY_SCROLLBAR_LANE : '0px',
  )
}
