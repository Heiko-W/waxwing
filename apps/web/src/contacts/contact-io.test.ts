import type { ContactCard } from '@waxwing/jmap'
import type { Card } from '@waxwing/jscontact'
import { describe, expect, it } from 'vitest'
import type { CardLike } from './contact-fields'
import {
  ContactImportError,
  dedupeAgainst,
  exportFilename,
  parseImport,
  serializeExport,
  toContactCard,
} from './contact-io'

const CRLF = '\r\n'
function vcard(lines: string[]): string {
  return `${lines.join(CRLF)}${CRLF}`
}

// Two cards, plus one unparsable line (no colon) inside the second — `fromVCard` must still yield
// both cards AND report the skipped line.
const TWO_CARDS = vcard([
  'BEGIN:VCARD',
  'VERSION:4.0',
  'UID:urn:uuid:alice',
  'FN:Alice Anderson',
  'N:Anderson;Alice;;;',
  'EMAIL:Alice@Example.test',
  'TEL;TYPE=cell:+15550100',
  'X-CUSTOM:keep-me',
  'END:VCARD',
  'BEGIN:VCARD',
  'VERSION:4.0',
  'UID:urn:uuid:bob',
  'FN:Bob Baker',
  'THIS IS NOT A LINE',
  'EMAIL:bob@example.test',
  'END:VCARD',
])

function makeCard(uid: string, email?: string): Card {
  return {
    '@type': 'Card',
    version: '1.0',
    uid,
    ...(email !== undefined
      ? { emails: { e1: { '@type': 'EmailAddress' as const, address: email } } }
      : {}),
  }
}

describe('parseImport', () => {
  it('parses a vCard document into cards and reports skipped lines', async () => {
    const result = await parseImport(TWO_CARDS, 'vcard')
    expect(result.cards).toHaveLength(2)
    expect(result.skipped).toBe(1)
    const alice = result.cards[0]
    expect(alice?.uid).toBe('urn:uuid:alice')
    expect(alice?.emails?.e1?.address).toBe('Alice@Example.test')
    // Unmapped X- property survives in vCardProps (RFC 9555 §2.15.2) — lossless import.
    expect(alice?.vCardProps?.some((prop) => prop[0] === 'x-custom')).toBe(true)
  })

  it('parses a JSContact JSON array and a single object', async () => {
    const array = JSON.stringify([makeCard('u1', 'a@x.test'), makeCard('u2', 'b@x.test')])
    expect((await parseImport(array, 'jscontact')).cards).toHaveLength(2)

    const single = JSON.stringify(makeCard('u3', 'c@x.test'))
    const one = await parseImport(single, 'jscontact')
    expect(one.cards).toHaveLength(1)
    expect(one.cards[0]?.uid).toBe('u3')
  })

  it('counts non-card JSON entries as skipped, never dropping them silently', async () => {
    const mixed = JSON.stringify([makeCard('u1', 'a@x.test'), 42, 'nope', null])
    const result = await parseImport(mixed, 'jscontact')
    expect(result.cards).toHaveLength(1)
    expect(result.skipped).toBe(3)
  })

  it('mints a uid for a JSON card that lacks one (deterministically when injected)', async () => {
    const noUid = JSON.stringify([{ '@type': 'Card', emails: { e1: { address: 'x@y.test' } } }])
    const result = await parseImport(noUid, 'jscontact', { newUid: () => 'fixed-uid' })
    expect(result.cards[0]?.uid).toBe('fixed-uid')
  })

  it('throws ContactImportError on malformed JSON', async () => {
    await expect(parseImport('{ not json', 'jscontact')).rejects.toBeInstanceOf(ContactImportError)
  })
})

describe('dedupeAgainst', () => {
  const existing: CardLike[] = [
    {
      uid: 'uid-alice',
      emails: { e1: { '@type': 'EmailAddress', address: 'alice@example.test' } },
    },
    { uid: 'uid-bob', emails: {} },
  ]

  it('splits on preferred email (case-insensitive) and uid, and dedups within the batch', () => {
    const incoming = [
      makeCard('new-1', 'ALICE@Example.test'), // dup: email matches existing (case-insensitive)
      makeCard('uid-bob', 'carol@example.test'), // dup: uid matches existing
      makeCard('new-2', 'dave@example.test'), // create
      makeCard('new-3', 'dave@example.test'), // dup: same email as new-2, within the batch
    ]
    const { toCreate, duplicates } = dedupeAgainst(incoming, existing)
    expect(toCreate.map((card) => card.uid)).toEqual(['new-2'])
    expect(duplicates.map((card) => card.uid)).toEqual(['new-1', 'uid-bob', 'new-3'])
  })

  it('treats a card with no email and a new uid as creatable', () => {
    const { toCreate, duplicates } = dedupeAgainst([makeCard('fresh')], existing)
    expect(toCreate).toHaveLength(1)
    expect(duplicates).toHaveLength(0)
  })
})

