import type { EmailComparator, EmailFilter } from '@waxwing/jmap'
import { describe, expect, it } from 'vitest'
import { canonicalQueryKey } from './query-key'

describe('canonicalQueryKey', () => {
  it('is stable and equal for the empty spec', () => {
    expect(canonicalQueryKey({})).toBe(canonicalQueryKey({ filter: null, sort: null }))
  })

  it('ignores filter-condition key order', () => {
    const a: EmailFilter = { inMailbox: 'mb', hasKeyword: '$seen' }
    const b: EmailFilter = { hasKeyword: '$seen', inMailbox: 'mb' }
    expect(canonicalQueryKey({ filter: a })).toBe(canonicalQueryKey({ filter: b }))
  })

  it('treats an implicit ascending sort as equal to an explicit one', () => {
    const implicit: EmailComparator[] = [{ property: 'receivedAt' }]
    const explicit: EmailComparator[] = [{ property: 'receivedAt', isAscending: true }]
    expect(canonicalQueryKey({ sort: implicit })).toBe(canonicalQueryKey({ sort: explicit }))
  })

  it('distinguishes ascending from descending', () => {
    const asc: EmailComparator[] = [{ property: 'receivedAt', isAscending: true }]
    const desc: EmailComparator[] = [{ property: 'receivedAt', isAscending: false }]
    expect(canonicalQueryKey({ sort: asc })).not.toBe(canonicalQueryKey({ sort: desc }))
  })

  it('preserves sort-comparator order (order is significant)', () => {
    const ab: EmailComparator[] = [{ property: 'receivedAt' }, { property: 'subject' }]
    const ba: EmailComparator[] = [{ property: 'subject' }, { property: 'receivedAt' }]
    expect(canonicalQueryKey({ sort: ab })).not.toBe(canonicalQueryKey({ sort: ba }))
  })

  it('ignores boolean-operator condition order', () => {
    const ab: EmailFilter = {
      operator: 'AND',
      conditions: [{ hasKeyword: '$flagged' }, { inMailbox: 'mb' }],
    }
    const ba: EmailFilter = {
      operator: 'AND',
      conditions: [{ inMailbox: 'mb' }, { hasKeyword: '$flagged' }],
    }
    expect(canonicalQueryKey({ filter: ab })).toBe(canonicalQueryKey({ filter: ba }))
  })

  it('makes collapseThreads part of the key', () => {
    expect(canonicalQueryKey({ collapseThreads: true })).not.toBe(
      canonicalQueryKey({ collapseThreads: false }),
    )
  })

  it('separates genuinely different filters', () => {
    expect(canonicalQueryKey({ filter: { inMailbox: 'a' } })).not.toBe(
      canonicalQueryKey({ filter: { inMailbox: 'b' } }),
    )
  })

  it('keeps a keyword-based comparator distinct', () => {
    const plain: EmailComparator[] = [{ property: 'someInThreadHaveKeyword' }]
    const keyed: EmailComparator[] = [{ property: 'someInThreadHaveKeyword', keyword: '$flagged' }]
    expect(canonicalQueryKey({ sort: plain })).not.toBe(canonicalQueryKey({ sort: keyed }))
  })
})
