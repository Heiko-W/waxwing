/**
 * Saved searches (M5.5, FR-SRCH-03).
 *
 * The interesting choices are what a malformed stored entry does — it is skipped, not repaired —
 * and that an unrecognised scope widens rather than narrows.
 */

import { describe, expect, it } from 'vitest'
import {
  addSavedSearch,
  coerceSavedSearches,
  defaultName,
  findByQuery,
  MAX_SAVED_SEARCHES,
  removeSavedSearch,
  type SavedSearch,
} from './saved-searches'

const saved = (over: Partial<SavedSearch> = {}): SavedSearch => ({
  id: 's1',
  name: 'From Ada',
  query: 'from:ada',
  scope: 'all',
  ...over,
})

describe('coerceSavedSearches', () => {
  it('reads a well-formed list', () => {
    expect(coerceSavedSearches([saved()])).toEqual([saved()])
  })

  it('is empty for anything that is not a list', () => {
    for (const value of [null, undefined, 0, 'x', {}]) {
      expect(coerceSavedSearches(value)).toEqual([])
    }
  })

  it('skips an entry with no query — it would be a folder that shows everything', () => {
    expect(coerceSavedSearches([{ id: 'a', name: 'n', query: '   ' }, saved()])).toEqual([saved()])
  })

  it('WIDENS an unrecognised scope instead of narrowing it', () => {
    // A saved search that silently narrowed itself to one folder looks like it lost results.
    expect(coerceSavedSearches([{ ...saved(), scope: 'nonsense' }])[0]?.scope).toBe('all')
  })

  it('keeps an explicit folder scope', () => {
    expect(coerceSavedSearches([{ ...saved(), scope: 'folder' }])[0]?.scope).toBe('folder')
  })

  it('caps the list', () => {
    const many = Array.from({ length: MAX_SAVED_SEARCHES + 5 }, (_, i) => saved({ id: `s${i}` }))
    expect(coerceSavedSearches(many)).toHaveLength(MAX_SAVED_SEARCHES)
  })
})

describe('add / remove', () => {
  it('replaces by id rather than duplicating', () => {
    const next = addSavedSearch([saved()], saved({ name: 'Renamed' }))
    expect(next).toHaveLength(1)
    expect(next[0]?.name).toBe('Renamed')
  })

  it('appends a different one', () => {
    expect(addSavedSearch([saved()], saved({ id: 's2' }))).toHaveLength(2)
  })

  it('removes by id', () => {
    expect(removeSavedSearch([saved(), saved({ id: 's2' })], 's1')).toEqual([saved({ id: 's2' })])
  })
})

describe('findByQuery', () => {
  it('matches on the query and the scope, ignoring surrounding whitespace', () => {
    expect(findByQuery([saved()], '  from:ada  ', 'all')?.id).toBe('s1')
  })

  it('does not match the same query at a different scope', () => {
    // "From Ada, in this folder" and "From Ada, everywhere" are two different saved searches.
    expect(findByQuery([saved()], 'from:ada', 'folder')).toBeUndefined()
  })
})

describe('defaultName', () => {
  it('uses the query itself', () => {
    expect(defaultName('from:ada')).toBe('from:ada')
  })

  it('clamps a long query with an ellipsis', () => {
    const name = defaultName('x'.repeat(60), 10)
    expect(name).toHaveLength(10)
    expect(name.endsWith('…')).toBe(true)
  })
})
