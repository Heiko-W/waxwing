/**
 * The conversion (M4.1, RFC 9555), against the corpus of shapes real exporters emit.
 *
 * The suite is organised around the two ways a converter fails in the field, neither of which an
 * importer tested against its own writer can see:
 *
 *  1. **It drops something.** A property with no JSContact home, a group prefix, a custom label —
 *     gone, with the user's only clue being that a field is empty three screens later.
 *  2. **It corrupts something on the way back.** Escaping applied twice, a `data:` URI text-escaped,
 *     ids renumbered on every export so nothing can diff two files.
 *
 * So most of what follows is round trips: import → export → import, asserting the second card
 * equals the first. That is a stronger statement than comparing against a hand-written expectation,
 * because it fails on any asymmetry between the two halves rather than on the one case someone
 * thought to write down.
 */

import { describe, expect, it } from 'vitest'
import {
  ALL_CARDS,
  APPLE_EXPORT,
  DATA_URI_CARD,
  ESCAPING_TORTURE,
  GOOGLE_EXPORT,
  GROUP_CARD,
  MULTI_CARD,
  OUTLOOK_EXPORT,
  RFC_6350_EXAMPLE,
} from './corpus'
import { fromVCard, parseVCardDate } from './from-vcard'
import { formatVCardDate, toVCard, toVCards } from './to-vcard'
import type { Card } from './types'
import { parseContentLines } from './vcard/lex'

/** Deterministic uids, so a round trip is comparable and a generated one is visible as `gen-N`. */
function importOne(text: string): Card {
  let counter = 0
  const result = fromVCard(text, { newUid: () => `gen-${String(++counter)}` })
  const card = result.cards[0]
  if (card === undefined) throw new Error('no card')
  return card
}

