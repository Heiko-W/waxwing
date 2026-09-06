/**
 * Painting an event in its calendar's colour (#79) — and the rules that keep it readable.
 *
 * Until the merged calendar every chip on this screen was `--waxwing-surface-selected`, whatever
 * calendar it came from. That was defensible while the screen showed one account: the rail's tinted
 * tick boxes were the only legend anybody needed, and a month of identically coloured chips is
 * quiet. It stops being defensible the moment a group's calendar and the reader's own are drawn in
 * the SAME grid — "is that meeting mine or theirs?" is then a question the grid refuses to answer,
 * and it is the question the merged view exists to answer.
 *
 * So an event now wears the colour of its calendar. Deliberately in EVERY case, single account
 * included: a rule with an exception is a rule nobody can predict, and the colours a reader chose in
 * `CalendarDialog` were until now visible on eight tick boxes and nowhere else.
 *
 * **How the colour is applied is a legibility decision, not a styling one.** See the notes beside
 * `.chipColored` and `.rowColored` in `calendar.module.css`: the text colour never changes, the
 * calendar's hue carries the identity as a BAR or a DOT at full strength, and the chip's own surface
 * is tinted by a bounded amount so it stays a surface. Filling the chip with the palette value and
 * leaving `--waxwing-text` on top of it would have failed on at least three of the eight — the
 * palette was chosen for a white TICK on a 1.15rem swatch (`CALENDAR_COLORS`), which is a different
 * contrast question from body text on a full-width block.
 *
 * The colour is redundant information, never sole information (WCAG 1.4.1): which calendar an event
 * is in is stated in words in the editor's picker, and the rail names every calendar it tints. The
 * accessible name of a chip is unchanged, which is also why nothing here touches the children — a
 * screen reader hears the title, exactly as before.
 */

import type { CSSProperties } from 'react'
import styles from './calendar.module.css'

/** `className` plus, when there is a colour, the custom property the stylesheet reads. */
export type EventColorProps =
  | { readonly className: string }
  | { readonly className: string; readonly style: CSSProperties }

/**
 * The custom property carrying one calendar's colour into the stylesheet.
 *
 * An inline custom property rather than an inline `background`: the colour is DATA (it is stored on
 * the server and read by Apple Calendar and Thunderbird alike), but how much of it to show, over
 * which surface and in which theme is design — and that belongs in the stylesheet, where
 * `color-mix` can see the theme's own tokens. An inline `background: #c2372f` could not be
 * theme-aware at all.
 *
 * NOT in the `--waxwing-*` namespace, and that is the rule rather than an oversight: that namespace
 * is the design tokens, every one of which is declared in `tokens.css` and checked to be
 * (`tokens.references.css.test.ts`). This is a per-element channel carrying a value the SERVER
 * owns — the same category as `--compose-label` and `--settings-rail`.
 */
function withColor(className: string, color: string): EventColorProps {
  return {
    className,
    // The cast is the standard one for a custom property: `CSSProperties` has no index signature,
    // and React passes anything starting with `--` through to the style attribute untouched.
    style: { '--calendar-color': color } as CSSProperties,
  }
}

/**
 * A month-cell chip, a week block or the week's whole-day band — the compact forms, where the
 * colour is a leading BAR and a tint of the chip's own surface. There is no room for a dot beside
 * a title that is already being truncated at 90px.
 */
export function chipColor(base: string | undefined, color: string | null): EventColorProps {
  const className = base ?? ''
  return color === null ? { className } : withColor(`${className} ${styles.chipColored}`, color)
}

/**
 * An agenda row or a day-dialog row — the roomy forms, where the colour is a DOT before the row.
 *
 * A dot rather than the chip's bar-and-tint, and the reason is what a tinted full-width row reads
 * as: selection. Both of these lists already use a background change for hover, and adding a second
 * one for "belongs to the red calendar" would make a red event look permanently pointed at. The dot
 * is what Apple's own agenda uses, and it is a `::before` so the row's children — the ones a screen
 * reader reads — are untouched.
 */
export function rowColor(base: string | undefined, color: string | null): EventColorProps {
  const className = base ?? ''
  return color === null ? { className } : withColor(`${className} ${styles.rowColored}`, color)
}
