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
      // Apple writes `BDAY;value=date:` — a parameter nothing here interprets, so it is preserved
      // rather than read and dropped (R-90), and it goes back out on export.
      vCardParams: { VALUE: 'date' },
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

/**
 * Both halves of the converter face data nobody here wrote — a file the user picked, a card a
 * different server minted. These are the shapes that made it lose or destroy something.
 */
/**
 * The input is a FILE — a mail attachment, a shared address book, another server's export — so
 * every string in it is attacker-chosen, including the ones that become object keys.
 */
describe('a card whose own strings are object keys', () => {
  const card = (body: string): string =>
    `BEGIN:VCARD\r\nVERSION:4.0\r\nUID:u1\r\nFN:Victim\r\n${body}\r\nEND:VCARD\r\n`

  it.each([
    '__proto__',
    'constructor',
    'prototype',
  ])('does not lose an address to PROP-ID=%s', (propId) => {
    // `out['__proto__'] = {…}` replaces the prototype rather than adding an own property, so the
    // group ended up with no own keys at all and the whole `emails` field vanished — while the
    // import reported success and `skipped` stayed empty.
    const result = importOne(card(`EMAIL;PROP-ID=${propId}:victim@example.com`))
    expect(Object.values(result.emails ?? {}).map((e) => e.address)).toEqual(['victim@example.com'])
  })

  it('does not turn a hostile TEL;TYPE into a boolean-set key', () => {
    // `PHONE_FEATURES['constructor']` is the `Object` function, not `undefined` — truthy, and then
    // stringified into a key spelt `function Object() { [native code] }`, which goes to the server
    // in a `ContactCard/set` and into the contact view as a label.
    const phones = Object.values(
      importOne(card('TEL;TYPE=constructor,__proto__,home:+49 5246 963 0')).phones ?? {},
    )
    expect(phones).toHaveLength(1)
    const phone = phones[0]
    expect(Object.keys(phone?.features ?? {})).toEqual([])
    expect(Object.keys(phone?.contexts ?? {})).toEqual(['private'])
  })

  /**
   * `bucket.push(...values)` spreads a FILE-controlled list into an argument list, which blows the
   * call stack at around 125k entries — out of a lexer whose contract, and `fromVCard`'s, is
   * "never throws". The whole import then failed with a generic "failed" rather than importing the
   * good cards and reporting the bad line (W-29).
   */
  it('survives a repeated parameter with a pathological number of values', () => {
    const many = Array.from({ length: 200_000 }, (_, i) => `t${String(i)}`).join(',')
    const vcard = card(`TEL;TYPE=work;TYPE=${many}:+49 5246 963 0`)

    // The point is that this RETURNS rather than throwing; what it returns is secondary.
    const result = fromVCard(vcard)
    expect(result.cards).toHaveLength(1)
  })

  it('still honours an ordinary PROP-ID — the counter-test', () => {
    const result = importOne(card('EMAIL;PROP-ID=e7:victim@example.com'))
    expect(Object.keys(result.emails ?? {})).toEqual(['e7'])
  })
})

