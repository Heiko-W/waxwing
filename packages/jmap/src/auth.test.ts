import { describe, expect, it } from 'vitest'
import { applyAuth, basic, bearer } from './auth'

describe('auth providers', () => {
  it('bearer builds the Authorization header and exposes the raw token', async () => {
    const provider = bearer('abc')
    expect(provider.scheme).toBe('bearer')
    expect(await provider.authorization()).toBe('Bearer abc')
    // Additive `token()` (SP.3): the bare credential for query-param transports.
    expect(await provider.token?.()).toBe('abc')
  })

  it('bearer resolves an async token getter for both header and token()', async () => {
    let calls = 0
    const provider = bearer(() => {
      calls++
      return Promise.resolve(`t${calls}`)
    })
    expect(await provider.authorization()).toBe('Bearer t1')
    expect(await provider.token?.()).toBe('t2')
  })

  it('basic builds a UTF-8 base64 header and has no query-token form', async () => {
    // Non-Latin1 password on purpose: `btoa()` alone throws InvalidCharacterError on any code
    // point > U+00FF, so a password with a €, a Cyrillic letter or an emoji would make sign-in
    // impossible. Only the TextEncoder → per-byte → btoa path in base64() encodes it, and only a
    // non-ASCII credential can tell the two apart — an ASCII one passes either way.
    const provider = basic('alice@waxwing.test', 'pw€ß')
    expect(await provider.authorization()).toBe(
      `Basic ${Buffer.from('alice@waxwing.test:pw€ß', 'utf8').toString('base64')}`,
    )
    // Basic has no bare-token form (returns undefined, not implemented).
    expect(provider.token).toBeUndefined()
  })

  it('applyAuth writes the Authorization header onto a headers object', async () => {
    const headers = await applyAuth({ Accept: 'application/json' }, bearer('xyz'))
    expect(headers).toEqual({ Accept: 'application/json', Authorization: 'Bearer xyz' })
  })
})
