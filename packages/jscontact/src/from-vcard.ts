/**
 * vCard 4.0 → JSContact (M4.1, RFC 9555). The mapping is normative; this file follows it and says
 * where it deliberately does not.
 *
 * **Nothing here throws and nothing here is dropped in silence.** An import is a bulk operation on
 * a file the user did not write: a card with one unparsable line must yield a contact, and a
 * property with no JSContact home must survive in `vCardProps` (RFC 9555 §2.15.2) rather than
 * evaporate. The one thing that would be worse than losing data is losing it invisibly, so
 * everything that could not be mapped is either preserved or reported.
 *
 * **The `uid` is generated when the vCard has none**, as §2.1.1 requires. That is a real decision
 * and not a formality: two imports of the same UID-less card produce two different contacts, which
 * is the correct answer — nothing in the file says they are the same person.
 */

import type {
  Address,
  AddressComponent,
  AddressComponentKind,
  Anniversary,
  BooleanSet,
  Card,
  EmailAddress,
  Id,
  JCardProp,
  Link,
  Media,
  Name,
  NameComponent,
  NameComponentKind,
  Nickname,
  Note,
  Organization,
  PartialDate,
  Phone,
  Title,
} from './types'
import type { ContentLine, SkippedLine } from './vcard/lex'
import { parseContentLines } from './vcard/lex'
import { listValues, structuredComponents, unescapeText } from './vcard/value'

export interface ImportResult {
  readonly cards: readonly Card[]
  /** Lines the lexer could not parse at all. Never hidden from the caller. */
  readonly skipped: readonly SkippedLine[]
}

export interface ImportOptions {
  /** Injected in tests, and by callers that need deterministic ids. Defaults to `crypto.randomUUID`. */
  readonly newUid?: () => string
}

/**
 * vCard's `N` has five positional components; RFC 9555 maps them to these kinds, in this order.
 * Position 4 (`honorific suffixes`) maps to `credential` — RFC 9555 also allows `generation` there,
 * but a suffix cannot be told apart from a credential without a dictionary, and `credential` is the
 * one that round-trips back into the same slot.
 */
const N_KINDS: readonly NameComponentKind[] = ['surname', 'given', 'given2', 'title', 'credential']

/**
 * vCard's `ADR` has seven positional components. Position 1 (`extended address` — flat or suite) has
 * no exact JSContact kind; RFC 9553 offers `apartment`, which is what it means in practice.
 */
const ADR_KINDS: readonly AddressComponentKind[] = [
  'postOfficeBox',
  'apartment',
  'name',
  'locality',
  'region',
  'postcode',
  'country',
]

/**
 * vCard `TYPE` values that are CONTEXTS in JSContact, and their renaming.
 *
 * `home` → `private` is not a synonym anyone would guess: RFC 9553 chose `private` and RFC 9555
 * maps them. A converter that passed `home` through unchanged would produce a card whose contexts
 * no server recognises, and the symptom is a phone number that renders with no label at all.
 */
const CONTEXTS: Readonly<Record<string, string>> = {
  home: 'private',
  work: 'work',
}

/** vCard `TEL;TYPE` values that are FEATURES rather than contexts (RFC 9555 §2.3.3). */
const PHONE_FEATURES: Readonly<Record<string, string>> = {
  cell: 'mobile',
  voice: 'voice',
  text: 'text',
  video: 'video',
  fax: 'fax',
  pager: 'pager',
  textphone: 'textphone',
  main: 'main-number',
}

/** Properties handled by name below. Anything else is preserved into `vCardProps`. */
const MAPPED = new Set([
  'BEGIN',
  'END',
  'VERSION',
  'FN',
  'N',
  'NICKNAME',
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
  'URL',
  'CATEGORIES',
  'KIND',
  'MEMBER',
  'UID',
  'REV',
])

function typeValues(line: ContentLine): string[] {
  return (line.params.get('TYPE') ?? [])
    .flatMap((value) => value.split(','))
    .map((v) => v.trim().toLowerCase())
}

