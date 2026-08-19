/**
 * `List-Unsubscribe` (M5.3, FR-RD-09).
 *
 * The URLs come out of a message, so most of what matters here is refusal: which schemes never
 * reach an opener, and what has to be true before a POST is sent anywhere.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  hasUnsubscribeOffer,
  ONE_CLICK_BODY,
  readUnsubscribeOffer,
  sendOneClickUnsubscribe,
} from './unsubscribe'

const POST_HEADER = 'List-Unsubscribe=One-Click'

describe('readUnsubscribeOffer', () => {
  it('finds an https URL and a mailto in the same header', () => {
    const offer = readUnsubscribeOffer(
      ['https://list.test/u/abc', 'mailto:unsub@list.test?subject=off'],
      null,
    )
    expect(offer.url).toBe('https://list.test/u/abc')
    expect(offer.mailto).toBe('mailto:unsub@list.test?subject=off')
  })

  it('offers one-click only when the sender opted in with List-Unsubscribe-Post', () => {
    const urls = ['https://list.test/u/abc']
    expect(readUnsubscribeOffer(urls, POST_HEADER).oneClick).toBe('https://list.test/u/abc')
    // Without the header the same URL is a page to open, not an endpoint to POST to.
    expect(readUnsubscribeOffer(urls, null).oneClick).toBeNull()
    expect(readUnsubscribeOffer(urls, 'something-else').oneClick).toBeNull()
  })

  it('accepts the opt-in header case- and whitespace-insensitively', () => {
    const urls = ['https://list.test/u/abc']
    expect(readUnsubscribeOffer(urls, '  list-unsubscribe=one-click  ').oneClick).not.toBeNull()
  })

  it('never one-clicks over http, even with the opt-in', () => {
    // The URL carries an opaque token; posting it in clear text is not an option the sender gets
    // to choose on the reader's behalf.
    expect(readUnsubscribeOffer(['http://list.test/u/abc'], POST_HEADER).oneClick).toBeNull()
    expect(readUnsubscribeOffer(['http://list.test/u/abc'], POST_HEADER).url).toBeNull()
  })

  it('drops dangerous schemes entirely', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,<script>', 'file:///etc/passwd']) {
      expect(hasUnsubscribeOffer(readUnsubscribeOffer([url], POST_HEADER))).toBe(false)
    }
  })

  it('tolerates a raw bracketed header value', () => {
    expect(readUnsubscribeOffer(['<https://list.test/u/abc>'], null).url).toBe(
      'https://list.test/u/abc',
    )
  })

  it('reports nothing for an absent or empty header', () => {
    expect(hasUnsubscribeOffer(readUnsubscribeOffer(null, null))).toBe(false)
    expect(hasUnsubscribeOffer(readUnsubscribeOffer(undefined, POST_HEADER))).toBe(false)
    expect(hasUnsubscribeOffer(readUnsubscribeOffer([], POST_HEADER))).toBe(false)
  })

  it('skips a malformed URL instead of throwing', () => {
    const offer = readUnsubscribeOffer(['not a url', 'https://list.test/u/abc'], null)
    expect(offer.url).toBe('https://list.test/u/abc')
  })
})

describe('sendOneClickUnsubscribe', () => {
  it('POSTs the body RFC 8058 requires, opaquely and without credentials', async () => {
    // A real `no-cors` response is opaque (`type: 'opaque'`, status 0), which the `Response`
    // constructor cannot build — status 0 is out of its permitted range. An ordinary response
    // stands in; what is under test is what we SEND, since what comes back is unreadable anyway.
    const fetchLike = vi.fn(async () => new Response(null, { status: 200 }))
    const sent = await sendOneClickUnsubscribe('https://list.test/u/abc', fetchLike as never)

    expect(sent).toBe(true)
    const [url, init] = fetchLike.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://list.test/u/abc')
    expect(init.method).toBe('POST')
    expect(init.body).toBe(ONE_CLICK_BODY)
    // `no-cors` is what makes the request deliverable to a third-party endpoint at all; the price
    // is an opaque response, which is why the caller may only claim the POST was SENT.
    expect(init.mode).toBe('no-cors')
    // The token is already in the URL; sending cookies as well would be gratuitous.
    expect(init.credentials).toBe('omit')
    // The one Content-Type `no-cors` allows without a preflight — and the one RFC 8058 names.
    expect(init.headers).toEqual({ 'Content-Type': 'application/x-www-form-urlencoded' })
  })

  it('refuses a non-https endpoint without calling fetch at all', async () => {
    const fetchLike = vi.fn(async () => new Response(null))
    expect(await sendOneClickUnsubscribe('http://list.test/u', fetchLike as never)).toBe(false)
    expect(await sendOneClickUnsubscribe('javascript:alert(1)', fetchLike as never)).toBe(false)
    expect(fetchLike).not.toHaveBeenCalled()
  })

  it('reports failure when the browser refused to send', async () => {
    const failing = vi.fn(async () => {
      throw new TypeError('network error')
    })
    expect(await sendOneClickUnsubscribe('https://list.test/u', failing as never)).toBe(false)
  })
})
