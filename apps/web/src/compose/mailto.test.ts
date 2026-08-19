/**
 * `mailto:` parsing (RFC 6068).
 *
 * The input comes from a link on another origin, so most of these tests are about what the parser
 * REFUSES: headers that would let a link forge a reply relationship or choose the sender, and body
 * text that would otherwise become markup in the message the user is about to send.
 */

import { describe, expect, it } from 'vitest'
import { isEmptyMailto, mailtoBodyToHtml, parseMailto } from './mailto'

describe('parseMailto', () => {
  it('reads the address from the path', () => {
    expect(parseMailto('mailto:alice@example.test').to).toEqual([
      { name: null, email: 'alice@example.test' },
    ])
  })

  it('accepts several addresses, comma-separated', () => {
    const parsed = parseMailto('mailto:a@x.test,b@y.test')
    expect(parsed.to.map((address) => address.email)).toEqual(['a@x.test', 'b@y.test'])
  })

  it('reads subject, body, cc and bcc from the query', () => {
    const parsed = parseMailto(
      'mailto:a@x.test?subject=Hello%20there&body=First%20line&cc=c@x.test&bcc=d@x.test',
    )
    expect(parsed.subject).toBe('Hello there')
    expect(parsed.body).toBe('First line')
    expect(parsed.cc.map((address) => address.email)).toEqual(['c@x.test'])
    expect(parsed.bcc.map((address) => address.email)).toEqual(['d@x.test'])
  })

  it('adds a `to` from the query to the one in the path (RFC 6068 §2)', () => {
    const parsed = parseMailto('mailto:a@x.test?to=b@x.test')
    expect(parsed.to.map((address) => address.email)).toEqual(['a@x.test', 'b@x.test'])
  })

  it('percent-decodes an encoded address in the path', () => {
    expect(parseMailto('mailto:user%40example.test').to[0]?.email).toBe('user@example.test')
  })

  it('matches the scheme case-insensitively (RFC 3986 §3.1)', () => {
    expect(parseMailto('MAILTO:a@x.test').to).toHaveLength(1)
  })

  describe('refusals', () => {
    it('ignores every header other than to/cc/bcc/subject/body', () => {
      // RFC 6068 §5 warns about exactly this: a link that sets `from` chooses the sender, and one
      // that sets `in-reply-to` forges a reply relationship on a thread the user never saw.
      const parsed = parseMailto(
        'mailto:a@x.test?from=attacker@evil.test&in-reply-to=%3Cfake%40evil.test%3E&reply-to=evil@x.test&x-priority=1',
      )
      expect(parsed).toEqual({
        to: [{ name: null, email: 'a@x.test' }],
        cc: [],
        bcc: [],
        subject: '',
        body: '',
      })
    })

    it('returns nothing for a URI that is not mailto:', () => {
      for (const uri of ['https://example.test', 'javascript:alert(1)', 'data:text/html,x', '']) {
        expect(isEmptyMailto(parseMailto(uri))).toBe(true)
      }
    })

    it('survives a malformed percent escape instead of throwing', () => {
      // `decodeURIComponent('%zz')` throws; a bad link must not take the app down with it.
      expect(() => parseMailto('mailto:%zz@x.test')).not.toThrow()
    })
  })

  it('treats a bare mailto: as an empty request', () => {
    expect(isEmptyMailto(parseMailto('mailto:'))).toBe(true)
  })
})

describe('mailtoBodyToHtml', () => {
  it('escapes markup rather than letting a link inject it', () => {
    const html = mailtoBodyToHtml('<script>alert(1)</script>')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('escapes the ampersand first, so an escape cannot be double-decoded', () => {
    expect(mailtoBodyToHtml('&lt;')).toBe('<p>&amp;lt;</p>')
  })

  it('turns newlines into paragraphs', () => {
    expect(mailtoBodyToHtml('one\ntwo')).toBe('<p>one</p><p>two</p>')
  })

  it('keeps a blank line visible', () => {
    expect(mailtoBodyToHtml('one\n\ntwo')).toBe('<p>one</p><p><br></p><p>two</p>')
  })

  it('is empty for empty text', () => {
    expect(mailtoBodyToHtml('')).toBe('')
  })
})
