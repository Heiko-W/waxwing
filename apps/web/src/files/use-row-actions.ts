/**
 * How many of a file row's actions stay IN the row (N-1).
 *
 * The rename control (M1) made five, and five is one too many: under `pointer: coarse` a control is
 * 44px (`--waxwing-control-min`, WCAG 2.5.5 AAA), so five of them plus their gaps are 236px of a
 * 342px row on a 390px phone. What was left for the file's NAME was 33px — measured, not estimated:
 * `protokoll-neu.txt` rendered as "p", and two files in the same folder could not be told apart.
 * The name is the one thing a file row exists to state, so it is the thing that may not give way.
 *
 * This is the arithmetic of `mail/use-action-overflow.ts`, and the answer is the same one: keep what
 * fits and move the rest into the `⋯` menu. What does NOT transfer is that hook itself, and the
 * reason is worth stating because it looks reusable. There, the action bar is the flexible box
 * (`flex: 1; min-inline-size: 0`) beside a content-sized prefix, so `bar.clientWidth` already IS
 * "the room the actions have" and one measurement answers the question. Here the roles are
 * reversed: the actions are content-sized and the NAME is the flexible box, so the action group's
 * own width is whatever the buttons happen to need — measuring it would measure the count we are
 * trying to decide, and each hidden button would free the room that brings it back.
 *
 * So the measured quantity is the ROW, which is the same width whatever we put in it, and the
 * reserve is explicit: {@link RowGeometry} states the width the name keeps, the size column beside
 * it and the gaps, and {@link visibleRowActions} spends what is left on controls. Every field is
 * read off the DOM rather than hardcoded, for the reason the mail hook gives — 34px against 44px,
 * the size column's width and the two gaps are all tokens, and a token can be retuned by a hoster.
 *
 * THE NAME'S MINIMUM IS A CSS RULE, NOT A NUMBER HERE. `.name` declares `min-inline-size`, which is
 * what actually guarantees the invariant: with layout but without this hook (no `ResizeObserver`,
 * a stylesheet that loaded before the script) the flex line simply breaks and the actions drop to a
 * second line — ugly, never wrong. This hook reads that same declaration back, so the two can not
 * drift apart, and turns the second line into a menu.
 *
 * DEGRADES TO "SHOW EVERYTHING". Without layout there is nothing to measure: jsdom reports every
 * width as 0. Answering `count` is what the row rendered before this existed, so a test that cannot
 * see the overflow sees the full row rather than an empty one.
 */

import { type RefObject, useLayoutEffect, useState } from 'react'

/**
 * The parts of a row the measurement has to find.
 *
 * Attributes rather than the CSS-module class names: those are hashed at build time, and a
 * measurement that depends on the bundler's naming is one that breaks silently in production only.
 */
export const ROW_PART = {
  row: 'data-file-row',
  name: 'data-file-name',
  size: 'data-file-size',
  actions: 'data-file-actions',
} as const

/** Everything {@link visibleRowActions} needs, in px, all of it independent of the action count. */
export interface RowGeometry {
  /** Content width of one row — what the name, the size and the actions share. */
  readonly row: number
  /** The width the name keeps whatever else asks for room (`.name`'s declared minimum). */
  readonly nameMin: number
  /** The size column beside the name, at its widest across the rows on screen. */
  readonly size: number
  /** Gap between the row's three parts. */
  readonly rowGap: number
  /** Outer width of one action control. */
  readonly unit: number
  /** Gap between two action controls. */
  readonly actionGap: number
}

/** No layout to read — see the note on degrading at the top of the file. */
export const UNMEASURED: RowGeometry = {
  row: 0,
  nameMin: 0,
  size: 0,
  rowGap: 0,
  unit: 0,
  actionGap: 0,
}

/**
 * How many of `count` actions the row can show beside a readable name.
 *
 * The remainder belongs in the `⋯` menu, which is itself one of the controls whenever it is there —
 * hence the `fits - 1`. Unlike the mail hook this compares against `count` rather than `count + 1`:
 * the slot the trigger would need is not the thing being rationed here, the name's minimum is, and
 * it is already subtracted.
 */
