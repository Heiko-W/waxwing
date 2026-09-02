/**
 * Message-list selection model (M1.6, FR-LST-04) — a pure reducer over a Set of selected ids plus a
 * range anchor, so click / ctrl-click / shift-click / select-all behave predictably and it is
 * testable without a DOM.
 *
 * `selectAll` ticks the `ordered` id list it is HANDED, whatever that is; it neither knows nor can
 * discover how much of the query that list covers. Its one caller passes the loaded `queryCache`
 * window — 50 rows to begin with, growing only as `loadMore` pages — so in a folder larger than the
 * window this selects the window and not the folder. That is correct as far as it goes (nothing is
 * ever mis-targeted: the ids in the set are real ids of real rows), but it is NOT the
 * "select-all-in-folder" FR-LST-04 asks for, and this header claimed for a long time that it was.
 * `MessageList` now says so on screen instead of drawing a fully-checked header box over a folder it
 * has only partly selected; the remaining half — an explicit "Select all {{total}}" that pages the
 * rest of the ids out of `Email/query` — is in the post-V1 backlog.
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
}

export const EMPTY_SELECTION: SelectionState = {
  selected: new Set(),
  anchor: null,
  base: new Set(),
}

export type SelectionAction =
  | { readonly type: 'toggle'; readonly id: string }
  | { readonly type: 'range'; readonly id: string; readonly ordered: readonly string[] }
  | { readonly type: 'selectOne'; readonly id: string }
  | { readonly type: 'selectAll'; readonly ordered: readonly string[] }
  | { readonly type: 'clear' }

/** A fresh single-row selection whose anchor + base are reset (start of a new range origin). */
function single(id: string): SelectionState {
  const selected = new Set([id])
  return { selected, anchor: id, base: selected }
}

export function selectionReducer(state: SelectionState, action: SelectionAction): SelectionState {
  switch (action.type) {
    case 'toggle': {
      const selected = new Set(state.selected)
      if (selected.has(action.id)) selected.delete(action.id)
      else selected.add(action.id)
      // The toggled row is the new anchor; its resulting selection is the base for a future range.
      return { selected, anchor: action.id, base: selected }
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
      return { selected, anchor: state.anchor, base: state.base }
    }
    case 'selectOne':
      return single(action.id)
    case 'selectAll': {
      const selected = new Set(action.ordered)
      return { selected, anchor: action.ordered.at(-1) ?? null, base: selected }
    }
    case 'clear':
      return EMPTY_SELECTION
  }
}
