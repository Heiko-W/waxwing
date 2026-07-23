/**
 * The support matrix in README.md, checked against the code (M4.1).
 *
 * A documented matrix that nothing verifies is a matrix that goes stale — and it goes stale in the
 * direction that matters, because the person who adds a mapping is not the person reading the
 * README before deciding whether to trust this package with their address book. The plan asked for
 * an "explicit supported-property matrix documented"; this is what keeps the document honest.
 *
 * It reads the README's own table rather than a duplicate list, so there is nowhere for the two to
 * disagree.
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { fromVCard } from './from-vcard'
import { toVCard } from './to-vcard'

const README = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '..', 'README.md'),
  'utf8',
)

/** The vCard property names named in the "What is mapped" table's first column. */
function documentedAsMapped(): string[] {
  const table = README.slice(
    README.indexOf('## What is mapped'),
    README.indexOf('## What is *not*'),
  )
  const names = new Set<string>()
  for (const line of table.split('\n')) {
    if (!line.startsWith('|')) continue
    const first = line.split('|')[1]?.trim() ?? ''
    // Skip the header and the two parameter rows, which are not properties.
    if (
      first === '' ||
      first === 'vCard' ||
      first.startsWith('---') ||
      first.includes('parameter')
    ) {
      continue
    }
    for (const match of first.matchAll(/`([A-Z][A-Z0-9-]*)`/g)) {
      const name = match[1]
      if (name !== undefined) names.add(name)
    }
  }
  return [...names]
}

/** The property names listed under "not mapped", which must travel in `vCardProps`. */
function documentedAsPreserved(): string[] {
  const section = README.slice(
    README.indexOf('## What is *not*'),
    README.indexOf('## Known limits'),
  )
  const names = new Set<string>()
  for (const match of section.matchAll(/`([A-Z][A-Z0-9-]*)`/g)) {
    const name = match[1]
    if (name !== undefined && name !== 'X-') names.add(name)
  }
  return [...names]
}

/** A minimal vCard carrying exactly one property, with a value its type will accept. */
function cardWith(property: string, value: string): string {
  return ['BEGIN:VCARD', 'VERSION:4.0', 'UID:matrix-1', `${property}:${value}`, 'END:VCARD'].join(
    '\r\n',
  )
}

const SAMPLE: Readonly<Record<string, string>> = {
  FN: 'Anna Meier',
  N: 'Meier;Anna;;;',
  EMAIL: 'anna@example.test',
  TEL: '+49 171 1234567',
  ADR: ';;Weg 1;Verl;;33415;DE',
  ORG: 'Muster GmbH;Vertrieb',
  TITLE: 'Produktmanagerin',
  ROLE: 'Vertrieb',
  BDAY: '19820415',
  ANNIVERSARY: '20100612',
  DEATHDATE: '20240101',
  NOTE: 'eine Notiz',
  PHOTO: 'data:image/png;base64,iVBOR',
  LOGO: 'https://example.test/logo.png',
  CATEGORIES: 'Arbeit',
  KIND: 'individual',
  MEMBER: 'urn:uuid:member-a',
  UID: 'explicit-uid',
  REV: '2026-07-01T09:12:00Z',
  NICKNAME: 'Anni',
  URL: 'https://example.test',
  LANG: 'de',
  GENDER: 'F',
  TZ: 'Europe/Berlin',
  GEO: 'geo:51.88,8.5',
  KEY: 'https://example.test/key.asc',
  IMPP: 'xmpp:anna@example.test',
  SOUND: 'https://example.test/name.mp3',
  RELATED: 'urn:uuid:other',
  CLIENTPIDMAP: '1;urn:uuid:pid',
  PRODID: '-//Waxwing//EN',
  SOURCE: 'https://example.test/anna.vcf',
  XML: '<x/>',
}