describe('toContactCard', () => {
  it('attaches the target book and passes the source uid through', () => {
    const card = makeCard('urn:uuid:x', 'x@y.test')
    const contactCard = toContactCard(card, 'book-9')
    expect(contactCard.addressBookIds).toEqual({ 'book-9': true })
    expect(contactCard.uid).toBe('urn:uuid:x')
    expect(contactCard['@type']).toBe('Card')
  })
})

describe('serializeExport', () => {
  it('serialises the selection to vCard and strips the JMAP layer', async () => {
    const cc = toContactCard(makeCard('urn:uuid:x', 'x@y.test'), 'book-1')
    const text = await serializeExport([cc], 'vcard')
    expect(text).toContain('BEGIN:VCARD')
    expect(text).toContain('UID:urn:uuid:x')
    expect(text).toContain('EMAIL')
    // A vCard never carries JMAP identity anyway — assert it explicitly.
    expect(text).not.toContain('addressBookIds')
    expect(text).not.toContain('book-1')
  })

  it('serialises the selection to JSON without the JMAP/replica fields', async () => {
    const cc = {
      ...toContactCard(makeCard('urn:uuid:x', 'x@y.test'), 'book-1'),
      accountId: 'acct',
      abk: ['acct\0book-1'],
    } as unknown as ContactCard
    const json = await serializeExport([cc], 'jscontact')
    const parsed = JSON.parse(json) as Record<string, unknown>[]
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.['@type']).toBe('Card')
    for (const key of ['id', 'addressBookIds', 'accountId', 'abk']) {
      expect(parsed[0]).not.toHaveProperty(key)
    }
  })

  it('drops a blobId-only photo on export but keeps a data: uri photo (photo seam)', async () => {
    const cc = {
      ...toContactCard(makeCard('urn:uuid:x', 'x@y.test'), 'book-1'),
      media: {
        m1: { '@type': 'Media', kind: 'photo', blobId: 'blob-123' },
        m2: { '@type': 'Media', kind: 'photo', uri: 'data:image/png;base64,AAAA' },
      },
    } as unknown as ContactCard
    const json = await serializeExport([cc], 'jscontact')
    const parsed = JSON.parse(json) as {
      media?: Record<string, { uri?: string; blobId?: string }>
    }[]
    const media = parsed[0]?.media ?? {}
    expect(Object.keys(media)).toEqual(['m2'])
    expect(media.m2?.uri).toBe('data:image/png;base64,AAAA')
    expect(media.m2).not.toHaveProperty('blobId')
  })
})

describe('round-trip fixpoint', () => {
  const SIMPLE = vcard([
    'BEGIN:VCARD',
    'VERSION:4.0',
    'UID:urn:uuid:rt',
    'FN:Rita Trip',
    'N:Trip;Rita;;;',
    'EMAIL;TYPE=home:rita@example.test',
    'END:VCARD',
  ])

  it('export → re-import is a fixpoint for vCard', async () => {
    const card1 = (await parseImport(SIMPLE, 'vcard')).cards[0]
    expect(card1).toBeDefined()
    const text2 = await serializeExport([toContactCard(card1 as Card, 'book-1')], 'vcard')
    const card2 = (await parseImport(text2, 'vcard')).cards[0]
    expect(card2).toEqual(card1)
  })

  it('export → re-import is a fixpoint for JSON', async () => {
    const card1 = (await parseImport(SIMPLE, 'vcard')).cards[0]
    const json = await serializeExport([toContactCard(card1 as Card, 'book-1')], 'jscontact')
    const card2 = (await parseImport(json, 'jscontact')).cards[0]
    expect(card2).toEqual(card1)
  })
})

