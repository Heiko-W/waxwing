import type { EmailBodyPart, EmailBodyValue } from '@waxwing/jmap'
import { describe, expect, it } from 'vitest'
import type { EmailBodyRow } from '../sync'
import {
  collectCidParts,
  formatAddressList,
  nameLooksLikeAddress,
  pickHtmlBody,
  pickTextBody,
  type RenderableBody,
  sameAddresses,
  senderName,
} from './message-body'

function part(over: Partial<EmailBodyPart> = {}): EmailBodyPart {
  return {
    partId: null,
    blobId: null,
    size: 0,
    headers: [],
    name: null,
    type: 'text/plain',
    charset: null,
    disposition: null,
    cid: null,
    language: null,
    location: null,
    subParts: null,
    ...over,
  }
}

function body(over: Partial<EmailBodyRow> = {}): EmailBodyRow {
  return {
    accountId: 'a',
    id: 'e1',
    bodyValues: {},
    bodyStructure: part(),
    textBody: [],
    htmlBody: [],
    attachments: [],
    hasAttachment: false,
    fetchedAt: 1,
    lastAccessedAt: 1,
    bytes: 0,
    ablob: [],
    ...over,
  }
}

const value = (v: string): EmailBodyValue => ({
  value: v,
  isEncodingProblem: false,
  isTruncated: false,
})

describe('pickHtmlBody', () => {
  it('returns the decoded text/html parts', () => {
    const b = body({
      bodyValues: { h1: value('<p>hi</p>') },
      htmlBody: [part({ partId: 'h1', type: 'text/html' })],
    })
    expect(pickHtmlBody(b)).toEqual([{ partId: 'h1', value: '<p>hi</p>' }])
  })

  it('returns null for a text-only mail (SP.4: text/plain listed in htmlBody)', () => {
    const b = body({
      bodyValues: { t1: value('plain') },
      textBody: [part({ partId: 't1', type: 'text/plain' })],
      htmlBody: [part({ partId: 't1', type: 'text/plain' })],
    })
    expect(pickHtmlBody(b)).toBeNull()
  })

  it('falls back to an empty string when the body value is missing', () => {
    const b = body({ htmlBody: [part({ partId: 'h1', type: 'text/html' })] })
    expect(pickHtmlBody(b)).toEqual([{ partId: 'h1', value: '' }])
  })

  it('accepts a bare RenderableBody — an Email/parse result with no stored id (FR-RD-07)', () => {
    // A parsed message/rfc822 is a full Email with bodyValues inline but no id and no Dexie row.
    // The widening is what lets it reuse this helper; the test pins that the five fields suffice.
    const parsed: RenderableBody = {
      bodyValues: { h1: value('<p>nested</p>') },
      bodyStructure: part(),
      textBody: [],
      htmlBody: [part({ partId: 'h1', type: 'text/html' })],
      attachments: [],
    }
    expect(pickHtmlBody(parsed)).toEqual([{ partId: 'h1', value: '<p>nested</p>' }])
    expect(pickTextBody(parsed)).toBe('')
  })
})

describe('pickTextBody', () => {
  it('joins the decoded text/plain parts and ignores others', () => {
    const b = body({
      bodyValues: { t1: value('line 1'), t2: value('line 2'), h1: value('<p>x</p>') },
      textBody: [
        part({ partId: 't1', type: 'text/plain' }),
        part({ partId: 'h1', type: 'text/html' }),
        part({ partId: 't2', type: 'text/plain' }),
      ],
    })
    expect(pickTextBody(b)).toBe('line 1\nline 2')
  })
})

describe('collectCidParts', () => {
  it('collects inline parts with both cid and blobId, de-duplicated, walking sub-parts', () => {
    const b = body({
      bodyStructure: part({
        subParts: [
          part({ partId: 'i1', type: 'image/png', cid: 'logo@x', blobId: 'b1', name: 'logo.png' }),
          part({ partId: 'i2', type: 'image/gif', cid: null, blobId: 'b2' }), // no cid → skipped
        ],
      }),
      htmlBody: [part({ cid: 'logo@x', blobId: 'b1', type: 'image/png' })], // duplicate cid → skipped
      attachments: [part({ cid: 'photo@x', blobId: 'b3', type: 'image/jpeg', name: 'p.jpg' })],
    })
    expect(collectCidParts(b)).toEqual([
      { cid: 'logo@x', blobId: 'b1', type: 'image/png', name: 'logo.png' },
      { cid: 'photo@x', blobId: 'b3', type: 'image/jpeg', name: 'p.jpg' },
    ])
  })

  it('skips a cid part with no blobId', () => {
    const b = body({ htmlBody: [part({ cid: 'x@y', blobId: null, type: 'image/png' })] })
    expect(collectCidParts(b)).toEqual([])
  })
})

describe('formatAddressList', () => {
  it('formats name + email, and email-only when the name is absent', () => {
    expect(
      formatAddressList(
        [
          { name: 'Alice', email: 'a@x.test' },
          { name: null, email: 'b@x.test' },
          { name: '', email: 'c@x.test' },
        ],
        '(none)',
      ),
    ).toBe('Alice <a@x.test>, b@x.test, c@x.test')
  })

  it('returns the fallback for an empty or null list', () => {
    expect(formatAddressList(null, '(none)')).toBe('(none)')
    expect(formatAddressList([], '(none)')).toBe('(none)')
  })
})

