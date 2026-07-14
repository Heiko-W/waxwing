import { describe, expect, it } from 'vitest'
import { fold, fuzzyMatch } from './fuzzy'

const score = (query: string, text: string): number => fuzzyMatch(query, text)?.score ?? Number.NaN

describe('fold', () => {
  it('lowercases, strips combining marks and expands ß', () => {
    expect(fold('Entwürfe')).toBe('entwurfe')
    expect(fold('Grüßen')).toBe('grussen')
    expect(fold('ARCHIVE')).toBe('archive')
  })
})

describe('fuzzyMatch', () => {
  it('matches a subsequence and misses a non-subsequence', () => {
    expect(fuzzyMatch('arch', 'Archive')).not.toBeNull()
    expect(fuzzyMatch('gtf', 'Go to folder: Inbox')).not.toBeNull()
    expect(fuzzyMatch('zzz', 'Archive')).toBeNull()
    // Order matters — a subsequence, not a bag of characters.
    expect(fuzzyMatch('hcra', 'Archive')).toBeNull()
  })

  it('an empty query matches everything with score 0', () => {
    expect(fuzzyMatch('', 'Archive')).toEqual({ score: 0, positions: [] })
  })

  it('a consecutive run beats a scattered match', () => {
    expect(score('ab', 'ab')).toBeGreaterThan(score('ab', 'axb'))
  })

  it('a word-boundary match beats a mid-word one', () => {
    expect(score('w', 'foo world')).toBeGreaterThan(score('w', 'swim'))
  })

  it('folds the text — "entwurfe" finds "Entwürfe"', () => {
    expect(fuzzyMatch('entwurfe', 'Entwürfe')).not.toBeNull()
    expect(fuzzyMatch('grussen', 'Grüßen')).not.toBeNull()
  })

  it('reports the matched positions as indices into the ORIGINAL text', () => {
    expect(fuzzyMatch('arc', 'Archive')?.positions).toEqual([0, 1, 2])
    // "Entwürfe": the ü is one source character even though it folds to one char after mark-stripping.
    expect(fuzzyMatch('ent', 'Entwürfe')?.positions).toEqual([0, 1, 2])
    // ß folds to "ss" — both folded characters map back to the SAME source index (deduped).
    expect(fuzzyMatch('gruss', 'Grüßen')?.positions).toEqual([0, 1, 2, 3])
  })
})
