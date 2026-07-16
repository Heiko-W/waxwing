import type { EmailBodyPart, EmailBodyValue } from '@waxwing/jmap'
import { describe, expect, it } from 'vitest'
import type { EmailBodyRow } from '../sync'
import {
  collectCidParts,
  formatAddressList,
  pickHtmlBody,
  pickTextBody,
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