describe('vCard → JSContact', () => {
  it('reads the RFC 6350 example', () => {
    const card = importOne(RFC_6350_EXAMPLE)
    expect(card['@type']).toBe('Card')
    expect(card.version).toBe('1.0')
    expect(card.name?.full).toBe('Simon Perreault')
    expect(card.name?.components).toContainEqual({ kind: 'surname', value: 'Perreault' })
    expect(card.name?.components).toContainEqual({ kind: 'given', value: 'Simon' })
    // `ing. jr,M.Sc.` is ONE slot carrying TWO comma-separated values.
    expect(card.name?.components).toContainEqual({ kind: 'credential', value: 'ing. jr' })
    expect(card.name?.components).toContainEqual({ kind: 'credential', value: 'M.Sc.' })
  })

  it('generates a uid when the vCard has none, as RFC 9555 §2.1.1 requires', () => {
    expect(importOne(RFC_6350_EXAMPLE).uid).toBe('gen-1')
    expect(importOne(APPLE_EXPORT).uid).toBe('apple-anna-meier')
  })

  /** `home` → `private` is a rename nobody would guess; passing `home` through breaks every server. */
  it('renames the home context to private', () => {
    const emails = Object.values(importOne(APPLE_EXPORT).emails ?? {})
    expect(emails.find((e) => e.address === 'anna@privat.test')?.contexts).toEqual({
      private: true,
    })
    expect(emails.find((e) => e.address.endsWith('example.test'))?.contexts).toEqual({ work: true })
  })

  it('separates phone FEATURES from phone CONTEXTS', () => {
    const phones = Object.values(importOne(APPLE_EXPORT).phones ?? {})
    const mobile = phones.find((p) => p.number.startsWith('+49 171'))
    expect(mobile?.features).toEqual({ mobile: true, voice: true })
    expect(mobile?.pref).toBe(1)
  })

  /** vCard 3.0 shorthand: `TEL;CELL:` and `TEL;WORK;VOICE:` carry no `TYPE=`. */
  it('reads valueless TYPE shorthand from a Google export', () => {
    const phones = Object.values(importOne(GOOGLE_EXPORT).phones ?? {})
    expect(phones.find((p) => p.number.startsWith('+47 900'))?.features).toEqual({ mobile: true })
    const work = phones.find((p) => p.number.startsWith('+47 22'))
    expect(work?.features).toEqual({ voice: true })
    expect(work?.contexts).toEqual({ work: true })
  })

  it('keeps an ORG hierarchy rather than flattening it', () => {
    const org = Object.values(importOne(APPLE_EXPORT).organizations ?? {})[0]
    expect(org?.name).toBe('Beckhoff Automation GmbH & Co. KG')
    expect(org?.units).toEqual([{ name: 'Produktmanagement' }])
  })

  it('maps ADR positionally, skipping the empty slots', () => {
    const address = Object.values(importOne(APPLE_EXPORT).addresses ?? {})[0]
    expect(address?.components).toEqual([
      { kind: 'name', value: 'Hülshorstweg 20' },
      { kind: 'locality', value: 'Verl' },
      { kind: 'postcode', value: '33415' },
      { kind: 'country', value: 'Deutschland' },
    ])
  })

  /**
   * Outlook writes `ADR;HOME:;;;;;;` for a form the user left blank. Creating an address from it
   * would add an empty entry on every single import.
   */
  it('ignores an all-empty ADR', () => {
    const addresses = Object.values(importOne(OUTLOOK_EXPORT).addresses ?? {})
    expect(addresses).toHaveLength(1)
    expect(addresses[0]?.components?.[0]).toEqual({ kind: 'name', value: 'Musterstr. 5' })
  })

  it('maps TITLE and ROLE to the two title kinds', () => {
    const titles = Object.values(importOne(APPLE_EXPORT).titles ?? {})
    expect(titles).toEqual([{ name: 'Produktmanagerin', kind: 'title' }])
  })

  it('reads a birthday, including the year-less form', () => {
    expect(Object.values(importOne(APPLE_EXPORT).anniversaries ?? {})[0]).toEqual({
      kind: 'birth',
      date: { year: 1982, month: 4, day: 15 },
    })
    // The RFC example's `--0203`: "3 February, year withheld" — a case a Date cannot hold at all.
    expect(Object.values(importOne(RFC_6350_EXAMPLE).anniversaries ?? {})[0]).toEqual({
      kind: 'birth',
      date: { month: 2, day: 3 },
    })
  })

  it('reads categories as a keyword set', () => {
    expect(importOne(APPLE_EXPORT).keywords).toEqual({ Arbeit: true, Automatisierung: true })
  })

  it('reads a group card with its members', () => {
    const card = importOne(GROUP_CARD)
    expect(card.kind).toBe('group')
    expect(card.members).toEqual({ 'urn:uuid:member-a': true, 'urn:uuid:member-b': true })
  })

  it('splits a multi-card document', () => {
    const { cards } = fromVCard(MULTI_CARD, { newUid: () => 'gen' })
    expect(cards).toHaveLength(2)
    expect(cards[0]?.name?.full).toBe('Dr. Anna Maria Meier')
    expect(cards[1]?.name?.full).toBe('Herr Karl-Heinz Schmidt')
  })

  /**
   * The lossless mechanism (RFC 9555 §2.15.2). Outlook's `X-MS-` properties have no JSContact home
   * and must not evaporate — a user who imports, edits one phone number and exports would otherwise
   * hand back a card missing everything their own software put there.
   */
  it('preserves unmapped properties in vCardProps', () => {
    const props = importOne(OUTLOOK_EXPORT).vCardProps ?? []
    const names = props.map(([name]) => name)
    expect(names).toContain('x-ms-ol-design')
    expect(names).toContain('x-ms-cardpicture')
  })

  it('preserves a group prefix so a custom label stays bound to its property', () => {
    const props = importOne(APPLE_EXPORT).vCardProps ?? []
    const label = props.find(([name]) => name === 'x-ablabel')
    expect(label?.[1]).toMatchObject({ group: 'item1' })
    expect(label?.[3]).toBe('Ferienhaus')
  })

  /**
   * **A `data:` URI contains both a semicolon and a comma** — `data:image/png;base64,iVBOR…` — so
   * this is the case that separates "does not escape URIs" from "was never tested with a URI that
   * had anything to escape". The first version of this test used a bare base64 blob, which has
   * neither, and stayed green against a writer that escaped every URI; a mutation run found it.
   */
  it('does not text-escape a photo URI, in either direction', () => {
    const uri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'
    const card = importOne(DATA_URI_CARD)
    expect(Object.values(card.media ?? {})[0]?.uri).toBe(uri)

    const exported = toVCard(card)
    // No escape sequences reached the payload. Asserted on the raw text, because the round trip
    // below would also pass against a writer that escapes and a reader that unescapes — a pair that
    // is self-consistent and still emits files other clients read wrongly.
    expect(exported).not.toContain('\\;base64')
    expect(exported).not.toContain('\\,iVBOR')
    // And it survives, which is what the user cares about. Re-imported rather than string-matched:
    // the line is longer than 75 octets, so it is folded and does not appear contiguously.
    expect(Object.values(importOne(exported).media ?? {})[0]?.uri).toBe(uri)
  })

  /**
   * `PROP-ID` is what makes an id survive a round trip (RFC 9555 §2.15.1). Asserting it with
   * CONVENTIONAL ids (`e1`, `tel1`) proves nothing: re-deriving them in the same order produces the
   * same keys. These are deliberately not the ones this package would invent.
   */
  it('uses PROP-ID as the collection key rather than re-deriving one', () => {
    const card = importOne(DATA_URI_CARD)
    expect(Object.keys(card.emails ?? {})).toEqual(['privat-1'])
    expect(Object.keys(card.phones ?? {})).toEqual(['handy'])
    expect(Object.keys(card.media ?? {})).toEqual(['portrait'])
  })

  it('reports a line it could not parse instead of hiding it', () => {
    const { cards, skipped } = fromVCard(
      'BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Anna\r\nGARBAGE LINE\r\nEND:VCARD\r\n',
      { newUid: () => 'gen' },
    )
    expect(cards).toHaveLength(1)
    expect(cards[0]?.name?.full).toBe('Anna')
    expect(skipped).toHaveLength(1)
  })
})

