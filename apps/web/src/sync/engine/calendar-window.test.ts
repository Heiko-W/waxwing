import { describe, expect, it } from 'vitest'
import { expandedQueries } from './calendar-window'

const window = { after: '2026-10-26T00:00:00.000Z', before: '2026-12-07T00:00:00.000Z' }

describe('expandedQueries', () => {
  it('splits the window ANDed with an OR of calendars into one condition per calendar', () => {
    const filter = {
      operator: 'AND',
      conditions: [
        window,
        { operator: 'OR', conditions: [{ inCalendar: 'a' }, { inCalendar: 'b' }] },
      ],
    }
    expect(expandedQueries(filter)).toEqual([
      { ...window, inCalendar: 'a' },
      { ...window, inCalendar: 'b' },
    ])
  })

  it('flattens a single calendar too — the OR-of-one is also an operator', () => {
    const filter = {
      operator: 'AND',
      conditions: [window, { operator: 'OR', conditions: [{ inCalendar: 'a' }] }],
    }
    expect(expandedQueries(filter)).toEqual([{ ...window, inCalendar: 'a' }])
  })

  it('leaves a bare window alone — it is already one condition', () => {
    expect(expandedQueries(window)).toEqual([window])
  })

  it('leaves null alone', () => {
    expect(expandedQueries(null)).toEqual([null])
  })

  it('does not rewrite a filter that merely looks similar', () => {
    const withText = {
      operator: 'AND',
      conditions: [
        window,
        { operator: 'OR', conditions: [{ inCalendar: 'a' }, { text: 'standup' }] },
      ],
    }
    expect(expandedQueries(withText)).toEqual([withText])
    const three = { operator: 'AND', conditions: [window, { inCalendar: 'a' }, { text: 'x' }] }
    expect(expandedQueries(three)).toEqual([three])
    const either = {
      operator: 'OR',
      conditions: [window, { operator: 'OR', conditions: [{ inCalendar: 'a' }] }],
    }
    expect(expandedQueries(either)).toEqual([either])
  })
})
