import { describe, expect, it } from 'vitest'
import { canonicalQueryKey } from '../../sync'
import {
  parseSearchQuery,
  type SearchContext,
  serializeTokens,
  tokenizeSearch,
  tokensToFilter,
} from './search-query'

const NOW = Date.UTC(2026, 6, 11, 15, 30, 0) // 2026-07-11T15:30Z

const ctx = (over: Partial<SearchContext> = {}): SearchContext => ({
  resolveMailbox: (name) => (name === 'archive' ? 'mb-arc' : undefined),
  now: NOW,
  ...over,
})

const filterOf = (raw: string, c: SearchContext = ctx()) => tokensToFilter(tokenizeSearch(raw), c)

describe('tokensToFilter — operators map 1:1 to JMAP conditions', () => {
  it('maps address / text operators', () => {
    expect(filterOf('from:alice@x.test')).toEqual({ from: 'alice@x.test' })
    expect(filterOf('to:bob@x.test')).toEqual({ to: 'bob@x.test' })
    expect(filterOf('cc:carol@x.test')).toEqual({ cc: 'carol@x.test' })
    expect(filterOf('subject:hello')).toEqual({ subject: 'hello' })
    expect(filterOf('body:invoice')).toEqual({ body: 'invoice' })
  })

  it('maps has:attachment and the is: flags', () => {
    expect(filterOf('has:attachment')).toEqual({ hasAttachment: true })
    expect(filterOf('has:attachments')).toEqual({ hasAttachment: true })
    expect(filterOf('is:unread')).toEqual({ notKeyword: '$seen' })
    expect(filterOf('is:read')).toEqual({ hasKeyword: '$seen' })
    expect(filterOf('is:flagged')).toEqual({ hasKeyword: '$flagged' })
    expect(filterOf('is:starred')).toEqual({ hasKeyword: '$flagged' })
  })

  it('resolves in:<folder> to a mailbox id, degrading an unknown folder to text', () => {
    expect(filterOf('in:archive')).toEqual({ inMailbox: 'mb-arc' })
    expect(filterOf('in:nope')).toEqual({ text: 'in:nope' }) // unresolved → raw text
  })

  it('parses dates and degrades an unparseable one to text', () => {
    expect(filterOf('before:2026-01-15')).toEqual({ before: '2026-01-15T00:00:00.000Z' })
    expect(filterOf('after:2026-01-15')).toEqual({ after: '2026-01-15T00:00:00.000Z' })
    expect(filterOf('after:today')).toEqual({ after: '2026-07-11T00:00:00.000Z' })
    expect(filterOf('after:yesterday')).toEqual({ after: '2026-07-10T00:00:00.000Z' })
    expect(filterOf('before:soon')).toEqual({ text: 'before:soon' })
    // Calendar overflow must degrade to text, not silently roll over (Date.UTC → Mar 2 / prior month).
    expect(filterOf('before:2026-02-30')).toEqual({ text: 'before:2026-02-30' })
    expect(filterOf('after:2026-13-01')).toEqual({ text: 'after:2026-13-01' })
    expect(filterOf('before:2026-00-10')).toEqual({ text: 'before:2026-00-10' })
  })
})

describe('tokensToFilter — free text, quoting, degradation', () => {
  it('joins bare words into one text condition', () => {
    expect(filterOf('quarterly report')).toEqual({ text: 'quarterly report' })
  })

  it('keeps a quoted phrase intact (as text and as an operator value)', () => {
    expect(filterOf('"quarterly report"')).toEqual({ text: 'quarterly report' })
    expect(filterOf('subject:"quarterly report"')).toEqual({ subject: 'quarterly report' })
  })

  it('degrades an unknown operator to free text', () => {
    expect(filterOf('foo:bar')).toEqual({ text: 'foo:bar' })
  })

  it('an empty / whitespace query yields no filter', () => {
    expect(filterOf('')).toBeNull()
    expect(filterOf('   ')).toBeNull()
  })

  it('combines operators and text with AND, mixing order-independently', () => {
    const a = filterOf('from:alice is:unread urgent')
    const b = filterOf('urgent is:unread from:alice')
    expect(a).toHaveProperty('operator', 'AND')
    // Structurally different orderings are semantically equal (canonical key equality).
    expect(canonicalQueryKey({ filter: a })).toBe(canonicalQueryKey({ filter: b }))
  })
})

describe('scope', () => {
  it('ANDs the scope mailbox when no explicit in: is present', () => {
    expect(filterOf('urgent', ctx({ scopeMailboxId: 'mb-inbox' }))).toEqual({
      operator: 'AND',
      conditions: [{ text: 'urgent' }, { inMailbox: 'mb-inbox' }],
    })
  })

  it('an explicit in: overrides the scope mailbox', () => {
    expect(filterOf('in:archive urgent', ctx({ scopeMailboxId: 'mb-inbox' }))).toEqual({
      operator: 'AND',
      conditions: [{ inMailbox: 'mb-arc' }, { text: 'urgent' }],
    })
  })

  it('scope alone (empty text) still filters by mailbox', () => {
    expect(filterOf('', ctx({ scopeMailboxId: 'mb-inbox' }))).toEqual({ inMailbox: 'mb-inbox' })
  })
})

describe('parseSearchQuery + serializeTokens', () => {
  it('exposes tokens, filter and the free-text portion', () => {
    const parsed = parseSearchQuery('from:alice hello world', ctx())
    expect(parsed.text).toBe('hello world')
    expect(parsed.tokens).toHaveLength(3)
    expect(parsed.filter).toHaveProperty('operator', 'AND')
  })

  it('round-trips tokenize → serialize → tokenize', () => {
    for (const raw of [
      'from:alice is:unread urgent',
      'subject:"quarterly report" tax',
      'in:archive',
    ]) {
      const tokens = tokenizeSearch(raw)
      expect(tokenizeSearch(serializeTokens(tokens))).toEqual(tokens)
    }
  })

  it('serialize stays STABLE (idempotent) for a value carrying a stray quote', () => {
    // A stray `"` is dropped on serialize; re-serializing must not corrupt / add phantom tokens.
    const once = serializeTokens(tokenizeSearch('from:alice a" b'))
    expect(serializeTokens(tokenizeSearch(once))).toBe(once)
    expect(once).not.toContain('"a"') // no broken split
  })
})
