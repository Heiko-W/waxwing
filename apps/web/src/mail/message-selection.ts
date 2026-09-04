/**
 * Message-list selection model (M1.6, FR-LST-04) — a pure reducer over a Set of selected ids plus a
 * range anchor, so click / ctrl-click / shift-click / select-all behave predictably and it is
 * testable without a DOM.
 *
 * TWO select-alls, because there are two honest answers to "all of what?".
 *
 * `selectAll` ticks the `ordered` id list it is HANDED, whatever that is; it neither knows nor can
 * discover how much of the query that list covers. Its one caller passes the loaded `queryCache`
 * window — 50 rows to begin with, growing only as `loadMore` pages — so in a folder larger than the
 * window this selects the window and not the folder. Nothing is ever mis-targeted (the ids in the
 * set are real ids of real rows), but it is not "select-all-in-folder" and this header claimed for a
 * long time that it was.
 *
 * `selectAllInQuery` is that second half (FR-LST-04, R-08 stage 2). It is handed the ids of the
 * WHOLE query, paged out of `Email/query` by the surface that offers it, and it marks the resulting
 * state {@link SelectionState.beyondWindow} — the one bit downstream needs, because a selection that
 * deliberately reaches past the loaded window must not be pruned back to it (`list-store.ts`).
 *
 * The ids are a SNAPSHOT, not a subscription: they are what matched at the moment of the click, and
 * every later action targets exactly those. A message that arrives afterwards is not in the set, and
 * the bar says the number it actually holds rather than "all", so nothing here promises otherwise.
 */

export interface SelectionState {
  readonly selected: ReadonlySet<string>
  /** The last individually-toggled row — the origin for a shift-click range. */
  readonly anchor: string | null
  /**
   * Selection snapshot at the moment the anchor was set — the base a shift-range is applied ON TOP
   * of. Re-ranging from the same anchor recomputes `base ∪ (anchor..end)`, so a shift-selection can
   * SHRINK when the user shift-clicks back toward the anchor, while ctrl-toggled rows are preserved.
   */
  readonly base: ReadonlySet<string>
  /**
   * The selection reaches past the loaded window ON PURPOSE — it came from a "Select all {{total}}"
   * over the query, so most of its ids have no row on screen and never will until `loadMore` pages
   * them in.
   *
   * It exists for `list-store.ts`'s prune, which drops any selected id the window no longer lists.
   * That rule is right for a window selection (an id that left is invisible and un-deselectable, yet
   * would still be acted on) and would silently discard 250 of 300 here. Un-ticking a row keeps the
   * bit — 299 of 300 still reaches past the window — while anything that REPLACES the selection
   * (`selectOne`, a window `selectAll`, `clear`) clears it, because the reader has chosen a new
   * scope.
   */
  readonly beyondWindow: boolean
}

export const EMPTY_SELECTION: SelectionState = {
  selected: new Set(),
  anchor: null,
  base: new Set(),
  beyondWindow: false,
}

export type SelectionAction =
  | { readonly type: 'toggle'; readonly id: string }
  | { readonly type: 'range'; readonly id: string; readonly ordered: readonly string[] }
  | { readonly type: 'selectOne'; readonly id: string }
  | { readonly type: 'selectAll'; readonly ordered: readonly string[] }
  /** Every id the query matched, paged out of `Email/query` by the caller (R-08 stage 2). */
  | { readonly type: 'selectAllInQuery'; readonly ids: readonly string[] }
  | { readonly type: 'clear' }

/** A fresh single-row selection whose anchor + base are reset (start of a new range origin). */
function single(id: string): SelectionState {
  const selected = new Set([id])
  return { selected, anchor: id, base: selected, beyondWindow: false }
}

export function selectionReducer(state: SelectionState, action: SelectionAction): SelectionState {
  switch (action.type) {
    case 'toggle': {
      const selected = new Set(state.selected)
      if (selected.has(action.id)) selected.delete(action.id)
      else selected.add(action.id)
      // The toggled row is the new anchor; its resulting selection is the base for a future range.
      // `beyondWindow` rides along: un-ticking one of 300 leaves 299 that still reach past the
      // window, and dropping the bit here would let the next prune throw them away.
      return { selected, anchor: action.id, base: selected, beyondWindow: state.beyondWindow }
    }
    case 'range': {
      if (state.anchor === null) return single(action.id)
      const from = action.ordered.indexOf(state.anchor)
      const to = action.ordered.indexOf(action.id)
      if (from < 0 || to < 0) return single(action.id)
      const [lo, hi] = from <= to ? [from, to] : [to, from]
      const selected = new Set(state.base) // recompute from base so the range can shrink
      for (let i = lo; i <= hi; i += 1) {
        const id = action.ordered[i]
        if (id !== undefined) selected.add(id)
      }
      return { selected, anchor: state.anchor, base: state.base, beyondWindow: state.beyondWindow }
    }
    case 'selectOne':
      return single(action.id)
    case 'selectAll': {
      const selected = new Set(action.ordered)
      return {
        selected,
        anchor: action.ordered.at(-1) ?? null,
        base: selected,
        beyondWindow: false,
      }
    }
    case 'selectAllInQuery': {
      const selected = new Set(action.ids)
      // NO anchor. An anchor is the origin of a shift-range, and `range` resolves it by index in the
      // list it is handed — the loaded window — where all but the first page of these ids simply are
      // not. A null anchor makes the next shift-click start a fresh range from the clicked row,
      // which is what `range` already does when it cannot place one.
      return { selected, anchor: null, base: selected, beyondWindow: true }
    }
    case 'clear':
      return EMPTY_SELECTION
  }
}
