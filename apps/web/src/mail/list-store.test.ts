import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_LIST_STATE, type GridHandle, useListStore } from './list-store'

const store = () => useListStore.getState()

beforeEach(() => {
  useListStore.setState(EMPTY_LIST_STATE)
})

describe('useListStore', () => {
  it('setWindow with a NEW key resets the focus, the selection and the label picker', () => {
    store().setWindow('w1', ['a', 'b', 'c'], 'inbox')
    store().moveFocus(2)
    store().select({ type: 'toggle', id: 'b' })
    store().requestLabels(['b'])
    expect(store().focusIndex).toBe(2)
    expect(store().selection.selected.has('b')).toBe(true)

    store().setWindow('w2', ['x', 'y'], 'archive')
    expect(store().focusIndex).toBe(0)
    expect(store().selection.selected.size).toBe(0)
    expect(store().labelTargets).toBeNull()
    expect(store().sourceMailboxId).toBe('archive')
  })

  it('setWindow with the SAME key keeps a selection that is still IN the window', () => {
    store().setWindow('w1', ['a', 'b', 'c'], 'inbox')
    store().select({ type: 'toggle', id: 'a' })

    store().setWindow('w1', ['a', 'b'], 'inbox') // 'c' was archived away
    expect(store().selection.selected.has('a')).toBe(true)
    expect(store().windowKey).toBe('w1')
  })

  // A selected id that has LEFT the window is invisible and un-deselectable — but `targetIds` would
  // still put it first, so the next `e` would archive a message the user cannot see.
  it('setWindow PRUNES a selection whose ids are no longer in the window', () => {
    store().setWindow('w1', ['a', 'b', 'c'], 'inbox')
    store().select({ type: 'toggle', id: 'a' })
    store().select({ type: 'toggle', id: 'c' })
    expect(store().selection.selected.size).toBe(2)

    store().setWindow('w1', ['b', 'c'], 'inbox') // another tab archived 'a'
    expect([...store().selection.selected]).toEqual(['c'])
    expect(store().selection.anchor).toBe('c')
    expect([...store().selection.base]).toEqual(['c'])
  })

  // THE auto-advance bug: reading 'a', `e` advances the focus to index 1 ('b') and opens it; the move
  // then lands and 'a' leaves the window. A CLAMPED index would leave the focus on index 1 — which is
  // now 'c' — while the reading pane shows 'b': `x` ticks the wrong message and `j` skips one.
  it('setWindow re-anchors the roving focus BY ID when rows shift up', () => {
    store().setWindow('w1', ['a', 'b', 'c', 'd'], 'inbox')
    store().focusIndexTo(1)
    expect(store().ids[store().focusIndex]).toBe('b')

    store().setWindow('w1', ['b', 'c', 'd'], 'inbox') // 'a' was archived
    expect(store().focusIndex).toBe(0)
    expect(store().ids[store().focusIndex]).toBe('b') // still 'b', not 'c'
  })

  it('setWindow falls back to a clamp when the focused id is gone entirely', () => {
    store().setWindow('w1', ['a', 'b', 'c'], 'inbox')
    store().focusIndexTo(2) // 'c'

    store().setWindow('w1', ['a', 'b'], 'inbox') // 'c' itself was archived
    expect(store().focusIndex).toBe(1) // clamped into the shorter window
  })

  it('moveFocus clamps at both ends', () => {
    store().setWindow('w1', ['a', 'b', 'c'], 'inbox')
    store().moveFocus(-1)
    expect(store().focusIndex).toBe(0)
    store().moveFocus(99)
    expect(store().focusIndex).toBe(2)
    store().moveFocus(1)
    expect(store().focusIndex).toBe(2)
  })

  it('moveFocus is a no-op on an empty window (and never touches the grid)', () => {
    const grid: GridHandle = { scrollToIndex: vi.fn(), focus: vi.fn(), open: vi.fn() }
    store().setGridHandle(grid)
    store().setWindow('empty', [], null)
    store().moveFocus(1)
    expect(store().focusIndex).toBe(0)
    expect(grid.scrollToIndex).not.toHaveBeenCalled()
  })

  it('moveFocus scrolls the target into view and returns DOM focus to the grid', () => {
    const grid: GridHandle = { scrollToIndex: vi.fn(), focus: vi.fn(), open: vi.fn() }
    store().setGridHandle(grid)
    store().setWindow('w1', ['a', 'b', 'c'], 'inbox')
    store().moveFocus(1)
    expect(grid.scrollToIndex).toHaveBeenCalledWith(1)
    expect(grid.focus).toHaveBeenCalled()
  })

  it('select delegates to the pure selection reducer (range needs an anchor)', () => {
    store().setWindow('w1', ['a', 'b', 'c'], 'inbox')
    store().select({ type: 'toggle', id: 'a' })
    store().select({ type: 'range', id: 'c', ordered: ['a', 'b', 'c'] })
    expect([...store().selection.selected]).toEqual(['a', 'b', 'c'])
    store().select({ type: 'clear' })
    expect(store().selection.selected.size).toBe(0)
  })
})