describe('exportFilename', () => {
  it('appends the format extension and keeps a clean stem', () => {
    expect(exportFilename('My Contacts', 'vcard')).toBe('My Contacts.vcf')
    expect(exportFilename('Rita Trip', 'jscontact')).toBe('Rita Trip.json')
  })

  it('strips path/control characters and falls back when the stem is empty', () => {
    expect(exportFilename('a/b:c*d', 'vcard')).toBe('abcd.vcf')
    expect(exportFilename('   ', 'jscontact')).toBe('contacts.json')
    expect(exportFilename('...', 'vcard')).toBe('contacts.vcf')
  })
})

describe('parseImport — an imported card cannot dictate where it lands', () => {
  it('drops the identity and placement keys, and cannot reach the prototype', async () => {
    // An import file is attacker-shaped: it arrives as a .vcf/.json the user was sent, or out of a
    // shared address book. `coerceJsonCard` used to spread the whole record (`{ ...record }`) and
    // force only `@type`/`version`/`uid`, so everything else rode along — including the fields that
    // decide WHICH account and WHICH address book the card belongs to. `__proto__` is the sharper
    // one: the sanitizing copy assigns per key, and `out['__proto__'] = …` REPLACES the prototype
    // rather than adding a property, which the old spread did not do.
    const hostile = JSON.stringify([
      {
        '@type': 'Card',
        version: '1.0',
        uid: 'u1',
        id: 'forced-id',
        addressBookIds: { b: true },
        accountId: 'someone-elses-account',
        abk: ['x'],
        __proto__: { emails: { e1: { address: 'attacker@evil.tld' } } },
        'example.com:ext': 'kept',
      },
    ])

    const { cards } = await parseImport(hostile, 'jscontact')
    const [card] = cards

    expect(card).toBeDefined()
    for (const key of ['id', 'addressBookIds', 'accountId', 'abk', '__proto__']) {
      expect(Object.hasOwn(card as object, key)).toBe(false)
    }
    expect(Object.getPrototypeOf(card)).toBe(Object.prototype)
    // …while a genuine JSContact vendor extension survives. That counter-test is the reason this is
    // a small denylist and not an allowlist: an allowlist would amputate every extension.
    expect((card as unknown as Record<string, unknown>)['example.com:ext']).toBe('kept')
  })
})

describe('parseImport — a map key that is not a property name (R-60)', () => {
  it('drops a nested `__proto__` entry instead of letting it into a collection', async () => {
    // One level DOWN from the guard above, and the damage is the reverse: the card imports and
    // displays perfectly (`JSON.parse` files the key as an own property), and the entry then
    // vanishes on the next edit, because the form mapping writes it back with `out[key] = …`.
    const hostile = JSON.stringify({
      '@type': 'Card',
      version: '1.0',
      uid: 'u-proto',
      emails: {
        __proto__: { '@type': 'EmailAddress', address: 'ghost@example.test' },
        constructor: { '@type': 'EmailAddress', address: 'ctor@example.test' },
        e2: { '@type': 'EmailAddress', address: 'real@example.test' },
      },
    })

    const { cards } = await parseImport(hostile, 'jscontact')
    const emails = (cards[0] as unknown as { emails: Record<string, unknown> }).emails
    expect(Object.keys(emails)).toEqual(['e2'])
    expect(Object.getPrototypeOf(emails)).toBe(Object.prototype)
  })
})

describe('serializeExport survives an incomplete card (N5)', () => {
  it('exports the whole selection around a card the server left without a uid', async () => {
    // The card that broke it came from the server, not from us: Stalwart returns a `ContactCard`
    // with no `uid` when one was created without it. The vCard writer read `card.uid` unguarded, so
    // ONE such card made the entire address book unexportable — with no message of any kind.
    const cards = [
      { '@type': 'Card', version: '1.0', id: 'a', addressBookIds: { b: true } },
      { '@type': 'Card', version: '1.0', uid: 'urn:uuid:ok', id: 'c', addressBookIds: { b: true } },
    ] as unknown as ContactCard[]

    const vcf = await serializeExport(cards, 'vcard')
    expect(vcf.match(/BEGIN:VCARD/g)).toHaveLength(2)
    expect(vcf).toContain('UID:urn:uuid:ok')

    // The JSON format never went through the writer and must stay unaffected.
    const json = await serializeExport(cards, 'jscontact')
    expect(JSON.parse(json)).toHaveLength(2)
  })
})