export function visibleRowActions(geometry: RowGeometry, count: number): number {
  const { row, nameMin, size, rowGap, unit, actionGap } = geometry
  if (row === 0 || unit === 0) return count
  // Three parts, so two gaps — the size column keeps its gap even where it is empty (a folder
  // states no size), because a flex gap sits between items and not between their contents.
  const room = row - nameMin - size - 2 * rowGap
  // n controls occupy n*unit + (n-1)*gap, so the count that fits inverts to this.
  const fits = Math.floor((room + actionGap) / (unit + actionGap))
  return fits >= count ? count : Math.max(0, fits - 1)
}

/**
 * Measure the geometry once for the whole list, and again whenever it can have changed.
 *
 * Once, not per row: every row in a `<ul>` is the same width, and the one thing that does differ —
 * how many actions a node grants — is an argument to {@link visibleRowActions}, not a measurement.
 * A per-row hook would put one `ResizeObserver` on every file in the folder to learn the same number
 * as many times.
 *
 * `revision` is whatever identifies the current listing (the node array). The size column is read
 * from the rows on screen, so a reload that renames `1 KB` to `1.4 MB` has to be re-read even
 * though nothing resized.
 */
export function useRowGeometry(ref: RefObject<HTMLElement | null>, revision: unknown): RowGeometry {
  const [geometry, setGeometry] = useState<RowGeometry>(UNMEASURED)

  // biome-ignore lint/correctness/useExhaustiveDependencies: `revision` is the intended re-measure trigger (a new listing brings new size cells), not a value the effect reads.
  useLayoutEffect(() => {
    const list = ref.current
    if (list === null) {
      setGeometry(UNMEASURED)
      return
    }

    // Replaced only on a real change. The observer watches the list's box, and hiding a button
    // makes rows shorter — so an unconditional `setState` here would re-render, re-measure and
    // re-render again on every pass. The width is what this reads, and the width does not move.
    const measure = (): void => {
      const next = read(list)
      setGeometry((was) => (same(was, next) ? was : next))
    }

    // Measure FIRST and unconditionally, exactly as the mail hook does: without this, every
    // environment lacking `ResizeObserver` — which is every jsdom test — could only ever see the
    // full row, and the split could not be checked at all.
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(list)
    return () => observer.disconnect()
  }, [ref, revision])

  return geometry
}

function same(a: RowGeometry, b: RowGeometry): boolean {
  return (
    a.row === b.row &&
    a.nameMin === b.nameMin &&
    a.size === b.size &&
    a.rowGap === b.rowGap &&
    a.unit === b.unit &&
    a.actionGap === b.actionGap
  )
}

function read(list: HTMLElement): RowGeometry {
  const row = list.querySelector<HTMLElement>(`[${ROW_PART.row}]`)
  const name = list.querySelector<HTMLElement>(`[${ROW_PART.name}]`)
  const actions = list.querySelector<HTMLElement>(`[${ROW_PART.actions}]`)
  const control = actions?.querySelector('button') ?? null
  if (row === null || name === null || actions === null || control === null) return UNMEASURED

  const rowStyle = getComputedStyle(row)
  // The widest size cell in the listing, not this row's: the reserve has to hold for every row, and
  // showing one action fewer because a sibling says "1.4 MB" is the harmless direction to be wrong.
  let size = 0
  for (const cell of list.querySelectorAll<HTMLElement>(`[${ROW_PART.size}]`)) {
    size = Math.max(size, cell.offsetWidth)
  }

  return {
    // `clientWidth` is the padding box; the parts share what is inside it.
    row: row.clientWidth - px(rowStyle.paddingLeft) - px(rowStyle.paddingRight),
    nameMin: px(getComputedStyle(name).minWidth),
    size,
    rowGap: px(rowStyle.columnGap),
    unit: px(getComputedStyle(control).minWidth),
    actionGap: px(getComputedStyle(actions).columnGap),
  }
}

/**
 * A computed length in px, or 0 where there is nothing to read.
 *
 * PHYSICAL property names on purpose. The stylesheet states these logically (`min-inline-size`,
 * `padding-inline`) as the rest of the app does for FR-I18N-02, and in a horizontal writing mode —
 * the only one this app ships, in either direction — each computes to the physical property read
 * here. Left plus right is also the same sum whichever way the text runs, so this is direction-safe
 * as it stands; a vertical writing mode would be the thing that needs it revisited.
 */
function px(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}