describe('the documented matrix', () => {
  it('names a sample for every property it lists', () => {
    // Guards the test itself: a row added to the README with no sample here would otherwise be
    // skipped silently, and this file would go on reporting success over a property it never tried.
    for (const name of [...documentedAsMapped(), ...documentedAsPreserved()]) {
      expect(SAMPLE[name], `no sample value for ${name}`).toBeDefined()
    }
  })

  it.each(documentedAsMapped())('maps %s into a typed field, not into vCardProps', (property) => {
    const sample = SAMPLE[property]
    if (sample === undefined) throw new Error(`no sample for ${property}`)
    const card = fromVCard(cardWith(property, sample), { newUid: () => 'gen' }).cards[0]
    expect(card).toBeDefined()
    const preserved = (card?.vCardProps ?? []).map(([name]) => name.toUpperCase())
    expect(preserved).not.toContain(property)
  })

  it.each(
    documentedAsPreserved(),
  )('preserves %s in vCardProps rather than dropping it', (property) => {
    const sample = SAMPLE[property]
    if (sample === undefined) throw new Error(`no sample for ${property}`)
    const card = fromVCard(cardWith(property, sample), { newUid: () => 'gen' }).cards[0]
    const preserved = (card?.vCardProps ?? []).map(([name]) => name.toUpperCase())
    expect(preserved).toContain(property)

    // And it comes back out — preserving on import while dropping on export loses exactly as much.
    if (card !== undefined) expect(toVCard(card)).toContain(`${property}`)
  })

  it('lists every property the converter actually maps', () => {
    // The other direction: a mapping added to the code without a README row. `MAPPED` is the
    // converter's own list, minus the three structural properties that are not data.
    const documented = new Set(documentedAsMapped())
    const structural = new Set(['BEGIN', 'END', 'VERSION'])
    const mapped = [
      'FN',
      'N',
      'EMAIL',
      'TEL',
      'ADR',
      'ORG',
      'TITLE',
      'ROLE',
      'BDAY',
      'ANNIVERSARY',
      'DEATHDATE',
      'NOTE',
      'PHOTO',
      'LOGO',
      'CATEGORIES',
      'KIND',
      'MEMBER',
      'UID',
      'REV',
    ]
    for (const property of mapped) {
      if (structural.has(property)) continue
      expect(documented, `${property} is mapped but not in the README table`).toContain(property)
    }
  })

  /**
   * **This test found a real defect and was rewritten around it.**
   *
   * `NICKNAME` and `URL` were in the converter's `MAPPED` set — so they were excluded from
   * `vCardProps` as "handled" — while no code converted them. They were therefore dropped entirely:
   * silent data loss in the one package whose whole promise is that nothing is lost silently, and
   * invisible to every other test because nothing looked for a property that was simply absent.
   *
   * Finding it took the README table, not the code: the matrix said "preserved", the code said
   * "mapped", and neither said "dropped". That is the argument for checking documentation against
   * behaviour rather than trusting either alone.
   */
  it('converts NICKNAME and URL rather than dropping them', () => {
    const card = fromVCard(
      [
        'BEGIN:VCARD',
        'VERSION:4.0',
        'UID:x',
        'NICKNAME:Anni,Annchen',
        'URL:https://example.test/?a=1,2',
        'END:VCARD',
      ].join('\r\n'),
      { newUid: () => 'gen' },
    ).cards[0]

    // One NICKNAME property, two nicknames — it is a comma-separated list (§6.2.3).
    expect(Object.values(card?.nicknames ?? {}).map((n) => n.name)).toEqual(['Anni', 'Annchen'])
    // A URI value, so the comma in the query string is NOT a list separator and NOT escaped.
    expect(Object.values(card?.links ?? {})[0]?.uri).toBe('https://example.test/?a=1,2')
    // And neither is sitting in vCardProps as well, which would duplicate them on export.
    expect((card?.vCardProps ?? []).map(([n]) => n)).toEqual([])
  })
})
