import { describe, expect, it } from 'vitest'
import {
  isCustomKeyword,
  MAX_KEYWORD_LENGTH,
  makeLabel,
  mergeLabels,
  slugKeyword,
  validateLabelName,
} from './label-model'

describe('slugKeyword', () => {
  it('lower-cases and collapses each run of unsafe chars to a single underscore', () => {
    expect(slugKeyword('Work Stuff')).toBe('work_stuff')
    expect(slugKeyword('a   b')).toBe('a_b') // multiple spaces collapse
    expect(slugKeyword('a (b) c')).toBe('a_b_c')
    expect(slugKeyword('a"b\\c]d')).toBe('a_b_c_d') // IMAP specials
  })

  it('preserves safe printable ASCII including underscores and $', () => {
    expect(slugKeyword('a__b')).toBe('a__b') // underscore is safe, not collapsed
    expect(slugKeyword('$Foo')).toBe('$foo') // $ survives slugging (validate rejects it)
  })

  it('trims leading and trailing underscores', () => {
    expect(slugKeyword('  Hi!  ')).toBe('hi!')
    expect(slugKeyword('Café ☕')).toBe('caf') // non-ASCII is unsafe; trailing run trimmed
  })

  it('returns null when nothing usable remains', () => {
    expect(slugKeyword('')).toBeNull()
    expect(slugKeyword('   ')).toBeNull()
    expect(slugKeyword('***')).toBeNull()
  })
})

describe('isCustomKeyword', () => {
  it('is true only for non-system, non-$ keywords', () => {
    expect(isCustomKeyword('work')).toBe(true)
    expect(isCustomKeyword('$seen')).toBe(false)
    expect(isCustomKeyword('$flagged')).toBe(false)
    expect(isCustomKeyword('$custom')).toBe(false) // any $-prefixed is reserved
    expect(isCustomKeyword('')).toBe(false)
  })
})

describe('validateLabelName', () => {
  it('rejects empty / whitespace-only names', () => {
    expect(validateLabelName('', [])).toBe('empty')
    expect(validateLabelName('   ', [])).toBe('empty')
    expect(validateLabelName('***', [])).toBe('empty')
  })

  it('rejects a slug longer than the max', () => {
    expect(validateLabelName('x'.repeat(MAX_KEYWORD_LENGTH + 1), [])).toBe('tooLong')
    expect(validateLabelName('x'.repeat(MAX_KEYWORD_LENGTH), [])).toBeNull()
  })

  it('rejects a leading-$ (system namespace) as taken', () => {
    expect(validateLabelName('$foo', [])).toBe('taken')
  })

  it('rejects a case-insensitive collision with an existing keyword', () => {
    expect(validateLabelName('Work', ['work'])).toBe('taken')
    expect(validateLabelName('Work', ['other'])).toBeNull()
  })
})

describe('makeLabel', () => {
  it('builds a validated label with the trimmed display name and its slug', () => {
    expect(makeLabel('  Work Stuff  ', 'blue', [])).toEqual({
      keyword: 'work_stuff',
      name: 'Work Stuff',
      color: 'blue',
    })
  })

  it('returns null for an invalid or colliding name', () => {
    expect(makeLabel('', 'red', [])).toBeNull()
    expect(makeLabel('work', 'red', ['work'])).toBeNull()
  })
})

describe('mergeLabels', () => {
  it('lists registry first, then discovered custom keywords, excluding system keywords', () => {
    const merged = mergeLabels(
      [{ keyword: 'a', name: 'Alpha', color: 'red' }],
      ['a', 'b', '$seen', 'c'],
    )
    expect(merged).toEqual([
      { keyword: 'a', name: 'Alpha', color: 'red', discovered: false },
      { keyword: 'b', name: 'b', color: 'gray', discovered: true },
      { keyword: 'c', name: 'c', color: 'gray', discovered: true },
    ])
  })

  it('de-duplicates discovered keywords against the registry case-insensitively', () => {
    const merged = mergeLabels(
      [{ keyword: 'work', name: 'Work', color: 'green' }],
      ['Work', 'play'],
    )
    expect(merged.map((label) => label.keyword)).toEqual(['work', 'play'])
  })

  it('de-duplicates discovered keywords among themselves', () => {
    const merged = mergeLabels([], ['dup', 'dup', 'other'])
    expect(merged.map((label) => label.keyword)).toEqual(['dup', 'other'])
  })
})