describe('foreign data that used to break the converter', () => {
  it('gives every entry its own key when PROP-IDs and generated ids collide', () => {
    // The reported case: an explicit `PROP-ID=e2` on the FIRST line, and the second line's generated
    // fallback is also `e2`. The second overwrote the first, so a three-address contact imported as
    // two — and the dialog still said "3 contacts imported".
    const card = importOne(
      [
        'BEGIN:VCARD',
        'VERSION:4.0',
        'FN:Collision Case',
        'EMAIL;PROP-ID=e2;TYPE=work:erste@import.example',
        'EMAIL;TYPE=home:zweite@import.example',
        'EMAIL:dritte@import.example',
        'END:VCARD',
        '',
      ].join('\r\n'),
    )
    const addresses = Object.values(card.emails ?? {}).map((entry) => entry.address)
    expect(addresses).toHaveLength(3)
    expect(addresses).toEqual(
      expect.arrayContaining([
        'erste@import.example',
        'zweite@import.example',
        'dritte@import.example',
      ]),
    )
    // The explicit id is honoured, and it still names the line that asked for it.
    expect(card.emails?.e2?.address).toBe('erste@import.example')
    expect(new Set(Object.keys(card.emails ?? {})).size).toBe(3)
  })

  it('keeps both entries when two lines claim the same PROP-ID', () => {
    const card = importOne(
      [
        'BEGIN:VCARD',
        'VERSION:4.0',
        'FN:Duplicate Prop Id',
        'TEL;PROP-ID=t1:+49 30 1',
        'TEL;PROP-ID=t1:+49 30 2',
        'END:VCARD',
        '',
      ].join('\r\n'),
    )
    expect(Object.values(card.phones ?? {}).map((phone) => phone.number)).toEqual([
      '+49 30 1',
      '+49 30 2',
    ])
  })

  it('keeps every nickname on a line that carries a PROP-ID and several values', () => {
    const card = importOne(
      [
        'BEGIN:VCARD',
        'VERSION:4.0',
        'FN:Anna Meier',
        'NICKNAME;PROP-ID=nick1:Anni,Annchen',
        'END:VCARD',
        '',
      ].join('\r\n'),
    )
    expect(Object.values(card.nicknames ?? {}).map((nick) => nick.name)).toEqual([
      'Anni',
      'Annchen',
    ])
  })

  it('exports a card with no uid instead of taking the whole file down', () => {
    // `Card.uid` is required by the type and by RFC 9553, and a JMAP server still handed us one
    // without it. `escapeText(undefined)` threw, so ONE incomplete card made the whole address book
    // unexportable — and the dialog reported nothing at all.
    const card = { '@type': 'Card', version: '1.0' } as unknown as Card
    const text = toVCard(card)
    expect(text).toContain('BEGIN:VCARD')
    expect(text).toContain('END:VCARD')
    expect(text).not.toContain('UID')
  })

  it('exports the rest of the file around a card with no uid', () => {
    const broken = { '@type': 'Card', version: '1.0' } as unknown as Card
    const good = importOne(APPLE_EXPORT)
    const text = toVCards([broken, good])
    expect(text).toContain('UID:apple-anna-meier')
    expect(text.match(/BEGIN:VCARD/g)).toHaveLength(2)
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

/**
 * R-34. `vCardProps` was filtered by property NAME — "this file handles `BDAY`, so no `BDAY` line
 * belongs in the preserved set" — while the builders filtered by whether they could actually READ
 * the line. Every line in the gap between the two questions was dropped from the card and from its
 * re-export, with `skipped` empty and the import reporting success.
 */
describe('nothing is dropped in silence', () => {
  /**
   * The counting test the fixed-point test cannot be. A symmetric loss — import drops it, export
   * never writes it, re-import drops it again — is INVISIBLE to `fromVCard(toVCard(x)) === x`,
   * which is exactly how this survived. Counting input lines against output lines per property name
   * asks the other question: did anything leave?
   */
  it.each(ALL_CARDS)('re-exports every property line of the $name', ({ text }) => {
    const structural = new Set(['BEGIN', 'END', 'VERSION'])
    const count = (vcard: string): Map<string, number> => {
      const out = new Map<string, number>()
      for (const line of parseContentLines(vcard).lines) {
        if (structural.has(line.name)) continue
        out.set(line.name, (out.get(line.name) ?? 0) + 1)
      }
      return out
    }
    const before = count(text)
    const after = count(toVCard(importOne(text)))
    for (const [name, n] of before) {
      expect(after.get(name) ?? 0, `${name} lines lost on the way out`).toBeGreaterThanOrEqual(n)
    }
  })

  it('keeps a BDAY it cannot read instead of losing it', () => {
    const card = importOne(
      ['BEGIN:VCARD', 'VERSION:4.0', 'UID:u', 'BDAY;VALUE=text:circa 1800', 'END:VCARD'].join(
        '\r\n',
      ),
    )
    expect(card.anniversaries).toBeUndefined()
    expect((card.vCardProps ?? []).map(([name]) => name)).toEqual(['bday'])
    expect(toVCard(card)).toContain('BDAY;VALUE=text:circa 1800')
  })

  it('keeps the ALTID alternatives of FN and N, not just the first of each', () => {
    const card = importOne(
      [
        'BEGIN:VCARD',
        'VERSION:4.0',
        'UID:u',
        'FN;ALTID=1;LANGUAGE=de:Anna Meier',
        'FN;ALTID=1;LANGUAGE=en:Anna Meier',
        'N;ALTID=1;LANGUAGE=de:Meier;Anna;;;',
        'END:VCARD',
      ].join('\r\n'),
    )
    expect(card.name?.full).toBe('Anna Meier')
    expect((card.vCardProps ?? []).map(([name]) => name)).toEqual(['fn'])
    expect(toVCard(card)).toContain('LANGUAGE=en')
  })

  it('keeps a second UID, KIND and REV rather than reading only the first', () => {
    const card = importOne(
      [
        'BEGIN:VCARD',
        'VERSION:4.0',
        'UID:first',
        'UID:second',
        'KIND:individual',
        'KIND:x-robot',
        'REV:20260701T091200Z',
        'REV:20260801T091200Z',
        'END:VCARD',
      ].join('\r\n'),
    )
    expect(card.uid).toBe('first')
    expect(card.kind).toBe('individual')
    expect((card.vCardProps ?? []).map(([name, , , value]) => [name, value])).toEqual([
      ['uid', 'second'],
      ['kind', 'x-robot'],
      ['rev', '20260801T091200Z'],
    ])
  })

  it('keeps an all-empty ADR out of the addresses and in the file', () => {
    // Outlook writes one for every field the user left blank. It is not an address, and it is not
    // rubbish to be thrown away either — it is a line the file had.
    const card = importOne(
      ['BEGIN:VCARD', 'VERSION:4.0', 'UID:u', 'ADR;TYPE=home:;;;;;;', 'END:VCARD'].join('\r\n'),
    )
    expect(card.addresses).toBeUndefined()
    expect(toVCard(card)).toContain('ADR')
  })

  it('reads the RFC 6350 example\u2019s own ANNIVERSARY instead of dropping it', () => {
    // `20090808T1430-0500` is `date-and-or-time` (§6.2.6) and legal; `parseVCardDate` used to answer
    // `undefined`, so the wedding date left the card AND the re-export.
    const card = importOne(RFC_6350_EXAMPLE)
    const wedding = Object.values(card.anniversaries ?? {}).find((a) => a.kind === 'wedding')
    expect(wedding?.date).toEqual({ utc: '2009-08-08T19:30:00Z' })
  })
})

/**
 * R-35. vCard 3.0 (Google, older Apple exports) carries image bytes in the property value with
 * `ENCODING=b` (RFC 2426 §2.4.1); 4.0 replaced that with a `data:` URI. Reading the 3.0 form as
 * though it were 4.0 made `media.uri` the bare base64 string — a relative path, so every render of
 * the contact fired a 404 at the app's own origin, and the same string went to the server.
 */
describe('inline binary photos (vCard 3.0)', () => {
  it('turns a Google export\u2019s ENCODING=b photo into a data: URI', () => {
    const media = Object.values(importOne(GOOGLE_EXPORT).media ?? {})[0]
    expect(media?.kind).toBe('photo')
    expect(media?.mediaType).toBe('image/jpeg')
    expect(media?.uri.startsWith('data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD')).toBe(true)
    // The fold the exporter applied is not part of the payload.
    expect(media?.uri).not.toMatch(/\s/)
  })

  it('reads ENCODING=BASE64 and VALUE=binary as the same thing', () => {
    const card = (params: string) =>
      importOne(
        ['BEGIN:VCARD', 'VERSION:3.0', 'UID:u', `PHOTO;${params}:QUJD`, 'END:VCARD'].join('\r\n'),
      )
    expect(Object.values(card('ENCODING=BASE64;TYPE=PNG').media ?? {})[0]?.uri).toBe(
      'data:image/png;base64,QUJD',
    )
    expect(Object.values(card('VALUE=binary;TYPE=GIF').media ?? {})[0]?.uri).toBe(
      'data:image/gif;base64,QUJD',
    )
    // MEDIATYPE wins over the 3.0 TYPE shorthand when both are present.
    expect(
      Object.values(card('ENCODING=b;TYPE=PNG;MEDIATYPE=image/heic').media ?? {})[0]?.uri,
    ).toBe('data:image/heic;base64,QUJD')
    // An unrecognised format is not guessed at — and leaving the type off would mean `text/plain`.
    expect(Object.values(card('ENCODING=b;TYPE=WORK').media ?? {})[0]?.uri).toBe(
      'data:application/octet-stream;base64,QUJD',
    )
  })

  it('leaves a 4.0 URI value alone', () => {
    // No ENCODING, no VALUE=binary: the value already IS the URI, and prefixing it would be the
    // mirror of the bug.
    const media = Object.values(importOne(DATA_URI_CARD).media ?? {})[0]
    expect(media?.uri).toBe('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB')
    const remote = importOne(
      ['BEGIN:VCARD', 'VERSION:4.0', 'UID:u', 'LOGO:https://a.test/l.png', 'END:VCARD'].join(
        '\r\n',
      ),
    )
    expect(Object.values(remote.media ?? {})[0]?.uri).toBe('https://a.test/l.png')
  })
})

/**
 * R-88. vCard's `timestamp` (§4.3.5, §6.7.4's own example `REV:19951031T222710Z`) is ISO 8601
 * BASIC — no hyphens, no colons. JSContact's `updated` and `Timestamp.utc` are RFC 3339 (RFC 9553
 * §1.4.5, §2.1.10). The package copied both values unchanged from one world into the other.
 */
describe('timestamps cross the two grammars', () => {
  it('reads a vCard REV into an RFC 3339 updated', () => {
    // Outlook: basic form. Apple: the extended form, which is what vCard 3.0 allowed.
    expect(importOne(OUTLOOK_EXPORT).updated).toBe('2026-07-01T09:12:00Z')
    expect(importOne(APPLE_EXPORT).updated).toBe('2026-07-01T09:12:00Z')
  })

  it('writes an RFC 3339 updated back as a vCard timestamp', () => {
    const card: Card = {
      '@type': 'Card',
      version: '1.0',
      uid: 'u',
      updated: '2026-07-01T09:12:00Z',
    }
    expect(toVCard(card)).toContain('REV:20260701T091200Z')
    expect(toVCard(card)).not.toContain('REV:2026-07-01')
  })

  it('writes a Timestamp anniversary in the vCard grammar, and reads it back', () => {
    const card: Card = {
      '@type': 'Card',
      version: '1.0',
      uid: 'u',
      anniversaries: { a1: { kind: 'birth', date: { utc: '1982-04-15T00:00:00Z' } } },
    }
    const vcard = toVCard(card)
    expect(vcard).toContain('BDAY;PROP-ID=a1:19820415T000000Z')
    // The whole point: this package's OWN importer used to read the RFC 3339 form as no date at all.
    expect(Object.values(importOne(vcard).anniversaries ?? {})[0]?.date).toEqual({
      utc: '1982-04-15T00:00:00Z',
    })
  })

  it('omits a REV it cannot express rather than writing rubbish', () => {
    const card: Card = { '@type': 'Card', version: '1.0', uid: 'u', updated: 'gestern' }
    expect(toVCard(card)).not.toContain('REV')
  })

  it('leaves an unreadable REV out of updated and in the file', () => {
    // Nothing is invented and nothing is lost: `updated` stays unset, the line rides out unchanged.
    const card = importOne(
      ['BEGIN:VCARD', 'VERSION:4.0', 'UID:u', 'REV:gestern', 'END:VCARD'].join('\r\n'),
    )
    expect(card.updated).toBeUndefined()
    expect(toVCard(card)).toContain('REV:gestern')
  })
})

/**
 * R-89. vCard 2.1 (classic Outlook for Windows) writes non-ASCII as `ENCODING=QUOTED-PRINTABLE`.
 * That is outside this package's declared scope — 4.0, plus the 3.0 shapes Apple, Google and
 * Outlook emit — and the finding is not that it is unsupported but that it was unsupported in
 * SILENCE: the raw value was taken as plain text, so a card imported "successfully" with `=C3=BC`
 * in the middle of a name.
 */
describe('quoted-printable is reported, not swallowed', () => {
  const QP = [
    'BEGIN:VCARD',
    'VERSION:2.1',
    'N;ENCODING=QUOTED-PRINTABLE;CHARSET=UTF-8:M=C3=BCller;J=C3=BCrgen',
    'FN:Juergen Mueller',
    'END:VCARD',
  ].join('\r\n')

  it('does not import a quoted-printable value as plain text', () => {
    const result = fromVCard(QP, { newUid: () => 'gen' })
    expect(result.cards[0]?.name?.full).toBe('Juergen Mueller')
    expect(JSON.stringify(result.cards[0])).not.toContain('=C3=BC')
  })

  it('says which line it could not read', () => {
    const result = fromVCard(QP, { newUid: () => 'gen' })
    expect(result.skipped).toEqual([
      { line: 3, text: expect.stringContaining('QUOTED-PRINTABLE'), reason: 'unsupportedEncoding' },
    ])
  })

  it('still decodes ENCODING=b, which it does support', () => {
    // The base64 photo path must not be caught by the same net — see UNSUPPORTED_ENCODINGS.
    expect(fromVCard(GOOGLE_EXPORT, { newUid: () => 'gen' }).skipped).toEqual([])
  })
})

/**
 * R-90. Parameters of a MAPPED property that nothing interprets were parsed and thrown away. The
 * property itself round-tripped, so nothing looked lost until a CardDAV client tried to merge two
 * exports on `PID` and found no identity to merge on.
 */
describe('unmapped parameters of mapped properties survive', () => {
  const CARD = [
    'BEGIN:VCARD',
    'VERSION:4.0',
    'UID:u',
    'FN:Anna Meier',
    'EMAIL;PID=1.1;ALTID=2;LANGUAGE=de;TYPE=work:anna@example.test',
    'TEL;VALUE=uri;TYPE=work,voice;PREF=1:tel:+1-418-656-9254',
    'END:VCARD',
  ].join('\r\n')

  it('keeps PID, ALTID, LANGUAGE and a VALUE=uri on the entry', () => {
    const card = importOne(CARD)
    expect(Object.values(card.emails ?? {})[0]?.vCardParams).toEqual({
      PID: '1.1',
      ALTID: '2',
      LANGUAGE: 'de',
    })
    expect(Object.values(card.phones ?? {})[0]?.vCardParams).toEqual({ VALUE: 'uri' })
    // The parameters the typed fields own are NOT duplicated into the preserved set.
    expect(Object.values(card.emails ?? {})[0]?.contexts).toEqual({ work: true })
  })

  it('writes them back, once each, without displacing the computed ones', () => {
    const vcard = toVCard(importOne(CARD))
    expect(vcard).toContain('PID=1.1')
    expect(vcard).toContain('ALTID=2')
    expect(vcard).toContain('LANGUAGE=de')
    expect(vcard).toContain('VALUE=uri')
    expect(vcard.match(/TYPE=/g)).toHaveLength(2)
    expect(vcard).toContain('PREF=1')
  })

  it('does not write back the ENCODING of a photo it already decoded', () => {
    // `media.uri` is a `data:` URI now; re-emitting `ENCODING=b` beside it would make the next
    // import base64-decode the URI itself.
    const vcard = toVCard(importOne(GOOGLE_EXPORT))
    expect(vcard).not.toContain('ENCODING=')
    expect(vcard).toContain('PHOTO;PROP-ID=m1;MEDIATYPE=image/jpeg:data:image/jpeg;base64,')
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

  /**
   * R-34. `BDAY`/`ANNIVERSARY`/`DEATHDATE` are `date-and-or-time` (§6.2.5, §6.2.6), so the time
   * forms of §4.3.3 are legal — `20090808T1430-0500` is the RFC's own §7.1 example.
   */
  it('parses a zoned date-time into a UTC timestamp', () => {
    expect(parseVCardDate('20090808T1430-0500')).toEqual({ utc: '2009-08-08T19:30:00Z' })
    expect(parseVCardDate('19820415T120000Z')).toEqual({ utc: '1982-04-15T12:00:00Z' })
    expect(parseVCardDate('1982-04-15T12:00:00Z')).toEqual({ utc: '1982-04-15T12:00:00Z' })
    expect(parseVCardDate('19820415T1200+02:00')).toEqual({ utc: '1982-04-15T10:00:00Z' })
    // An offset that crosses midnight, a month end and a year end at once — the day arithmetic is
    // `Date.UTC`'s, not a subtraction that is right except on the days nobody tests.
    expect(parseVCardDate('20090101T0030+0500')).toEqual({ utc: '2008-12-31T19:30:00Z' })
  })

  it('keeps only the date of an unzoned date-time, which denotes local wall-clock time', () => {
    // JSContact has no home for a local time, and inventing a zone would move the instant. The
    // untouched line rides along in `vCardProps` — see "nothing is dropped in silence".
    expect(parseVCardDate('19820415T1430')).toEqual({ year: 1982, month: 4, day: 15 })
  })

  /** An unreadable date is NOT invented — the raw property stays in `vCardProps` instead. */
  it('returns undefined rather than guessing', () => {
    for (const bad of ['', 'gestern', '15.04.1982', '198', '19820415T1430-9900', '19820415T']) {
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

/**
 * `IMPP` ⇄ `onlineServices` (RFC 9555 §2.3.2). Added for A-5 of the JMAP gap analysis: instant
 * messaging was on no level modelled — it survived only as an opaque `vCardProps` entry, so a client
 * could preserve it but never show or edit it.
 */
describe('IMPP ⇄ onlineServices', () => {
  const CARD = [
    'BEGIN:VCARD',
    'VERSION:4.0',
    'FN:Anna Meier',
    'IMPP;PREF=1;TYPE=work;SERVICE-TYPE=Matrix;PROP-ID=im1:matrix:u/anna:example.test',
    'IMPP:xmpp:anna@example.test',
    'END:VCARD',
    '',
  ].join('\r\n')

  it('reads the URI, the service and the context — not into vCardProps', () => {
    const card = importOne(CARD)
    expect(card.onlineServices?.im1).toEqual({
      uri: 'matrix:u/anna:example.test',
      service: 'Matrix',
      contexts: { work: true },
      pref: 1,
    })
    expect(Object.values(card.onlineServices ?? {})).toHaveLength(2)
    expect((card.vCardProps ?? []).map(([name]) => name)).not.toContain('IMPP')
  })

  it('round-trips: import → export → import is the same card', () => {
    const first = importOne(CARD)
    const second = importOne(toVCard(first))
    expect(second.onlineServices).toEqual(first.onlineServices)
  })

  it('never text-escapes the URI — a `,` in one is part of the address, not a list', () => {
    const card: Card = {
      '@type': 'Card',
      version: '1.0',
      uid: 'u',
      onlineServices: { s1: { uri: 'https://social.test/@anna?a=1,2' } },
    }
    const line = parseContentLines(toVCard(card)).lines.find((l) => l.name === 'IMPP')
    expect(line?.value).toBe('https://social.test/@anna?a=1,2')
  })

  it('skips an entry vCard has no room for rather than writing an empty property', () => {
    // A bare `user` handle at a service with no URI scheme: `IMPP`'s value IS a URI.
    const card: Card = {
      '@type': 'Card',
      version: '1.0',
      uid: 'u',
      onlineServices: { s1: { service: 'Signal', user: 'anna.42' } },
    }
    expect(toVCard(card)).not.toContain('IMPP')
  })
})
