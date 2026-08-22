/**
 * The wire→view mapping for Stalwart's self-service registry.
 *
 * Every fixture here is a shape MEASURED against the pinned fixture server (v0.16.18 on :18080),
 * not one invented to make the mapper look good — the "sets are maps" convention, the `@type`
 * variants, the `"****"` masking and the phantom `notFound` entry are all things a hand-written
 * fixture would have got wrong, and each of them would have shipped as an empty row.
 */

import { describe, expect, it } from 'vitest'
import {
  expiryFromDays,
  languageLabel,
  languageOptions,
  SERVER_LANGUAGES,
  toAppPassword,
  toEncryption,
  toPublicKey,
  toSpamSample,
} from './stalwart-model'

/** 2026-08-21T12:00:00Z — every relative assertion below is anchored here. */
const NOW = Date.parse('2026-08-21T12:00:00Z')

describe('toAppPassword', () => {
  it('reads the shape the server really sends', () => {
    // Verbatim from `x:AppPassword/get` on the fixture, secret masking and all.
    const view = toAppPassword(
      {
        id: 'b',
        description: 'waxwing probe',
        createdAt: '2026-08-21T17:53:43Z',
        expiresAt: null,
        permissions: { '@type': 'Inherit' },
        allowedIps: {},
      },
      NOW,
    )

    expect(view).toEqual({
      id: 'b',
      description: 'waxwing probe',
      createdAt: '2026-08-21T17:53:43Z',
      expiresAt: null,
      expired: false,
      restricted: false,
    })
  })

  it('calls an IP allowlist a RESTRICTION, because that is what it is', () => {
    // Measured: with `allowedIps` set, authenticating from anywhere else is HTTP 403. A row that
    // did not say so would read as a working credential to someone whose phone is on mobile data.
    const view = toAppPassword(
      { id: 'b', description: 'Office', allowedIps: { '127.0.0.1': true } },
      NOW,
    )
    expect(view.restricted).toBe(true)
  })

  it('calls narrowed RIGHTS a restriction too — `Replace` and `Disable`, not `Inherit`', () => {
    expect(toAppPassword({ id: 'b', permissions: { '@type': 'Replace' } }, NOW).restricted).toBe(
      true,
    )
    expect(toAppPassword({ id: 'b', permissions: { '@type': 'Disable' } }, NOW).restricted).toBe(
      true,
    )
    expect(toAppPassword({ id: 'b', permissions: { '@type': 'Inherit' } }, NOW).restricted).toBe(
      false,
    )
  })

  it('marks a password whose clock has run out, and only that one', () => {
    expect(toAppPassword({ id: 'a', expiresAt: '2026-08-20T00:00:00Z' }, NOW).expired).toBe(true)
    expect(toAppPassword({ id: 'b', expiresAt: '2027-01-01T00:00:00Z' }, NOW).expired).toBe(false)
    expect(toAppPassword({ id: 'c', expiresAt: null }, NOW).expired).toBe(false)
  })

  it('does not call a date it cannot read an expiry', () => {
    // "Expired" is an instruction to go and revoke a credential. Saying it because a future server
    // sent a format we do not parse would send someone to break something that works.
    expect(toAppPassword({ id: 'd', expiresAt: 'whenever' }, NOW).expired).toBe(false)
  })

  it('survives a registry that stops sending a field', () => {
    expect(toAppPassword({ id: 'e' }, NOW)).toEqual({
      id: 'e',
      description: '',
      createdAt: null,
      expiresAt: null,
      expired: false,
      restricted: false,
    })
  })
})

