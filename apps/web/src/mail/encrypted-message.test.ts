/**
 * Recognising signed and encrypted mail (M5.15).
 *
 * No cryptography is under test here — only the reading of MIME structure. The assertion that
 * matters most is the conservative one: an ambiguous S/MIME part is called ENCRYPTED, because
 * telling a reader a message is merely signed says it is readable, and being wrong about that is
 * the expensive direction.
 */

import { describe, expect, it } from 'vitest'
import {
  detectProtection,
  isProtectionPart,
  isReadable,
  type ProtectionPart,
} from './encrypted-message'

const part = (type: string, over: Partial<ProtectionPart> = {}): ProtectionPart => ({
  type,
  ...over,
})

describe('plain mail', () => {
  it('is unprotected', () => {
    expect(detectProtection(part('text/plain'))).toEqual({ kind: 'none' })
    expect(detectProtection(part('multipart/alternative'))).toEqual({ kind: 'none' })
  })

  it('is unprotected for a missing structure', () => {
    expect(detectProtection(null)).toEqual({ kind: 'none' })
    expect(detectProtection(undefined)).toEqual({ kind: 'none' })
  })
})

describe('signatures', () => {
  it('recognises S/MIME (RFC 8551 §3.9)', () => {
    const signed = part('multipart/signed', {
      subParts: [part('text/plain'), part('application/pkcs7-signature')],
    })
    expect(detectProtection(signed)).toEqual({ kind: 'signed', scheme: 'smime' })
  })

  it('recognises the older x-pkcs7 spelling some senders still emit', () => {
    const signed = part('multipart/signed', {
      subParts: [part('text/plain'), part('application/x-pkcs7-signature')],
    })
    expect(detectProtection(signed).kind).toBe('signed')
  })

  it('recognises PGP/MIME (RFC 3156 §5)', () => {
    const signed = part('multipart/signed', {
      subParts: [part('text/plain'), part('application/pgp-signature')],
    })
    expect(detectProtection(signed)).toEqual({ kind: 'signed', scheme: 'pgp' })
  })

  it('still calls an unrecognised signature part signed', () => {
    const signed = part('multipart/signed', { subParts: [part('text/plain')] })
    expect(detectProtection(signed).kind).toBe('signed')
  })

  it('reports a signed message as READABLE — the body is right there', () => {
    const signed = part('multipart/signed', {
      subParts: [part('text/plain'), part('application/pkcs7-signature')],
    })
    expect(isReadable(detectProtection(signed))).toBe(true)
  })
})

describe('encryption', () => {
  it('recognises PGP/MIME (RFC 3156 §4)', () => {
    expect(detectProtection(part('multipart/encrypted'))).toEqual({
      kind: 'encrypted',
      scheme: 'pgp',
    })
  })

  it('recognises S/MIME enveloped data', () => {
    expect(
      detectProtection(part('application/pkcs7-mime', { smimeType: 'enveloped-data' })),
    ).toEqual({ kind: 'encrypted', scheme: 'smime' })
  })

  it('honours `smime-type: signed-data` when the sender states it', () => {
    expect(detectProtection(part('application/pkcs7-mime', { smimeType: 'signed-data' }))).toEqual({
      kind: 'signed',
      scheme: 'smime',
    })
  })

  it('assumes ENCRYPTED for an ambiguous pkcs7-mime part', () => {
    // The conservative direction. Calling it "signed" would tell the reader the message is
    // readable; being wrong that way is worse than the reverse.
    expect(detectProtection(part('application/pkcs7-mime')).kind).toBe('encrypted')
    expect(detectProtection(part('application/pkcs7-mime', { smimeType: null })).kind).toBe(
      'encrypted',
    )
  })

  it('reports an encrypted message as NOT readable', () => {
    // This is what the reading pane needs in order to explain itself instead of showing a blank.
    expect(isReadable(detectProtection(part('multipart/encrypted')))).toBe(false)
  })
})

describe('what it deliberately does NOT detect', () => {
  it('ignores inline PGP in a text body', () => {
    // Detecting it needs the body text, and a message merely DISCUSSING PGP would trip a naive
    // check — a false "this is encrypted" is worse than a miss.
    expect(detectProtection(part('text/plain'))).toEqual({ kind: 'none' })
  })

  it('reports only the outermost layer', () => {
    // A signed message wrapping an encrypted one is described as signed: that is what the
    // structure says, and claiming more would mean having opened it.
    const nested = part('multipart/signed', {
      subParts: [part('multipart/encrypted'), part('application/pkcs7-signature')],
    })
    expect(detectProtection(nested).kind).toBe('signed')
  })
})

describe('case and whitespace', () => {
  it('reads types the way servers actually emit them', () => {
    expect(detectProtection(part('  Multipart/Encrypted  ')).kind).toBe('encrypted')
    expect(detectProtection(part('APPLICATION/PKCS7-MIME')).kind).toBe('encrypted')
  })
})

describe('telling machinery from content', () => {
  it('names the S/MIME signature part, in both spellings', () => {
    expect(isProtectionPart('application/pkcs7-signature')).toBe(true)
    expect(isProtectionPart('application/x-pkcs7-signature')).toBe(true)
  })

  it('names the PGP signature and control parts', () => {
    expect(isProtectionPart('application/pgp-signature')).toBe(true)
    // Nine bytes reading "Version: 1" (RFC 3156 §4). Not a file.
    expect(isProtectionPart('application/pgp-encrypted')).toBe(true)
  })

  it('does NOT name the encrypted payload itself', () => {
    // `application/octet-stream` is the encrypted body of a PGP/MIME message. Hiding it would hide
    // the message; it is content, even if this client cannot open it.
    expect(isProtectionPart('application/octet-stream')).toBe(false)
    expect(isProtectionPart('application/pkcs7-mime')).toBe(false)
  })

  it('leaves ordinary attachments alone', () => {
    for (const type of ['application/pdf', 'image/png', 'text/plain', 'application/zip']) {
      expect(isProtectionPart(type), type).toBe(false)
    }
  })

  it('reads types the way servers emit them', () => {
    expect(isProtectionPart('  Application/PKCS7-Signature ')).toBe(true)
  })

  it('says no for a missing type rather than hiding the part', () => {
    expect(isProtectionPart(null)).toBe(false)
    expect(isProtectionPart(undefined)).toBe(false)
    expect(isProtectionPart('')).toBe(false)
  })
})