describe('JSContact → vCard', () => {
  it('writes BEGIN, VERSION and END', () => {
    const text = toVCard(importOne(APPLE_EXPORT))
    expect(text.startsWith('BEGIN:VCARD\r\nVERSION:4.0\r\n')).toBe(true)
    expect(text.endsWith('END:VCARD\r\n')).toBe(true)
  })

  it('writes N slots positionally and joins multi-valued ones with commas', () => {
    const text = toVCard(importOne(RFC_6350_EXAMPLE))
    expect(text).toContain('N:Perreault;Simon;;;ing. jr,M.Sc.')
  })

  /** FN is REQUIRED in vCard 4.0 (§6.2.1) — a card without one is invalid. */
  it('derives an FN when the card has only components', () => {
    const card: Card = {
      '@type': 'Card',
      version: '1.0',
      uid: 'x',
      name: {
        components: [
          { kind: 'given', value: 'Anna' },
          { kind: 'surname', value: 'Meier' },
        ],
      },
    }
    expect(toVCard(card)).toContain('FN:Anna Meier')
  })

  it('prefers the stored full name over a derived one', () => {
    const card: Card = {
      '@type': 'Card',
      version: '1.0',
      uid: 'x',
      name: {
        full: 'Meier, Anna',
        components: [{ kind: 'given', value: 'Anna' }],
      },
    }
    expect(toVCard(card)).toContain('FN:Meier\\, Anna')
  })

  it('writes PROP-ID so ids survive an export/import cycle', () => {
    const text = toVCard(importOne(APPLE_EXPORT))
    expect(text).toMatch(/EMAIL;PROP-ID=e1/)
  })

  it('writes back the preserved properties, with their groups', () => {
    const text = toVCard(importOne(APPLE_EXPORT))
    expect(text).toContain('item1.X-ABLABEL:Ferienhaus')
  })

  it('writes a group card', () => {
    const text = toVCard(importOne(GROUP_CARD))
    expect(text).toContain('KIND:group')
    expect(text).toContain('MEMBER:urn:uuid:member-a')
  })

  it('writes a year-less birthday as --MMDD', () => {
    expect(toVCard(importOne(RFC_6350_EXAMPLE))).toContain('BDAY;PROP-ID=a1:--0203')
  })

  it('joins several cards into one document', () => {
    const { cards } = fromVCard(MULTI_CARD, { newUid: () => 'gen' })
    const text = toVCards(cards)
    expect(text.match(/BEGIN:VCARD/g)).toHaveLength(2)
    expect(text.match(/END:VCARD/g)).toHaveLength(2)
  })
})

