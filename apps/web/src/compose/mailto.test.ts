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

  /*
   * RFC 6068 §5: a `mailto:` URI is not an HTML form payload. "'+' characters are frequently used
   * as part of an email address to indicate a subaddress, as for example in
   * <bill+ietf@example.org>" — decoding it as a space (which the path and `URLSearchParams` both
   * did) turned every plus-addressed recipient into an unsendable pill (R-13).
   */
  describe('the plus sign (RFC 6068 §5)', () => {
    it('keeps a subaddress in the path', () => {
      expect(parseMailto('mailto:bill+ietf@example.org').to).toEqual([
        { name: null, email: 'bill+ietf@example.org' },
      ])
    })

    it('keeps a subaddress in to, cc and bcc from the query', () => {
      const parsed = parseMailto(
        'mailto:?to=bill+ietf@example.org&cc=c+list@x.test&bcc=d+list@x.test',
      )
      expect(parsed.to[0]?.email).toBe('bill+ietf@example.org')
      expect(parsed.cc[0]?.email).toBe('c+list@x.test')
      expect(parsed.bcc[0]?.email).toBe('d+list@x.test')
    })

    it('keeps a plus in the subject and the body', () => {
      const parsed = parseMailto('mailto:a@x.test?subject=C++&body=1+1')
      expect(parsed.subject).toBe('C++')
      expect(parsed.body).toBe('1+1')
    })

    it('decodes %2B to exactly one plus, in the path and in the query', () => {
      expect(parseMailto('mailto:bill%2Bietf@example.org').to[0]?.email).toBe(
        'bill+ietf@example.org',
      )
      expect(parseMailto('mailto:a@x.test?subject=C%2B%2B').subject).toBe('C++')
    })
  })

  it('leaves the other reserved characters decoding as before', () => {
    // The plus fix must not turn into "stop decoding": %20 is still a space, and the escapes a
    // link author needs for `&`, `%`, `?`, `#` and a CRLF body break still come through.
    const parsed = parseMailto(
      'mailto:a@x.test?subject=100%25%20%26%20more%3F%23&body=one%0D%0Atwo&cc=%22Ann%20B%22%20%3Cann@x.test%3E',
    )
    expect(parsed.subject).toBe('100% & more?#')
    expect(parsed.body).toBe('one\r\ntwo')
    expect(parsed.cc).toEqual([{ name: 'Ann B', email: 'ann@x.test' }])
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
