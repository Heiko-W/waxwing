import { describe, expect, it } from 'vitest'
import { canonicalQueryKey } from '../../sync'
import {
  parseSearchQuery,
  removeTokenAt,
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

/**
 * B-2. "All mailboxes" used to send NO mailbox condition at all — every search returned deleted and
 * spam mail beside the live copies, with no way to turn it off. `inMailboxOtherThan` is the operator
 * for it (measured against Stalwart v0.16.14/.18, report C §2).
 */
describe('B-2 — an all-mailboxes search steps around Trash and Junk', () => {
  const wide = (over: Partial<SearchContext> = {}) =>
    ctx({ excludeMailboxIds: ['mb-trash', 'mb-junk'], ...over })

  it('ANDs one inMailboxOtherThan carrying every excluded mailbox', () => {
    expect(filterOf('offer', wide())).toEqual({
      operator: 'AND',
      conditions: [{ text: 'offer' }, { inMailboxOtherThan: ['mb-trash', 'mb-junk'] }],
    })
  })

  it('excludes even when the query is nothing but operators', () => {
    expect(filterOf('has:attachment', wide())).toEqual({
      operator: 'AND',
      conditions: [{ hasAttachment: true }, { inMailboxOtherThan: ['mb-trash', 'mb-junk'] }],
    })
  })

  it('a POSITIVE in: overrides it — the user named the folder, that is the answer', () => {
    expect(filterOf('in:archive offer', wide())).toEqual({
      operator: 'AND',
      conditions: [{ inMailbox: 'mb-arc' }, { text: 'offer' }],
    })
  })

  it('a NEGATED in: narrows but does not name a folder, so the exclusion stays', () => {
    expect(filterOf('-in:archive offer', wide())).toEqual({
      operator: 'AND',
      conditions: [
        { operator: 'NOT', conditions: [{ inMailbox: 'mb-arc' }] },
        { text: 'offer' },
        { inMailboxOtherThan: ['mb-trash', 'mb-junk'] },
      ],
    })
  })

  it('sends nothing when there is nothing to exclude (a server without those roles)', () => {
    expect(filterOf('offer', ctx({ excludeMailboxIds: [] }))).toEqual({ text: 'offer' })
  })

  it('never emits both a scope and an exclusion', () => {
    expect(filterOf('offer', wide({ scopeMailboxId: 'mb-inbox' }))).toEqual({
      operator: 'AND',
      conditions: [{ text: 'offer' }, { inMailbox: 'mb-inbox' }],
    })
  })
})

/** M-3. `operator: OR` / `NOT` and the `bcc` condition are all server-side (report C §2). */
describe('M-3 — NOT, OR and bcc:', () => {
  it('negates an operator with a leading dash', () => {
    expect(filterOf('-from:ads@x.test')).toEqual({
      operator: 'NOT',
      conditions: [{ from: 'ads@x.test' }],
    })
  })

  it('negates a bare word', () => {
    expect(filterOf('-invoice')).toEqual({ operator: 'NOT', conditions: [{ text: 'invoice' }] })
  })

  it('keeps a negated term out of the joined free text', () => {
    expect(filterOf('report -draft')).toEqual({
      operator: 'AND',
      conditions: [{ operator: 'NOT', conditions: [{ text: 'draft' }] }, { text: 'report' }],
    })
  })

  it('ORs two operators', () => {
    expect(filterOf('from:alice OR from:bob')).toEqual({
      operator: 'OR',
      conditions: [{ from: 'alice' }, { from: 'bob' }],
    })
  })

  it('ORs bare words, and `|` spells the same thing', () => {
    const expected = { operator: 'OR', conditions: [{ text: 'alice' }, { text: 'bob' }] }
    expect(filterOf('alice OR bob')).toEqual(expected)
    expect(filterOf('alice | bob')).toEqual(expected)
  })

  it('chains a run of ORs into ONE group', () => {
    expect(filterOf('a OR b OR c')).toEqual({
      operator: 'OR',
      conditions: [{ text: 'a' }, { text: 'b' }, { text: 'c' }],
    })
  })

  it('binds OR tighter than the implicit AND (Gmail semantics)', () => {
    expect(filterOf('from:alice OR from:bob invoice')).toEqual({
      operator: 'AND',
      conditions: [
        { operator: 'OR', conditions: [{ from: 'alice' }, { from: 'bob' }] },
        { text: 'invoice' },
      ],
    })
  })

  // The line between "a feature for the advanced user" and "a trap for everyone else".
  it('leaves a lowercase "or" alone — it is an ordinary word, not an operator', () => {
    expect(filterOf('cats or dogs')).toEqual({ text: 'cats or dogs' })
  })

  it('ignores a connector with nothing to connect', () => {
    expect(filterOf('OR')).toBeNull()
    expect(filterOf('from:alice OR')).toEqual({ from: 'alice' })
    expect(filterOf('OR from:alice')).toEqual({ from: 'alice' })
  })

  it('maps bcc: — in Sent, the only way back to a blind copy', () => {
    expect(filterOf('bcc:archive@x.test')).toEqual({ bcc: 'archive@x.test' })
  })
})

/** M-2. `minSize`/`maxSize` are server-side; the quota bar had no way to reach them. */
describe('M-2 — size', () => {
  it('reads larger:/smaller: in binary multiples, as the list displays them', () => {
    expect(filterOf('larger:5M')).toEqual({ minSize: 5 * 1024 * 1024 })
    expect(filterOf('larger:5mb')).toEqual({ minSize: 5 * 1024 * 1024 })
    expect(filterOf('smaller:100k')).toEqual({ maxSize: 100 * 1024 })
    expect(filterOf('larger:2G')).toEqual({ minSize: 2 * 1024 * 1024 * 1024 })
  })

  it('takes a bare byte count and a decimal (comma or point)', () => {
    expect(filterOf('larger:1234')).toEqual({ minSize: 1234 })
    expect(filterOf('larger:2,5M')).toEqual({ minSize: 2.5 * 1024 * 1024 })
    expect(filterOf('larger:2.5M')).toEqual({ minSize: 2.5 * 1024 * 1024 })
  })

  it('degrades an unparseable size to text', () => {
    expect(filterOf('larger:huge')).toEqual({ text: 'larger:huge' })
    expect(filterOf('smaller:5TB')).toEqual({ text: 'smaller:5TB' })
  })
})

/** M-4. The three thread conditions ask about a CONVERSATION; `is:` asks about one message. */
describe('M-4 — conversation state', () => {
  it('thread:unread is "nothing in it has been read"', () => {
    expect(filterOf('thread:unread')).toEqual({ noneInThreadHaveKeyword: '$seen' })
  })

  it('thread:read / thread:flagged use the other two thread conditions', () => {
    expect(filterOf('thread:read')).toEqual({ allInThreadHaveKeyword: '$seen' })
    expect(filterOf('thread:flagged')).toEqual({ someInThreadHaveKeyword: '$flagged' })
  })

  it('is: still answers about ONE message — the two are not the same filter', () => {
    expect(filterOf('is:unread')).not.toEqual(filterOf('thread:unread'))
  })

  it('degrades an unknown value to text', () => {
    expect(filterOf('thread:weird')).toEqual({ text: 'thread:weird' })
  })
})

describe('removeTokenAt', () => {
  it('drops the token AND the connector it would leave dangling', () => {
    const tokens = tokenizeSearch('from:alice OR from:bob')
    expect(serializeTokens(removeTokenAt(tokens, 2))).toBe('from:alice')
    expect(serializeTokens(removeTokenAt(tokens, 0))).toBe('from:bob')
  })

  it('collapses a doubled connector rather than leaving a bare OR in the box', () => {
    const tokens = tokenizeSearch('a OR b OR c')
    expect(serializeTokens(removeTokenAt(tokens, 2))).toBe('a OR c')
  })

  it('leaves an untouched query alone', () => {
    const tokens = tokenizeSearch('from:alice invoice')
    expect(serializeTokens(removeTokenAt(tokens, 0))).toBe('invoice')
  })
})

describe('round-trips with the boolean syntax', () => {
  it('tokenize → serialize → tokenize is stable', () => {
    for (const raw of [
      '-from:ads@x.test invoice',
      'from:alice OR from:bob thread:unread',
      'larger:5M -has:attachment',
      'a | b',
    ]) {
      const tokens = tokenizeSearch(raw)
      expect(tokenizeSearch(serializeTokens(tokens))).toEqual(tokens)
    }
  })

  it('quotes a word the grammar would otherwise read as syntax', () => {
    // A literal "OR" and a literal leading dash are DATA here, and must come back as data.
    for (const raw of ['"OR"', '"-5"', '"|"']) {
      const tokens = tokenizeSearch(raw)
      expect(tokens).toEqual([{ type: 'text', value: raw.slice(1, -1) }])
      expect(tokenizeSearch(serializeTokens(tokens))).toEqual(tokens)
    }
  })
})
