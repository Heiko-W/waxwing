import { describe, expect, it } from 'vitest'
import { pushRecent, RECENTS_CAP } from './recents'

describe('pushRecent', () => {
  it('puts the newest first', () => {
    expect(pushRecent([], 'a')).toEqual(['a'])
    expect(pushRecent(['a'], 'b')).toEqual(['b', 'a'])
  })

  it('dedupes by promoting an existing id rather than repeating it', () => {
    expect(pushRecent(['a', 'b', 'c'], 'c')).toEqual(['c', 'a', 'b'])
    expect(pushRecent(['a', 'b', 'c'], 'a')).toEqual(['a', 'b', 'c'])
  })

  it('caps the list', () => {
    const many = Array.from({ length: RECENTS_CAP }, (_, index) => `id-${index}`)
    const next = pushRecent(many, 'fresh')
    expect(next).toHaveLength(RECENTS_CAP)
    expect(next[0]).toBe('fresh')
    expect(next).not.toContain(`id-${RECENTS_CAP - 1}`) // the oldest fell off
  })

  it('honours an explicit cap', () => {
    expect(pushRecent(['a', 'b'], 'c', 2)).toEqual(['c', 'a'])
  })
})
