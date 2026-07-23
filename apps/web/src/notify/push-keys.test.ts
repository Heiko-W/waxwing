/**
 * base64url ⇄ bytes (M4.0). The reason this file exists rather than trusting two three-line helpers:
 * a mis-ENCODED `p256dh` is accepted by every layer — the server stores it, encrypts against it, the
 * push service delivers — and the browser then silently fails to decrypt and fires no `push` event.
 * There is no error anywhere. Only a round-trip assertion can catch it before a user does.
 */

import { createECDH, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { base64UrlToBytes, bytesToBase64Url } from './push-keys'

/** The real `applicationServerKey` Stalwart v0.16.14 generated for the fixture. */
const VAPID_KEY =
  'BLjc7wAlpyEjBJLAhjRWZ5O_g4HspzJGSgk8iUmmqzCFZ8fcHRA0AghHk3KaVU9EJuC-y2yYTBt25bnLw3rylew'

describe('base64UrlToBytes', () => {
  it('decodes the fixture VAPID key to a 65-byte uncompressed P-256 point', () => {
    const bytes = base64UrlToBytes(VAPID_KEY)
    expect(bytes.byteLength).toBe(65)
    // 0x04 is the uncompressed-point marker. A key that decodes to anything else would be rejected
    // by `subscribe()` with a message that says nothing about which end got it wrong.
    expect(bytes[0]).toBe(0x04)
  })

  it('accepts the unpadded form browsers emit and the padded form alike', () => {
    const unpadded = 'SGVsbG8'
    expect(Array.from(base64UrlToBytes(unpadded))).toEqual(Array.from(base64UrlToBytes('SGVsbG8=')))
  })

  it('decodes the base64url alphabet, not base64', () => {
    // 0xFB 0xFF encodes as `-_8` in base64url and `+/8` in base64. Getting this wrong yields bytes
    // that are valid-looking and wrong.
    expect(Array.from(base64UrlToBytes('-_8'))).toEqual([0xfb, 0xff])
  })
})

describe('bytesToBase64Url', () => {
  it('emits unpadded base64url', () => {
    const encoded = bytesToBase64Url(new Uint8Array([0xfb, 0xff]))
    expect(encoded).toBe('-_8')
    expect(encoded).not.toContain('=')
    expect(encoded).not.toContain('+')
    expect(encoded).not.toContain('/')
  })

  it('takes an ArrayBuffer, which is what `subscription.getKey()` returns', () => {
    const bytes = new Uint8Array([1, 2, 3, 250, 251, 252])
    expect(bytesToBase64Url(bytes.buffer)).toBe(bytesToBase64Url(bytes))
  })

  it('handles a payload larger than the argument limit of String.fromCharCode', () => {
    // 200k bytes: `String.fromCharCode(...bytes)` would throw. Push payloads are 65 and 16 bytes
    // today, but a helper that fails on size is a trap for whoever reuses it.
    const big = new Uint8Array(200_000).map((_, i) => i % 256)
    expect(() => bytesToBase64Url(big)).not.toThrow()
    expect(Array.from(base64UrlToBytes(bytesToBase64Url(big)))).toEqual(Array.from(big))
  })
})

describe('round trip', () => {
  it('survives a real P-256 public key and a 16-byte auth secret', () => {
    // Exactly the two values `PushSubscription/set` carries — and the shape our own live probe had
    // rejected as "Invalid P-256 ECDH public key" when it was made up rather than generated.
    const ecdh = createECDH('prime256v1')
    ecdh.generateKeys()
    const p256dh = ecdh.getPublicKey()
    const auth = randomBytes(16)

    expect(Array.from(base64UrlToBytes(bytesToBase64Url(p256dh)))).toEqual(Array.from(p256dh))
    expect(Array.from(base64UrlToBytes(bytesToBase64Url(auth)))).toEqual(Array.from(auth))
    // And the encoded forms are exactly what Node's own base64url produces — an independent oracle,
    // so a bug shared between our two helpers cannot hide behind a round trip that agrees with itself.
    expect(bytesToBase64Url(p256dh)).toBe(p256dh.toString('base64url'))
    expect(bytesToBase64Url(auth)).toBe(auth.toString('base64url'))
  })

  it('agrees with Node on the fixture VAPID key in both directions', () => {
    expect(Buffer.from(base64UrlToBytes(VAPID_KEY)).toString('base64url')).toBe(VAPID_KEY)
    expect(bytesToBase64Url(Buffer.from(VAPID_KEY, 'base64url'))).toBe(VAPID_KEY)
  })

  it('round-trips every byte value', () => {
    const all = new Uint8Array(256).map((_, i) => i)
    expect(Array.from(base64UrlToBytes(bytesToBase64Url(all)))).toEqual(Array.from(all))
  })
})