function contextsOf(line: ContentLine): BooleanSet | undefined {
  const set: Record<string, true> = {}
  for (const type of typeValues(line)) {
    const context = CONTEXTS[type]
    if (context !== undefined) set[context] = true
  }
  return Object.keys(set).length > 0 ? set : undefined
}

function prefOf(line: ContentLine): number | undefined {
  const raw = line.params.get('PREF')?.[0]
  if (raw !== undefined) {
    const parsed = Number.parseInt(raw, 10)
    if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 100) return parsed
  }
  // vCard 3.0 wrote preference as `TYPE=pref` with no number. `1` is the most preferred (§5.3).
  return typeValues(line).includes('pref') ? 1 : undefined
}

/**
 * The key for a collection entry.
 *
 * `PROP-ID` is what RFC 9555 §2.15.1 says to use, and honouring it is what lets a card survive a
 * round trip with its ids intact — an id that changes on every export makes every re-import look
 * like a different set of phone numbers to anything doing a diff.
 */
function entryId(line: ContentLine, fallback: string, index: number): Id {
  const propId = line.params.get('PROP-ID')?.[0]
  return propId !== undefined && propId !== '' ? propId : `${fallback}${String(index + 1)}`
}

/**
 * Drop `undefined`-valued keys.
 *
 * Needed because `exactOptionalPropertyTypes` is on: `{ pref: undefined }` is NOT assignable to
 * `{ pref?: number }`, and rightly so — the two mean different things once the object is serialised.
 * Building the object with the key present and then removing it is far more readable than a chain of
 * conditional spreads, so the type is what makes the removal safe: the input accepts `undefined` for
 * every property, the output does not.
 */
type Loose<T> = { [K in keyof T]: T[K] | undefined }

function compact<T extends object>(value: Loose<T>): T {
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = item
  }
  return out as T
}

/**
 * Parse a vCard date (§4.3.4) into a {@link PartialDate}.
 *
 * The reduced forms are the point: `--0404` is "4 April, year unspecified", which people really do
 * enter for a birthday, and which a `Date` cannot hold. Returning `undefined` for an unparsable
 * value lets the caller keep the raw property in `vCardProps` rather than invent a date.
 */
export function parseVCardDate(raw: string): PartialDate | undefined {
  const value = raw.trim()
  // YYYYMMDD or YYYY-MM-DD
  const full = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(value)
  if (full) {
    return {
      year: Number(full[1]),
      month: Number(full[2]),
      day: Number(full[3]),
    }
  }
  // --MMDD / --MM-DD: no year.
  const noYear = /^--(\d{2})-?(\d{2})$/.exec(value)
  if (noYear) return { month: Number(noYear[1]), day: Number(noYear[2]) }
  // YYYY-MM / YYYYMM, and bare YYYY.
  const yearMonth = /^(\d{4})-(\d{2})$/.exec(value)
  if (yearMonth) return { year: Number(yearMonth[1]), month: Number(yearMonth[2]) }
  const year = /^(\d{4})$/.exec(value)
  if (year) return { year: Number(year[1]) }
  return undefined
}

/**
 * jCard-encode one content line (RFC 7095 §3.3) for `vCardProps`.
 *
 * The value type is reported as `unknown` unless the vCard said otherwise. That is honest: guessing
 * `text` for a property we do not know is how a `date` or a `uri` gets re-emitted with text escaping
 * applied to it, corrupting the very value this mechanism exists to preserve.
 */
function toJCardProp(line: ContentLine): JCardProp {
  const params: Record<string, unknown> = {}
  for (const [key, values] of line.params) {
    if (key === 'VALUE') continue
    params[key.toLowerCase()] = values.length === 1 ? values[0] : [...values]
  }
  if (line.group !== null) params.group = line.group
  const valueType = (line.params.get('VALUE')?.[0] ?? 'unknown').toLowerCase()
  return [line.name.toLowerCase(), params, valueType, line.value]
}

