import { describe, expect, it } from 'vitest'
import { EMPTY_SELECTION, type SelectionState, selectionReducer } from './message-selection'

const IDS = ['a', 'b', 'c', 'd', 'e']

function of(ids: string[], anchor: string | null, beyondWindow = false): SelectionState {
  const selected = new Set(ids)
  return { selected, anchor, base: selected, beyondWindow }
}

describe('selectionReducer', () => {
  it('toggles an id and sets it as the anchor', () => {
    const one = selectionReducer(EMPTY_SELECTION, { type: 'toggle', id: 'b' })
    expect([...one.selected]).toEqual(['b'])
    expect(one.anchor).toBe('b')
    const off = selectionReducer(one, { type: 'toggle', id: 'b' })
    expect(off.selected.size).toBe(0)
    expect(off.anchor).toBe('b')
  })

  it('selects a forward range from the anchor (shift-click)', () => {
    const anchored = of(['b'], 'b')
    const ranged = selectionReducer(anchored, { type: 'range', id: 'd', ordered: IDS })
    expect([...ranged.selected].sort()).toEqual(['b', 'c', 'd'])
    expect(ranged.anchor).toBe('b')
  })

  it('selects a backward range from the anchor', () => {
    const anchored = of(['d'], 'd')
    const ranged = selectionReducer(anchored, { type: 'range', id: 'b', ordered: IDS })
    expect([...ranged.selected].sort()).toEqual(['b', 'c', 'd'])
  })

  it('range without an anchor selects just the clicked id', () => {
    const ranged = selectionReducer(EMPTY_SELECTION, { type: 'range', id: 'c', ordered: IDS })
    expect([...ranged.selected]).toEqual(['c'])
    expect(ranged.anchor).toBe('c')
  })

  it('selectAll selects the whole ordered id-set (not just loaded rows)', () => {
    const all = selectionReducer(EMPTY_SELECTION, { type: 'selectAll', ordered: IDS })
    expect(all.selected.size).toBe(5)
    expect(all.anchor).toBe('e')
  })

  /**
   * `selectAllInQuery` (R-08 stage 2) — the ids of the WHOLE query, paged out of `Email/query` by
   * the caller. It differs from `selectAll` in the one bit downstream needs: `beyondWindow`, which
   * tells the store's prune that ids outside the loaded window are there on purpose.
   */
  it('selectAllInQuery marks the selection as reaching past the window, with no anchor', () => {
    const all = selectionReducer(EMPTY_SELECTION, {
      type: 'selectAllInQuery',
      ids: ['a', 'x', 'y'],
    })
    expect([...all.selected]).toEqual(['a', 'x', 'y'])
    expect(all.beyondWindow).toBe(true)
    // No anchor: a shift-range resolves it by index in the LOADED window, where 'x' and 'y' are not.
    expect(all.anchor).toBeNull()
  })

  it('un-ticking one of them keeps the rest beyond the window', () => {
    const all = selectionReducer(EMPTY_SELECTION, { type: 'selectAllInQuery', ids: ['a', 'x'] })
    const one = selectionReducer(all, { type: 'toggle', id: 'a' })
    expect([...one.selected]).toEqual(['x'])
    expect(one.beyondWindow).toBe(true)
  })

  it('anything that REPLACES the selection gives the scope back to the window', () => {
    const all = selectionReducer(EMPTY_SELECTION, { type: 'selectAllInQuery', ids: ['a', 'x'] })
    expect(selectionReducer(all, { type: 'selectOne', id: 'a' }).beyondWindow).toBe(false)
    expect(selectionReducer(all, { type: 'selectAll', ordered: IDS }).beyondWindow).toBe(false)
    expect(selectionReducer(all, { type: 'clear' }).beyondWindow).toBe(false)
    // A shift-range from a query selection has no anchor to range FROM, so it starts a new one.
    expect(selectionReducer(all, { type: 'range', id: 'c', ordered: IDS }).beyondWindow).toBe(false)
  })

  it('selectOne replaces the selection', () => {
    const one = selectionReducer(of(['a', 'b'], 'b'), { type: 'selectOne', id: 'd' })
    expect([...one.selected]).toEqual(['d'])
  })

  it('clear empties the selection', () => {
    expect(selectionReducer(of(['a', 'b'], 'b'), { type: 'clear' })).toBe(EMPTY_SELECTION)
  })

  it('a shift-range shrinks when re-ranged back toward the anchor', () => {
    const anchored = selectionReducer(EMPTY_SELECTION, { type: 'toggle', id: 'b' })
    const wide = selectionReducer(anchored, { type: 'range', id: 'd', ordered: IDS })
    expect([...wide.selected].sort()).toEqual(['b', 'c', 'd'])
    const narrow = selectionReducer(wide, { type: 'range', id: 'c', ordered: IDS })
    expect([...narrow.selected].sort()).toEqual(['b', 'c']) // 'd' dropped, not stuck
  })

  it('preserves ctrl-toggled ids when shift-ranging from a later anchor', () => {
    const a = selectionReducer(EMPTY_SELECTION, { type: 'toggle', id: 'a' })
    const c = selectionReducer(a, { type: 'toggle', id: 'c' }) // anchor c, base {a,c}
    const ranged = selectionReducer(c, { type: 'range', id: 'e', ordered: IDS })
    expect([...ranged.selected].sort()).toEqual(['a', 'c', 'd', 'e'])
  })
})
