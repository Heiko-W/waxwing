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