/** Split a vCard stream into its `BEGIN:VCARD` … `END:VCARD` blocks. */
function splitCards(lines: readonly ContentLine[]): ContentLine[][] {
  const cards: ContentLine[][] = []
  let current: ContentLine[] | null = null
  for (const line of lines) {
    if (line.name === 'BEGIN' && line.value.trim().toUpperCase() === 'VCARD') {
      current = []
      continue
    }
    if (line.name === 'END' && line.value.trim().toUpperCase() === 'VCARD') {
      if (current !== null) cards.push(current)
      current = null
      continue
    }
    // A property before any BEGIN is malformed but recoverable — start a card for it rather than
    // discarding what may be an entire export missing its first line.
    if (current === null) current = []
    current.push(line)
  }
  if (current !== null && current.length > 0) cards.push(current)
  return cards
}

function buildName(lines: readonly ContentLine[]): Name | undefined {
  const fn = lines.find((line) => line.name === 'FN')
  const n = lines.find((line) => line.name === 'N')

  const components: NameComponent[] = []
  if (n !== undefined) {
    const parts = structuredComponents(n.value)
    N_KINDS.forEach((kind, index) => {
      const part = parts[index]
      if (part === undefined || part === '') return
      // A component may itself carry several comma-separated values (§6.2.2) — two given names, or
      // both "Dr." and "Prof.". Each becomes its own NameComponent, which is what JSContact models.
      for (const value of listValues(part)) {
        if (value !== '') components.push({ kind, value })
      }
    })
  }

  const full = fn === undefined ? undefined : unescapeText(fn.value)
  if (components.length === 0 && full === undefined) return undefined
  return compact<Name>({
    ...(components.length > 0 ? { components } : {}),
    ...(full !== undefined ? { full } : {}),
  })
}

function buildEmails(lines: readonly ContentLine[]): Record<Id, EmailAddress> | undefined {
  const out: Record<Id, EmailAddress> = {}
  lines
    .filter((line) => line.name === 'EMAIL')
    .forEach((line, index) => {
      const address = unescapeText(line.value).trim()
      if (address === '') return
      out[entryId(line, 'e', index)] = compact<EmailAddress>({
        address,
        contexts: contextsOf(line),
        pref: prefOf(line),
        label: line.params.get('LABEL')?.[0],
      })
    })
  return Object.keys(out).length > 0 ? out : undefined
}

function buildPhones(lines: readonly ContentLine[]): Record<Id, Phone> | undefined {
  const out: Record<Id, Phone> = {}
  lines
    .filter((line) => line.name === 'TEL')
    .forEach((line, index) => {
      const number = unescapeText(line.value).trim()
      if (number === '') return
      const features: Record<string, true> = {}
      for (const type of typeValues(line)) {
        const feature = PHONE_FEATURES[type]
        if (feature !== undefined) features[feature] = true
      }
      out[entryId(line, 'tel', index)] = compact<Phone>({
        number,
        features: Object.keys(features).length > 0 ? features : undefined,
        contexts: contextsOf(line),
        pref: prefOf(line),
        label: line.params.get('LABEL')?.[0],
      })
    })
  return Object.keys(out).length > 0 ? out : undefined
}

function buildAddresses(lines: readonly ContentLine[]): Record<Id, Address> | undefined {
  const out: Record<Id, Address> = {}
  lines
    .filter((line) => line.name === 'ADR')
    .forEach((line, index) => {
      const parts = structuredComponents(line.value)
      const components: AddressComponent[] = []
      ADR_KINDS.forEach((kind, position) => {
        const part = parts[position]
        if (part !== undefined && part !== '') components.push({ kind, value: part })
      })
      const full = line.params.get('LABEL')?.[0]
      if (components.length === 0 && full === undefined) return
      out[entryId(line, 'adr', index)] = compact<Address>({
        ...(components.length > 0 ? { components } : {}),
        full,
        countryCode: line.params.get('CC')?.[0],
        contexts: contextsOf(line),
        pref: prefOf(line),
      })
    })
  return Object.keys(out).length > 0 ? out : undefined
}

