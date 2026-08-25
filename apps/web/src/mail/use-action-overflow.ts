/**
 * How many toolbar actions fit on ONE row (B49).
 *
 * The reading pane's action bar holds eleven controls. On a touch device each is 44px, not 34px
 * (`--waxwing-control-min` under `pointer: coarse`, WCAG 2.5.5 AAA), and at an 834px tablet the pane
 * beside the list is 270px wide: eleven times 44 into 270 is three rows, and no amount of CSS fixes
 * that — the arithmetic is the defect. What fixes it is Apple Mail's answer, which is to keep a few
 * actions and move the rest into the `⋯` menu that is already there.
 *
 * CSS alone cannot do it. Hiding buttons with a container query would make real actions unreachable,
 * because the menu has to GAIN them at the same width the bar loses them — and a stylesheet cannot
 * tell JavaScript what it hid. So the width is measured here and the split is made once, in one
 * place, with the menu built from the same array the bar renders.
 *
 * WHAT IS MEASURED, and why it is not a table of breakpoints. The unit is the rendered width of ONE
 * control, read off the DOM rather than computed from tokens: every control in this row carries the
 * same `--waxwing-control-min`, so one of them already reflects whichever of 34/44px this pointer
 * type gets, at this font size, under this theme — three things a hardcoded number would each have
 * to track separately.
 *
 * The trigger is preferred as that one control, and ANY button in the bar is the fallback. That
 * fallback is not belt-and-braces: measuring the trigger ALONE has a fixed point that traps the
 * hook (B10 surfaced it, by removing the accident that used to hide it). When nothing is hidden the
 * trigger is not rendered, so `unit` is 0, so the hook answers "everything fits" — which keeps the
 * trigger unrendered. A bar that GAINS actions after mount can therefore never discover that they
 * no longer fit, and draws them outside its own box, which is the exact defect this hook exists to
 * prevent. It used to be masked by luck: the bulk bar's role mailboxes each arrived on their own
 * liveQuery tick, so the action count grew past a `visible` that had been initialised smaller, the
 * trigger appeared for one commit, and the hook got its measurement. One shared subscription
 * (ADR-035) delivers them in a single step, and the bar mounts with its final count — no
 * intermediate commit, no trigger, no unit.
 *
 * DEGRADES TO "SHOW EVERYTHING". Without layout there is nothing to measure: jsdom reports every
 * width as 0, and so does a bar that has not been laid out yet. Both answer `count`, which is what
 * the bar rendered before this existed — a test that cannot see the overflow sees the full row
 * rather than an empty one.
 */

import { type RefObject, useLayoutEffect, useState } from 'react'

/** Marks the overflow trigger's wrapper, so the hook can measure one control without a token lookup. */
export const OVERFLOW_TRIGGER_ATTR = 'data-overflow-trigger'

export function useActionOverflow(ref: RefObject<HTMLElement | null>, count: number): number {
  const [visible, setVisible] = useState(count)

  useLayoutEffect(() => {
    const bar = ref.current
    if (bar === null) {
      setVisible(count)
      return
    }

    const measure = (): void => {
      const width = bar.clientWidth
      const trigger = bar.querySelector<HTMLElement>(`[${OVERFLOW_TRIGGER_ATTR}] button`)
      // Any button will do as the unit; see the note above for why the trigger cannot be the only
      // candidate. `?? 0` still stands for "no layout at all", which is the degrade-to-everything
      // case one line down.
      const unit = (trigger ?? bar.querySelector<HTMLElement>('button'))?.offsetWidth ?? 0
      if (width === 0 || unit === 0) {
        setVisible(count)
        return
      }
      const gap = Number.parseFloat(getComputedStyle(bar).columnGap) || 0
      // The bar also draws a WIDER gap where the meaning-family changes (C5). Read off the DOM
      // rather than assumed, for the same reason `unit` is: it is a token, and a token can be
      // retuned by a hoster. Reserving one is deliberately conservative — a row cut short enough
      // to lose its family boundary reserves space it no longer needs, and showing one action
      // fewer is the harmless direction to be wrong in.
      const groupStart = bar.querySelector<HTMLElement>('[data-group-start]')
      const extra =
        groupStart === null
          ? 0
          : Number.parseFloat(getComputedStyle(groupStart).marginInlineStart) || 0
      // n controls occupy n*unit + (n-1)*gap, so the count that fits inverts to this.
      const fits = Math.floor((width - extra + gap) / (unit + gap))
      // The trigger is one of them whenever anything is hidden behind it — but when everything fits
      // there is no reason to spend a slot on it, which is the `count + 1` comparison.
      setVisible(fits >= count + 1 ? count : Math.max(0, fits - 1))
    }

    // Measure FIRST, and unconditionally. This used to bail out before measuring wherever
    // `ResizeObserver` is missing, which is every jsdom test — so a suite could only ever see the
    // full row, and the one place that wanted to check the split had to install a stub. Installing
    // one is not free: TanStack Virtual switches to the observer path the moment the global exists,
    // and a stub that never fires leaves a virtualized list with no rows at all. A single
    // synchronous measurement answers the same `width === 0` fallback in a real jsdom run, and lets
    // a test that DOES stub widths get a real answer.
    measure()
    if (typeof ResizeObserver === 'undefined') return
    // Observing the BAR, not the window: the pane is resizable by a splitter and by the list beside
    // it, neither of which is a viewport change. This is the same lesson as the container queries in
    // `reading.module.css` — asking how wide the window is answers a different question.
    const observer = new ResizeObserver(measure)
    observer.observe(bar)
    return () => observer.disconnect()
  }, [ref, count])

  return visible
}
