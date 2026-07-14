/**
 * The message list's keyboard-relevant state, hoisted out of the component (M3.8).
 *
 * Until M3.8 the ordered id window, the roving focus index and the selection lived in
 * `MessageList`'s own `useReducer`/`useState`, which meant NOTHING outside that component could read
 * or move them — the single blocking gap for `j`/`k`/`x`/`e`/`#`. They now live in one module-scoped
 * Zustand store (the `composer-store` precedent), so the global key dispatcher and the command
 * palette can drive the list, and the bulk bar still re-renders reactively when `x` toggles a row.
 *
 * The selection model itself is UNCHANGED: this store wraps the existing pure
 * {@link selectionReducer} (`message-selection.ts`) rather than reimplementing it.
 */

import type { Id } from '@waxwing/jmap'
import { create } from 'zustand'
import {
  EMPTY_SELECTION,
  type SelectionAction,
  type SelectionState,
  selectionReducer,
} from './message-selection'

/** The imperative bits only the mounted list can do — registered by `MessageList` while it lives. */
export interface GridHandle {
  /** Scroll a row into view (the virtualizer). */
  scrollToIndex(index: number): void
  /** Move DOM focus back to the `role="grid"` container (it, not the row, holds focus). */
  focus(): void
  /** Open a row the way a click does — drafts back into the composer, mail into the reading pane. */
  open(id: Id): void
}

export interface ListState {
  /** Identity of the current window (mailbox + sort + search). Changing it resets focus/selection. */
  readonly windowKey: string
  /** Server-ordered ids of the window. */
  readonly ids: readonly Id[]
  readonly focusIndex: number
  readonly selection: SelectionState
  /** The `from` of a move; `null` in a cross-folder search (moves are gated off there). */
  readonly sourceMailboxId: Id | null
  /** The `l` picker's targets — rendered by `MessageList`; `null` = closed. */
  readonly labelTargets: Id[] | null
  readonly grid: GridHandle | null
}

export interface ListController {
  /** Publish the current window. A new `windowKey` resets the focus, the selection and the picker. */
  setWindow(windowKey: string, ids: readonly Id[], sourceMailboxId: Id | null): void
  select(action: SelectionAction): void
  /** Move the roving focus by `delta` (clamped), scrolling it into view and refocusing the grid. */
  moveFocus(delta: number): void
  /** Set the roving focus to an absolute index (clamped). Does not touch DOM focus. */
  focusIndexTo(index: number): void
  requestLabels(ids: Id[] | null): void
  setGridHandle(handle: GridHandle | null): void
}

export type ListStore = ListState & ListController

export const EMPTY_LIST_STATE: ListState = {
  windowKey: '',
  ids: [],
  focusIndex: 0,
  selection: EMPTY_SELECTION,
  sourceMailboxId: null,
  labelTargets: null,
  grid: null,
}

function clamp(index: number, length: number): number {
  return Math.max(0, Math.min(index, length - 1))
}

function sameIds(a: readonly Id[], b: readonly Id[]): boolean {
  return a === b || (a.length === b.length && a.every((id, index) => id === b[index]))
}

/**
 * Drop everything the incoming window no longer contains. A selected id that has left the window (a
 * sibling tab moved it, a push removed it, an account switch reused the same window key) is invisible
 * and un-deselectable, yet `targetIds` would still put it FIRST — so the next `e` would archive a
 * message the user cannot see. The anchor/base follow the same rule.
 */
function pruneSelection(selection: SelectionState, ids: readonly Id[]): SelectionState {
  const live = new Set<string>(ids)
  const selected = new Set<string>()
  for (const id of selection.selected) if (live.has(id)) selected.add(id)
  if (selected.size === selection.selected.size) return selection
  const base = new Set<string>()
  for (const id of selection.base) if (live.has(id)) base.add(id)
  return {
    selected,
    anchor: selection.anchor !== null && live.has(selection.anchor) ? selection.anchor : null,
    base,
  }
}

export const useListStore = create<ListStore>()((set, get) => ({
  ...EMPTY_LIST_STATE,

  setWindow(windowKey, ids, sourceMailboxId) {
    const current = get()
    if (current.windowKey === windowKey) {
      // Same window, new page (or an optimistic removal): keep focus + selection…
      if (sameIds(current.ids, ids) && current.sourceMailboxId === sourceMailboxId) return
      // …but re-anchor the focus BY ID, not by index. `e` on the open message advances the focus to
      // index+1; when the archived message then leaves the window every row shifts up one, and a
      // clamped index would silently land on the row AFTER the one the reading pane is showing —
      // `x` would tick the wrong message and `j` would skip one. Only when the focused id is gone
      // altogether (it was the one just archived) does the index carry over, clamped.
      const focusedId = current.ids[current.focusIndex]
      const found = focusedId !== undefined ? ids.indexOf(focusedId) : -1
      set({
        ids,
        sourceMailboxId,
        focusIndex: found >= 0 ? found : clamp(current.focusIndex, ids.length),
        selection: pruneSelection(current.selection, ids),
      })
      return
    }
    set({
      windowKey,
      ids,
      sourceMailboxId,
      focusIndex: 0,
      selection: EMPTY_SELECTION,
      labelTargets: null,
    })
  },

  select(action) {
    set({ selection: selectionReducer(get().selection, action) })
  },

  moveFocus(delta) {
    const { ids, focusIndex, grid } = get()
    if (ids.length === 0) return
    const next = clamp(focusIndex + delta, ids.length)
    set({ focusIndex: next })
    grid?.scrollToIndex(next)
    grid?.focus()
  },

  focusIndexTo(index) {
    const { ids } = get()
    if (ids.length === 0) return
    set({ focusIndex: clamp(index, ids.length) })
  },

  requestLabels(ids) {
    set({ labelTargets: ids })
  },

  setGridHandle(handle) {
    set({ grid: handle })
  },
}))
