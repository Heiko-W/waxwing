import { describe, expect, it } from 'vitest'
import { daysAgoIso } from './use-cleanup-actions'

describe('daysAgoIso', () => {
  const now = Date.parse('2026-07-12T15:30:00.000Z')

  it('returns the UTC-midnight boundary N days before now', () => {
    expect(daysAgoIso(30, now)).toBe('2026-06-12T00:00:00.000Z')
    expect(daysAgoIso(1, now)).toBe('2026-07-11T00:00:00.000Z')
  })

  it('floors today to UTC midnight for 0 days', () => {
    expect(daysAgoIso(0, now)).toBe('2026-07-12T00:00:00.000Z')
  })
})
