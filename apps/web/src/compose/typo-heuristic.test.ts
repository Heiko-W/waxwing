import { describe, expect, it } from 'vitest'
import { levenshtein, suggestDomainCorrection } from './typo-heuristic'

describe('levenshtein', () => {
  it.each([
    ['', '', 0],
    ['abc', 'abc', 0],
    ['abc', 'abd', 1],
    ['gmial.com', 'gmail.com', 2], // transposition = 2 single edits
    ['gmai.com', 'gmail.com', 1], // one insertion
    ['', 'abc', 3],
  ])('d(%s,%s) = %i', (a, b, expected) => {
    expect(levenshtein(a, b)).toBe(expected)
  })
})

describe('suggestDomainCorrection', () => {
  it.each([
    ['user@gmial.com', 'user@gmail.com'],
    ['user@gmai.com', 'user@gmail.com'],
    ['user@web.d', 'user@web.de'],
    ['user@hotmial.com', 'user@hotmail.com'],
  ])('%s → %s', (input, expected) => {
    expect(suggestDomainCorrection(input)).toBe(expected)
  })

  it.each([
    ['user@gmail.com'], // already a known provider
    ['user@my-own-company.com'], // far from any provider
    ['not-an-email'], // implausible
    ['user@example.com'], // not close to any provider within threshold
  ])('%s → null', (input) => {
    expect(suggestDomainCorrection(input)).toBeNull()
  })

  it('respects a tighter maxDistance', () => {
    expect(suggestDomainCorrection('user@gmial.com', 1)).toBeNull()
    expect(suggestDomainCorrection('user@gmial.com', 2)).toBe('user@gmail.com')
  })
})