/**
 * A Card is not trustworthy input. It arrives from a JSContact JSON file the user picked, or from a
 * shared address book on the server, and the vCard slots that are written UNESCAPED by design — URI
 * values, and the verbatim `vCardProps` — are the ones a CRLF can walk straight out of.
 *
 * Counted after unfolding, deliberately: the 75-octet fold would otherwise hide a `BEGIN:VCARD`
 * split across two physical lines, which the reader still unfolds back into a real card.
 */
describe('a hostile card cannot forge a second one', () => {
  const FORGED =
    '\r\nEND:VCARD\r\nBEGIN:VCARD\r\nVERSION:4.0\r\nFN:Chief Exec\r\nEMAIL:attacker@evil.tld\r\nUID:u2\r\nEND:VCARD\r\nBEGIN:VCARD\r\nUID:u3'

  function beginCount(text: string): number {
    return parseContentLines(text).lines.filter((line) => line.name === 'BEGIN').length
  }

  const hostile: Readonly<Record<string, Card>> = {
    'a link uri': {
      '@type': 'Card',
      version: '1.0',
      uid: 'u1',
      links: { l1: { '@type': 'Link', uri: `https://evil.test/${FORGED}` } },
    },
    'a photo uri': {
      '@type': 'Card',
      version: '1.0',
      uid: 'u1',
      media: { m1: { '@type': 'Media', kind: 'photo', uri: `data:image/png;base64,AA${FORGED}` } },
    },
    'a preserved value': {
      '@type': 'Card',
      version: '1.0',
      uid: 'u1',
      vCardProps: [['x-evil', {}, 'unknown', `harmless${FORGED}`]],
    },
    'a preserved property name': {
      '@type': 'Card',
      version: '1.0',
      uid: 'u1',
      vCardProps: [[`x-evil${FORGED}`, {}, 'unknown', 'v']],
    },
    'a preserved parameter': {
      '@type': 'Card',
      version: '1.0',
      uid: 'u1',
      vCardProps: [['x-evil', { [`x-k${FORGED}`]: `x-v${FORGED}`, group: `g${FORGED}` }, '', 'v']],
    },
    'the uid itself': { '@type': 'Card', version: '1.0', uid: `u1${FORGED}` },
  }

  it.each(Object.entries(hostile))('writes exactly one card for %s', (_name, card) => {
    const text = toVCard(card)
    expect(beginCount(text)).toBe(1)
    expect(text).not.toContain('attacker@evil.tld\r\n')
  })

  /** The file-level invariant: one `BEGIN` per input card, whatever the cards contain. */
  it('writes exactly one BEGIN per input card for a whole export', () => {
    const cards = [...ALL_CARDS.map(({ text }) => importOne(text)), ...Object.values(hostile)]
    expect(beginCount(toVCards(cards))).toBe(cards.length)
  })

  /**
   * The forged FN survives as TEXT on the one line it was injected into — the URI is now nonsense,
   * which is the honest outcome for a nonsensical URI. What must not survive is its LINE structure.
   */
  it('keeps the injected bytes inside the property they were smuggled into', () => {
    const card = hostile['a link uri']
    if (card === undefined) throw new Error('fixture')
    const { lines } = parseContentLines(toVCard(card))
    expect(lines.map((line) => line.name)).not.toContain('EMAIL')
    expect(lines.find((line) => line.name === 'URL')?.value).toBe(
      'https://evil.test/END:VCARDBEGIN:VCARDVERSION:4.0FN:Chief ExecEMAIL:attacker@evil.tldUID:u2END:VCARDBEGIN:VCARDUID:u3',
    )
  })
})