describe('senderName', () => {
  it('prefers the name, then the email, then the fallback', () => {
    expect(senderName([{ name: 'Bob', email: 'b@x.test' }], '(no sender)')).toBe('Bob')
    expect(senderName([{ name: null, email: 'b@x.test' }], '(no sender)')).toBe('b@x.test')
    expect(senderName(null, '(no sender)')).toBe('(no sender)')
  })
})

describe('sameAddresses', () => {
  it('ignores order and display names', () => {
    expect(
      sameAddresses(
        [
          { name: 'Alice', email: 'a@x.test' },
          { name: null, email: 'b@x.test' },
        ],
        [
          { name: 'Bob', email: 'b@x.test' },
          { name: 'Alice Smith', email: 'a@x.test' },
        ],
      ),
    ).toBe(true)
  })

  it('ignores address casing', () => {
    expect(
      sameAddresses([{ name: null, email: 'A@X.test' }], [{ name: null, email: 'a@x.test' }]),
    ).toBe(true)
  })

  it('is false when the mailboxes differ', () => {
    expect(
      sameAddresses([{ name: null, email: 'a@x.test' }], [{ name: null, email: 'b@x.test' }]),
    ).toBe(false)
    expect(
      sameAddresses(
        [{ name: null, email: 'a@x.test' }],
        [
          { name: null, email: 'a@x.test' },
          { name: null, email: 'b@x.test' },
        ],
      ),
    ).toBe(false)
  })

  it('treats null and an empty list as the same (both name nobody)', () => {
    expect(sameAddresses(null, [])).toBe(true)
    expect(sameAddresses(null, [{ name: null, email: 'a@x.test' }])).toBe(false)
  })
})

describe('nameLooksLikeAddress', () => {
  const from = (name: string | null, email: string) => [{ name, email }]

  it('flags a display name impersonating a DIFFERENT address', () => {
    // The classic: From: "security@bank.test" <attacker@evil.tld>
    expect(nameLooksLikeAddress(from('security@bank.test', 'attacker@evil.tld'))).toBe(true)
  })

  it('flags the bracketed-with-label form — the shape that actually gets sent (D6)', () => {
    // From: "Bank Support <security@bank.test>" <attacker@evil.tld>. Requiring the WHOLE name to be
    // an address missed this, and it is the more convincing forgery of the two: the label supplies
    // plausibility, the brackets supply authority.
    expect(
      nameLooksLikeAddress(from('Bank Support <security@bank.test>', 'attacker@evil.tld')),
    ).toBe(true)
    expect(nameLooksLikeAddress(from('Security (security@bank.test)', 'attacker@evil.tld'))).toBe(
      true,
    )
    expect(nameLooksLikeAddress(from('via security@bank.test', 'attacker@evil.tld'))).toBe(true)
  })

  it('does NOT flag a same-org local-part variant (D6)', () => {
    // "noreply@example.com" <no-reply@example.com> is one organisation spelling its own robot two
    // ways. Nothing is impersonated, and comparing addresses whole made it a warning.
    expect(nameLooksLikeAddress(from('noreply@example.com', 'no-reply@example.com'))).toBe(false)
    expect(nameLooksLikeAddress(from('Support <help@example.com>', 'tickets@example.com'))).toBe(
      false,
    )
  })

  it('does NOT flag an address under the sender own domain, or vice versa', () => {
    expect(nameLooksLikeAddress(from('alice@mail.bank.test', 'noreply@bank.test'))).toBe(false)
    expect(nameLooksLikeAddress(from('alice@bank.test', 'noreply@mail.bank.test'))).toBe(false)
    // ...but a domain that merely ENDS with the real one is a different party (the label trick).
    expect(nameLooksLikeAddress(from('alice@bank.test', 'noreply@evilbank.test'))).toBe(true)
  })

  it('flags it regardless of surrounding whitespace or casing', () => {
    expect(nameLooksLikeAddress(from('  Security@Bank.TEST  ', 'attacker@evil.tld'))).toBe(true)
  })

  it('does NOT flag a name that merely repeats the real address', () => {
    // Extremely common — and it is the truth, not an impersonation.
    expect(nameLooksLikeAddress(from('alice@x.test', 'alice@x.test'))).toBe(false)
    expect(nameLooksLikeAddress(from('Alice@X.test', 'alice@x.test'))).toBe(false)
  })

  it('does NOT flag an ordinary display name', () => {
    for (const name of ['Alice', 'Alice Smith', 'Alice (Support)', 'Support', '', null]) {
      expect(nameLooksLikeAddress(from(name, 'alice@x.test'))).toBe(false)
    }
  })

  it('does NOT flag a name that is address-ISH but not address-shaped', () => {
    // No dotted domain, or a space where an address cannot have one: a name, not a claimed address.
    for (const name of ['alice@localhost', 'me @ x.test', 'a@b@c.test', 'x@.test']) {
      expect(nameLooksLikeAddress(from(name, 'attacker@evil.tld'))).toBe(false)
    }
  })

  it('flags a name that dresses an address up in angle brackets', () => {
    // `From: "<alice@x.test>" <attacker@evil.tld>` is the same impersonation wearing a hat — the
    // local part is deliberately permissive (real ones carry all sorts of punctuation), so this
    // falls out of the rule rather than needing one of its own.
    expect(nameLooksLikeAddress(from('<alice@x.test>', 'attacker@evil.tld'))).toBe(true)
  })

  it('is defensive about a missing or malformed From', () => {
    expect(nameLooksLikeAddress(null)).toBe(false)
    expect(nameLooksLikeAddress([])).toBe(false)
    expect(nameLooksLikeAddress([undefined as never])).toBe(false)
    expect(nameLooksLikeAddress([{ name: 'a@b.test' } as never])).toBe(false)
  })
})
