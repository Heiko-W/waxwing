import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { CardLike } from './contact-fields'
import {
  communicationTypeKey,
  contactDisplayName,
  contactMatches,
  contactPhoto,
  formatAddressLines,
  formatBirthday,
  preferred,
  sortByDisplayName,
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

  /*
   * The reader's zone is PINNED west of UTC: run this in Berlin and a `Timestamp` birthday reads
   * the same either way, so the assertion would pass for the wrong reason. V8 re-reads `TZ` on
   * every `Date`/`Intl` call, so setting it here is enough.
   */
  describe('a Timestamp birthday west of UTC (R-63)', () => {
    const ambient = process.env.TZ
    beforeEach(() => {
      process.env.TZ = 'America/New_York'
    })
    afterAll(() => {
      if (ambient === undefined) delete process.env.TZ
      else process.env.TZ = ambient
    })

    it('shows the same day the editor shows — the UTC one', () => {
      const anniversary = {
        kind: 'birth',
        date: { '@type': 'Timestamp', utc: '1980-03-15T04:00:00Z' },
      } as unknown as Parameters<typeof formatBirthday>[0]
      // `extractBirthdayString` (contact-card-mapping) reads this as 1980-03-15 with `getUTC*`;
      // rendering it in the reader's zone said "March 14, 1980" over a form showing the 15th.
      expect(formatBirthday(anniversary, 'en-US')).toBe('March 15, 1980')
    })
  })
})

describe('sortByDisplayName (R-20)', () => {
  it('orders by display name, case- and accent-insensitively', () => {
    const cards: CardLike[] = [
      { name: { full: 'Zoe' } },
      { name: { full: 'ätna' } },
      { name: { full: 'Alice' } },
    ]
    expect(sortByDisplayName(cards).map((card) => card.name?.full)).toEqual([
      'Alice',
      'ätna',
      'Zoe',
    ])
  })

  it('orders numbered names the way a reader reads them', () => {
    // `numeric`, the same promise `files/file-sort.ts` makes: "Scan 2" before "Scan 10".
    const cards: CardLike[] = [{ name: { full: 'Scan 10' } }, { name: { full: 'Scan 2' } }]
    expect(sortByDisplayName(cards).map((card) => card.name?.full)).toEqual(['Scan 2', 'Scan 10'])
  })

  it('computes each display name EXACTLY once, not once per comparison', () => {
    /*
     * The finding, as a countable property. A comparator calling `contactSortKey` computes the
     * name twice per comparison — ~120 000 computations for 5 000 cards — and `contactDisplayName`
     * walks components, filters, joins and falls back through nicknames, organizations and emails.
     * Decorating first turns that into one per card. Measured on the real helpers (Node 24, 5 000
     * synthetic cards): 266 ms with the old comparator, 16.8 ms with a reused collator and keys.
     */
    let reads = 0
    const cards: CardLike[] = Array.from({ length: 64 }, (_, index) => ({
      get name() {
        reads += 1
        return { full: `Person ${String(64 - index).padStart(2, '0')}` }
      },
    }))
    sortByDisplayName(cards)
    expect(reads).toBe(cards.length)
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