describe('round trips', () => {
  /**
   * **The load-bearing assertion of this package.** Import → export → import must be a fixed point:
   * anything the two halves disagree about shows up as a difference, without anyone having to guess
   * in advance which property it would be.
   */
  it.each(ALL_CARDS)('is a fixed point for the $name', ({ text }) => {
    const first = importOne(text)
    const second = importOne(toVCard(first))
    expect(second).toEqual(first)
  })

  /**
   * Escaping applied twice is the classic corruption: it compounds one export at a time, so the
   * first round trip looks fine and the fifth has `C:\\\\\\\\pfad` in it. Three passes catch it.
   */
  it('does not compound escaping over repeated round trips', () => {
    const first = importOne(ESCAPING_TORTURE)
    const second = importOne(toVCard(first))
    const third = importOne(toVCard(second))
    expect(third).toEqual(first)

    const note = Object.values(first.notes ?? {})[0]?.note
    expect(note).toBe('Zeile 1\nZeile 2; mit Semikolon, Komma und C:\\pfad')
  })

  it('keeps a long folded value intact through a round trip', () => {
    const card: Card = {
      '@type': 'Card',
      version: '1.0',
      uid: 'x',
      notes: { n1: { note: `${'ä'.repeat(200)} — ${'x'.repeat(200)}` } },
    }
    const back = importOne(toVCard(card))
    expect(Object.values(back.notes ?? {})[0]?.note).toBe(Object.values(card.notes ?? {})[0]?.note)
  })

  it('keeps unmapped Outlook properties across a round trip', () => {
    const first = importOne(OUTLOOK_EXPORT)
    const second = importOne(toVCard(first))
    expect(second.vCardProps).toEqual(first.vCardProps)
  })
})

describe('dates', () => {
  it('parses every reduced form the spec allows', () => {
    expect(parseVCardDate('19820415')).toEqual({ year: 1982, month: 4, day: 15 })
    expect(parseVCardDate('1982-04-15')).toEqual({ year: 1982, month: 4, day: 15 })
    expect(parseVCardDate('--0415')).toEqual({ month: 4, day: 15 })
    expect(parseVCardDate('--04-15')).toEqual({ month: 4, day: 15 })
    expect(parseVCardDate('1982-04')).toEqual({ year: 1982, month: 4 })
    expect(parseVCardDate('1982')).toEqual({ year: 1982 })
  })

  /** An unreadable date is NOT invented — the raw property stays in `vCardProps` instead. */
  it('returns undefined rather than guessing', () => {
    for (const bad of ['', 'gestern', '15.04.1982', '198']) {
      expect(parseVCardDate(bad)).toBeUndefined()
    }
  })

  it('formats what it parses', () => {
    for (const value of ['19820415', '--0415', '1982-04', '1982']) {
      const parsed = parseVCardDate(value)
      expect(parsed).toBeDefined()
      if (parsed !== undefined)
        expect(parseVCardDate(formatVCardDate(parsed) ?? '')).toEqual(parsed)
    }
  })
})