function buildOrganizations(lines: readonly ContentLine[]): Record<Id, Organization> | undefined {
  const out: Record<Id, Organization> = {}
  lines
    .filter((line) => line.name === 'ORG')
    .forEach((line, index) => {
      // ORG is `name;unit;unit…` (§6.6.4): the first component is the organisation, the rest are
      // nested units. Flattening them into one string is the common shortcut and it loses the
      // hierarchy the exporter took the trouble to write.
      const [name, ...units] = structuredComponents(line.value)
      const named = units.filter((unit) => unit !== '').map((unit) => ({ name: unit }))
      if ((name === undefined || name === '') && named.length === 0) return
      out[entryId(line, 'org', index)] = compact<Organization>({
        ...(name !== undefined && name !== '' ? { name } : {}),
        ...(named.length > 0 ? { units: named } : {}),
        sortAs: line.params.get('SORT-AS')?.[0],
        contexts: contextsOf(line),
      })
    })
  return Object.keys(out).length > 0 ? out : undefined
}

function buildTitles(lines: readonly ContentLine[]): Record<Id, Title> | undefined {
  const out: Record<Id, Title> = {}
  let index = 0
  for (const line of lines) {
    if (line.name !== 'TITLE' && line.name !== 'ROLE') continue
    const name = unescapeText(line.value).trim()
    if (name === '') continue
    out[entryId(line, 't', index)] = compact<Title>({
      name,
      kind: line.name === 'ROLE' ? ('role' as const) : ('title' as const),
    })
    index++
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function buildAnniversaries(lines: readonly ContentLine[]): Record<Id, Anniversary> | undefined {
  const out: Record<Id, Anniversary> = {}
  const kinds: Readonly<Record<string, Anniversary['kind']>> = {
    BDAY: 'birth',
    ANNIVERSARY: 'wedding',
    DEATHDATE: 'death',
  }
  let index = 0
  for (const line of lines) {
    const kind = kinds[line.name]
    if (kind === undefined) continue
    const date = parseVCardDate(unescapeText(line.value))
    // An unparsable date is NOT invented: the raw property stays in `vCardProps` instead, so the
    // information is kept even though this mapping could not read it.
    if (date === undefined) continue
    out[entryId(line, 'a', index)] = { kind, date }
    index++
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * `NICKNAME` is a comma-separated list (§6.2.3), so one property can yield several nicknames — which
 * is why this is not a straight one-line map. Getting it wrong shows up as a single contact called
 * "Anni, Annchen".
 */
function buildNicknames(lines: readonly ContentLine[]): Record<Id, Nickname> | undefined {
  const out: Record<Id, Nickname> = {}
  let index = 0
  for (const line of lines) {
    if (line.name !== 'NICKNAME') continue
    for (const value of listValues(line.value)) {
      const name = value.trim()
      if (name === '') continue
      out[entryId(line, 'nick', index)] = compact<Nickname>({
        name,
        contexts: contextsOf(line),
        pref: prefOf(line),
      })
      index++
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function buildLinks(lines: readonly ContentLine[]): Record<Id, Link> | undefined {
  const out: Record<Id, Link> = {}
  lines
    .filter((line) => line.name === 'URL')
    .forEach((line, index) => {
      // A URI value, not text — the same rule as PHOTO. Unescaping it would corrupt a query string.
      const uri = line.value.trim()
      if (uri === '') return
      out[entryId(line, 'link', index)] = compact<Link>({
        uri,
        pref: prefOf(line),
        label: line.params.get('LABEL')?.[0],
      })
    })
  return Object.keys(out).length > 0 ? out : undefined
}

function buildNotes(lines: readonly ContentLine[]): Record<Id, Note> | undefined {
  const out: Record<Id, Note> = {}
  lines
    .filter((line) => line.name === 'NOTE')
    .forEach((line, index) => {
      const note = unescapeText(line.value)
      if (note === '') return
      out[entryId(line, 'n', index)] = { note }
    })
  return Object.keys(out).length > 0 ? out : undefined
}

function buildMedia(lines: readonly ContentLine[]): Record<Id, Media> | undefined {
  const out: Record<Id, Media> = {}
  let index = 0
  for (const line of lines) {
    const kind = line.name === 'PHOTO' ? 'photo' : line.name === 'LOGO' ? 'logo' : null
    if (kind === null) continue
    // The value is a URI (a `data:` URI for an embedded image). It is NOT text-escaped in vCard 4.0,
    // so unescaping it would corrupt any base64 payload containing a comma or a backslash.
    const uri = line.value.trim()
    if (uri === '') continue
    out[entryId(line, 'm', index)] = compact<Media>({
      kind,
      uri,
      mediaType: line.params.get('MEDIATYPE')?.[0],
      pref: prefOf(line),
    })
    index++
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function buildKeywords(lines: readonly ContentLine[]): BooleanSet | undefined {
  const out: Record<string, true> = {}
  for (const line of lines) {
    if (line.name !== 'CATEGORIES') continue
    for (const value of listValues(line.value)) {
      const keyword = value.trim()
      if (keyword !== '') out[keyword] = true
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function buildMembers(lines: readonly ContentLine[]): BooleanSet | undefined {
  const out: Record<string, true> = {}
  for (const line of lines) {
    if (line.name !== 'MEMBER') continue
    const uid = line.value.trim()
    if (uid !== '') out[uid] = true
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function convertCard(lines: readonly ContentLine[], newUid: () => string): Card {
  const uidLine = lines.find((line) => line.name === 'UID')
  const kindLine = lines.find((line) => line.name === 'KIND')
  const revLine = lines.find((line) => line.name === 'REV')

  const kindRaw =
    kindLine === undefined ? undefined : unescapeText(kindLine.value).trim().toLowerCase()
  const kind = (['individual', 'group', 'org', 'location', 'device', 'application'] as const).find(
    (candidate) => candidate === kindRaw,
  )

  // Everything we did not map, kept verbatim (RFC 9555 §2.15.2). This is the difference between an
  // import that loses a hoster's custom fields and one that hands them back on export.
  const vCardProps = lines.filter((line) => !MAPPED.has(line.name)).map(toJCardProp)

  return compact<Card>({
    '@type': 'Card' as const,
    version: '1.0' as const,
    uid: uidLine === undefined ? newUid() : unescapeText(uidLine.value).trim() || newUid(),
    kind,
    updated: revLine === undefined ? undefined : unescapeText(revLine.value).trim(),
    name: buildName(lines),
    nicknames: buildNicknames(lines),
    emails: buildEmails(lines),
    phones: buildPhones(lines),
    addresses: buildAddresses(lines),
    organizations: buildOrganizations(lines),
    titles: buildTitles(lines),
    anniversaries: buildAnniversaries(lines),
    notes: buildNotes(lines),
    media: buildMedia(lines),
    links: buildLinks(lines),
    keywords: buildKeywords(lines),
    members: buildMembers(lines),
    ...(vCardProps.length > 0 ? { vCardProps } : {}),
  })
}

/**
 * A UID for a vCard that has none, as RFC 9555 §2.1.1 requires.
 *
 * `crypto` is read off `globalThis` through a narrow local declaration rather than a `lib` entry:
 * it is the package's ONLY platform dependency, it is optional, and declaring it here keeps the
 * dependency visible instead of letting `lib: ["DOM"]` imply the whole browser API surface is fair
 * game. `crypto.randomUUID` exists in browsers, in Node ≥ 19 and in workers; the fallback is for
 * anything older, and it is why {@link ImportOptions.newUid} exists for callers who need better.
 */
interface CryptoLike {
  randomUUID?: () => string
}

function defaultUid(): string {
  const webCrypto = (globalThis as { crypto?: CryptoLike }).crypto
  if (typeof webCrypto?.randomUUID === 'function') return `urn:uuid:${webCrypto.randomUUID()}`
  return `urn:uuid:${Math.random().toString(16).slice(2)}-${String(Date.now())}`
}

/** Convert a vCard 4.0 document (one card or many) to JSContact. Never throws. */
export function fromVCard(text: string, options: ImportOptions = {}): ImportResult {
  const newUid = options.newUid ?? defaultUid
  const { lines, skipped } = parseContentLines(text)
  return { cards: splitCards(lines).map((card) => convertCard(card, newUid)), skipped }
}
