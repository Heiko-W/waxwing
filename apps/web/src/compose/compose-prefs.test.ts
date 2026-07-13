import { describe, expect, it } from 'vitest'
import { coerceSignaturePlacement, coerceUndoSendSeconds } from './compose-prefs'

describe('coerceUndoSendSeconds', () => {
  it('accepts the values the picker actually offers', () => {
    expect(coerceUndoSendSeconds(0)).toBe(0)
    expect(coerceUndoSendSeconds(5)).toBe(5)
    expect(coerceUndoSendSeconds(15)).toBe(15)
    expect(coerceUndoSendSeconds(30)).toBe(30)
  })

  it('falls back to "no preference" for anything else — including a value we once offered', () => {
    // `null` means "use the deployment default", which is the right answer for a stored value we no
    // longer recognise. Passing an out-of-range number straight through would let a hand-edited
    // IndexedDB row set an arbitrary — or negative — grace period on the send path.
    expect(coerceUndoSendSeconds(10)).toBeNull()
    expect(coerceUndoSendSeconds(-5)).toBeNull()
    expect(coerceUndoSendSeconds(9000)).toBeNull()
    expect(coerceUndoSendSeconds('15')).toBeNull()
    expect(coerceUndoSendSeconds(Number.NaN)).toBeNull()
    expect(coerceUndoSendSeconds(undefined)).toBeNull()
  })
})

describe('coerceSignaturePlacement', () => {
  it('recognises the two placements and defaults to above the quote', () => {
    expect(coerceSignaturePlacement('belowQuote')).toBe('belowQuote')
    expect(coerceSignaturePlacement('aboveQuote')).toBe('aboveQuote')
    expect(coerceSignaturePlacement('sideways')).toBe('aboveQuote')
    expect(coerceSignaturePlacement(undefined)).toBe('aboveQuote')
  })
})
