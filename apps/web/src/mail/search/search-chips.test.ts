import { describe, expect, it } from 'vitest'
import { searchChips } from './search-chips'
import { type SearchContext, tokenizeSearch } from './search-query'

const t = (key: string, opts?: { value?: string }) => (opts?.value ? `${key}=${opts.value}` : key)
const ctx: SearchContext = {
  resolveMailbox: (name) => (name === 'archive' ? 'mb-arc' : undefined),
  now: 0,
}

describe('searchChips', () => {
  it('makes one labeled chip per HONORED operator', () => {
    const chips = searchChips(tokenizeSearch('from:alice is:unread in:archive hi'), ctx, t)
    expect(chips.map((chip) => chip.label)).toEqual([
      'search.chip.from=alice',
      'search.chip.unread',
      'search.chip.in=archive',
    ])
  })

  it('omits degraded operators (they show as text, not chips)', () => {
    expect(searchChips(tokenizeSearch('is:weird in:nope foo:bar'), ctx, t)).toEqual([])
  })

  it('carries the token index so a chip removes the right token', () => {
    const chips = searchChips(tokenizeSearch('hello from:alice'), ctx, t)
    expect(chips[0]?.index).toBe(1) // token 0 is the text "hello"; token 1 is from:alice
  })
})

describe('searchChips — the operators added in wave 1', () => {
  /** Renders `{{filter}}` too, so a wrapped label is visible in the assertion. */
  const tf = (key: string, opts?: { value?: string; filter?: string }) =>
    opts?.filter !== undefined
      ? `${key}(${opts.filter})`
      : opts?.value !== undefined
        ? `${key}=${opts.value}`
        : key

  it('labels a NEGATED filter as a filter, not as an absence', () => {
    const chips = searchChips(tokenizeSearch('-from:ads@x'), ctx, tf)
    expect(chips).toEqual([{ index: 0, label: 'search.chip.not(search.chip.from=ads@x)' }])
  })

  it('shows a size the way the list shows it, not the way it was typed', () => {
    const chips = searchChips(tokenizeSearch('larger:5M smaller:100k'), ctx, t)
    expect(chips.map((chip) => chip.label)).toEqual([
      'search.chip.larger=5 MB',
      'search.chip.smaller=100 kB',
    ])
  })

  it('labels bcc: and the conversation filters', () => {
    const chips = searchChips(tokenizeSearch('bcc:a@x thread:unread thread:flagged'), ctx, t)
    expect(chips.map((chip) => chip.label)).toEqual([
      'search.chip.bcc=a@x',
      'search.chip.thread.unread',
      'search.chip.thread.flagged',
    ])
  })

  it('makes no chip for the OR connector, and keeps the indices it shifts', () => {
    const chips = searchChips(tokenizeSearch('from:alice OR from:bob'), ctx, t)
    expect(chips.map((chip) => chip.index)).toEqual([0, 2])
  })
})