describe('toEncryption', () => {
  const KEY = toPublicKey({
    id: 'jaztfjh9ktaa',
    description: 'Dave OpenPGP',
    emailAddresses: { 'dave@waxwing.test': true },
  })

  it('reads `{"@type":"Disabled"}` as off', () => {
    expect(toEncryption({ '@type': 'Disabled' }, [])).toEqual({ kind: 'off' })
  })

  it('reads a MISSING field as off, not as unknown', () => {
    // A server that drops the property has not started encrypting. Rendering the warning here would
    // tell every reader on a server without the field that their mailbox is unreadable.
    expect(toEncryption(undefined, [])).toEqual({ kind: 'off' })
    expect(toEncryption(null, [])).toEqual({ kind: 'off' })
  })

  it('resolves the key id to the key’s own name', () => {
    expect(
      toEncryption(
        { '@type': 'Aes256', publicKey: 'jaztfjh9ktaa', encryptOnAppend: true }, //
        [KEY],
      ),
    ).toEqual({ kind: 'on', cipher: 'Aes256', keyLabel: 'Dave OpenPGP' })
  })

  it('reports an unrecognised cipher as ON rather than as off', () => {
    // What matters to the reader is that this client cannot display those messages, and that does
    // not depend on which cipher it is. Defaulting an unknown `@type` to "off" would hide it.
    expect(toEncryption({ '@type': 'SomethingNew2029' }, []).kind).toBe('on')
  })

  it('says nothing about the key when the account cannot see it', () => {
    expect(toEncryption({ '@type': 'Aes256', publicKey: 'gone' }, [KEY]).kind).toBe('on')
    expect(
      toEncryption({ '@type': 'Aes256', publicKey: 'gone' }, [KEY]) as { keyLabel: string | null },
    ).toHaveProperty('keyLabel', null)
  })
})

describe('toPublicKey / toSpamSample', () => {
  it('turns Stalwart’s SET (a map) into a list of addresses', () => {
    // `emailAddresses` is `{"a@b.test": true}` on the wire — an array is rejected with
    // `invalidPatch`. A mapper that treated it as an array would render nothing at all.
    expect(
      toPublicKey({ id: 'k', emailAddresses: { 'a@b.test': true, 'c@d.test': true } }).addresses,
    ).toEqual(['a@b.test', 'c@d.test'])
  })

  it('drops a set member the server switched off', () => {
    expect(toPublicKey({ id: 'k', emailAddresses: { 'a@b.test': false } }).addresses).toEqual([])
  })

  it('reads a training sample the way the server writes one', () => {
    expect(
      toSpamSample({
        id: 'jaztlnuqamaa',
        from: 'dave@waxwing.test',
        subject: 'Encryption at rest probe',
        isSpam: true,
        expiresAt: '2027-02-17T00:00:00Z',
      }),
    ).toEqual({
      id: 'jaztlnuqamaa',
      from: 'dave@waxwing.test',
      subject: 'Encryption at rest probe',
      isSpam: true,
    })
  })
})

describe('the language list', () => {
  it('offers only the languages the server can actually write', () => {
    // Stalwart's `Locale` enum has 336 variants; `resources/locales/i18n.yml` carries translations
    // for twelve languages and `locale_or_default` falls silently back to English for the rest.
    // Offering all 336 would be a picker where 324 choices do nothing.
    expect(SERVER_LANGUAGES).toHaveLength(12)
    expect(SERVER_LANGUAGES).toContain('de_DE')
    expect(SERVER_LANGUAGES).toContain('en_US')
    expect(languageOptions('de_DE')).toEqual(SERVER_LANGUAGES)
  })

  it('KEEPS a locale the server holds but this list does not', () => {
    // A `<select>` that does not contain its own value reports a different one, and the first
    // change event writes it — a settings control that changes a setting by being looked at.
    expect(languageOptions('ja_JP')[0]).toBe('ja_JP')
    expect(languageOptions('ja_JP')).toHaveLength(13)
  })

  it('names a POSIX locale in the reader’s own language', () => {
    expect(languageLabel('de_DE', 'de')).toContain('Deutsch')
    expect(languageLabel('de_DE', 'en')).toContain('German')
  })

  it('falls back to the raw code rather than throwing out of a render', () => {
    // `Intl.DisplayNames` throws RangeError on a tag it cannot parse. An option list is not a place
    // to find that out: Stalwart's enum holds names like `en_IE@euro`, and an administrator may
    // have set any of the other 324.
    expect(languageLabel('not a locale', 'en')).toBe('not a locale')
  })

  it('drops the POSIX modifier a BCP-47 tag cannot carry', () => {
    // `en_IE@euro` is a real variant of Stalwart's enum; `Intl` would reject it whole.
    expect(languageLabel('en_IE@euro', 'en')).toContain('English')
  })
})

describe('expiryFromDays', () => {
  it('sends no `expiresAt` at all for "never"', () => {
    expect(expiryFromDays(null, NOW)).toBeNull()
  })

  it('produces the second-precision UTC instant the registry accepts', () => {
    // `2026-09-20T12:00:00Z` — no milliseconds: Stalwart's `UTCDateTime` is second-precision, and
    // the `.000` a bare `toISOString()` appends is what a round trip would silently drop.
    expect(expiryFromDays(30, NOW)).toBe('2026-09-20T12:00:00Z')
  })
})
