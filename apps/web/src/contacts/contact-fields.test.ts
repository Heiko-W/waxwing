import { describe, expect, it } from 'vitest'
import {
  communicationTypeKey,
  contactDisplayName,
  contactMatches,
  contactPhoto,
  formatAddressLines,
  formatBirthday,
  preferred,
  telHref,
} from './contact-fields'

describe('contactDisplayName', () => {
  it('prefers the whole-name `full`', () => {
    expect(contactDisplayName({ name: { full: 'Ada Lovelace' } })).toBe('Ada Lovelace')
  })

  it('falls back to given + surname components', () => {
    expect(
      contactDisplayName({
        name: {
          components: [
            { kind: 'given', value: 'Ada' },
            { kind: 'surname', value: 'Lovelace' },
          ],
        },
      }),
    ).toBe('Ada Lovelace')
  })

  it('falls back through nickname, organization then email', () => {
    expect(contactDisplayName({ nicknames: { n1: { name: 'Countess' } } })).toBe('Countess')
    expect(contactDisplayName({ organizations: { o1: { name: 'Analytical Engine Co' } } })).toBe(
      'Analytical Engine Co',
    )
    expect(contactDisplayName({ emails: { e1: { address: 'ada@x.test' } } })).toBe('ada@x.test')
  })

  it('returns empty string for a nameless card (caller substitutes a localized label)', () => {
    expect(contactDisplayName({})).toBe('')
  })
})

describe('preferred', () => {
  it('orders by pref (1 best), absent last, ties stable', () => {
    const ordered = preferred({
      a: { address: 'a', pref: 2 },
      b: { address: 'b' },
      c: { address: 'c', pref: 1 },
    })
    expect(ordered.map((entry) => entry.address)).toEqual(['c', 'a', 'b'])
  })

  it('leaves pref-less types in insertion order', () => {
    const ordered = preferred({ a: { name: 'first' }, b: { name: 'second' } })
    expect(ordered.map((entry) => entry.name)).toEqual(['first', 'second'])
  })
})

describe('contactMatches', () => {
  const card = {
    name: { full: 'Ada Lovelace' },
    emails: { e1: { address: 'ada@x.test' } },
    phones: { p1: { number: '+1 555 0100' } },
    organizations: { o1: { name: 'Analytical Engine' } },
  }
  it('matches across name, email, phone and organization (case-insensitive)', () => {
    expect(contactMatches(card, 'lovel')).toBe(true)
    expect(contactMatches(card, 'ada@')).toBe(true)
    expect(contactMatches(card, '555')).toBe(true)
    expect(contactMatches(card, 'engine')).toBe(true)
    expect(contactMatches(card, 'zzz')).toBe(false)
  })
  it('matches everything on an empty needle', () => {
    expect(contactMatches(card, '')).toBe(true)
  })
})

describe('contactPhoto', () => {
  it('returns the preferred photo media (with a blobId or uri)', () => {
    const media = contactPhoto({
      media: {
        m1: { kind: 'logo', uri: 'x' },
        m2: { kind: 'photo', blobId: 'b1' },
      },
    })
    expect(media?.blobId).toBe('b1')
  })
  it('returns undefined when there is no photo media', () => {
    expect(contactPhoto({ media: { m1: { kind: 'logo', uri: 'x' } } })).toBeUndefined()
  })
})

describe('formatBirthday', () => {
  it('renders a full date', () => {
    const out = formatBirthday({ kind: 'birth', date: { year: 1990, month: 4, day: 4 } }, 'en-US')
    expect(out).toContain('1990')
  })
  it('renders a year-withheld partial date as MM-DD', () => {
    expect(formatBirthday({ kind: 'birth', date: { month: 4, day: 4 } })).toBe('04-04')
  })
})

describe('formatAddressLines', () => {
  it('splits a pre-formatted `full` address into lines', () => {
    expect(formatAddressLines({ full: 'Main Street 1\n33330 Town' })).toEqual([
      'Main Street 1',
      '33330 Town',
    ])
  })
  it('joins structured components when there is no `full`', () => {
    const lines = formatAddressLines({
      components: [
        { kind: 'name', value: 'Main Street 1' },
        { kind: 'locality', value: 'Town' },
        { kind: 'postcode', value: '33330' },
        { kind: 'country', value: 'Germany' },
      ],
    })
    expect(lines).toContain('Main Street 1')
    expect(lines).toContain('Germany')
  })

  it('separates the region from the place with a comma (N14)', () => {
    // "33415 Verl NRW" reads as one long place name. Postcode and locality belong together; the
    // region is a different administrative level and needs a separator.
    expect(
      formatAddressLines({
        components: [
          { kind: 'postcode', value: '33415' },
          { kind: 'locality', value: 'Verl' },
          { kind: 'region', value: 'NRW' },
        ],
      }),
    ).toEqual(['33415 Verl, NRW'])
  })

  it('adds no separator when there is no region', () => {
    expect(
      formatAddressLines({
        components: [
          { kind: 'postcode', value: '33415' },
          { kind: 'locality', value: 'Verl' },
        ],
      }),
    ).toEqual(['33415 Verl'])
  })
})

describe('telHref (N11)', () => {
  it('strips the spaces a `tel:` URI may not carry, keeping the visual separators it may', () => {
    // RFC 3966 §3: `-`, `.`, `(` and `)` are visual separators inside a telephone-subscriber. A
    // space is not one, so `tel:+49 171 1234567` is not a valid URI at all.
    expect(telHref('+49 171 1234567')).toBe('tel:+491711234567')
    expect(telHref('+1 (555) 010-0199')).toBe('tel:+1(555)010-0199')
    expect(telHref('030/12 34 56')).toBe('tel:030123456')
  })
})

describe('communicationTypeKey', () => {
  it('prefers a feature over a context', () => {
    expect(communicationTypeKey({ features: { mobile: true }, contexts: { work: true } })).toBe(
      'mobile',
    )
  })
  it('falls back to a context', () => {
    expect(communicationTypeKey({ contexts: { work: true } })).toBe('work')
  })
  it('is undefined when neither is present', () => {
    expect(communicationTypeKey({})).toBeUndefined()
  })
})
