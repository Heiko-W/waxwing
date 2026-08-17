/**
 * JSContact → vCard 4.0 (M4.1, RFC 9555). The inverse of `from-vcard.ts`, and held to it by a
 * round-trip suite rather than by inspection.
 *
 * **`vCardProps` is written back out**, which is the half of "lossless" that is easy to skip: an
 * importer that preserves unknown properties and an exporter that ignores them together lose
 * exactly as much as one that never preserved anything. The properties come back with their
 * parameters and their group prefixes, so a card that arrived from Apple Contacts leaves with its
 * `X-ABLabel` lines still attached to the right fields.
 *
 * **The ordering of collection entries is the map's insertion order**, and that is deliberate
 * rather than incidental: JSContact collections are unordered by definition, but a person's phone
 * numbers have an order they typed them in, and re-sorting them alphabetically on every export
 * would make every round trip a visible change.
 */

import type {
  Address,
  Card,
  EmailAddress,
  Id,
  JCardProp,
  Link,
  Media,
  Name,
  Nickname,
  Note,
  Organization,
  PartialDate,
  Phone,
  Timestamp,
  Title,
} from './types'
import { escapeText } from './vcard/value'
import { joinList, joinStructured, renderCard, type WritableLine } from './vcard/write'

/** Inverse of `from-vcard.ts`'s `N_KINDS`, by position. */
const N_ORDER = ['surname', 'given', 'given2', 'title', 'credential'] as const

/** Inverse of `ADR_KINDS`, by position. */
const ADR_ORDER = [
  'postOfficeBox',
  'apartment',
  'name',
  'locality',
  'region',
  'postcode',
  'country',
] as const

/** JSContact context → vCard `TYPE`. `private` is vCard's `home` (RFC 9555). */
const CONTEXT_TO_TYPE: Readonly<Record<string, string>> = {
  private: 'home',
  work: 'work',
}

/** JSContact phone feature → vCard `TYPE`. */
const FEATURE_TO_TYPE: Readonly<Record<string, string>> = {
  mobile: 'cell',
  voice: 'voice',
  text: 'text',
  video: 'video',
  fax: 'fax',
  pager: 'pager',
  textphone: 'textphone',
  'main-number': 'main',
}

function setKeys(set: Readonly<Record<string, true>> | undefined): string[] {
  return set === undefined ? [] : Object.keys(set)
}

/**
 * Build the parameter map for a collection entry.
 *
 * `PROP-ID` carries the JSContact key back into the vCard (RFC 9555 §2.15.1), which is what makes an
 * export → import cycle return the SAME ids. Without it every round trip renumbers a person's phone
 * numbers, and anything comparing two exports sees changes that are not there.
 */
function entryParams(options: {
  readonly id: Id
  readonly types?: readonly string[]
  readonly pref?: number | undefined
  readonly label?: string | undefined
}): Map<string, string[]> {
  const params = new Map<string, string[]>()
  params.set('PROP-ID', [options.id])
  if (options.types !== undefined && options.types.length > 0) {
    params.set('TYPE', [...options.types])
  }
  if (options.pref !== undefined) params.set('PREF', [String(options.pref)])
  if (options.label !== undefined) params.set('LABEL', [options.label])
  return params
}

function nameLines(name: Name | undefined, out: WritableLine[]): void {
  if (name === undefined) return

  const components = name.components ?? []
  if (components.length > 0) {
    // Several components may share a kind (two given names, "Dr." and "Prof."), and vCard expresses
    // that as a comma list inside the positional slot — not as a repeated N property.
    const slots = N_ORDER.map((kind) =>
      joinList(components.filter((c) => c.kind === kind).map((c) => c.value)),
    )
    // `joinList` already escaped each value; `N` needs the components joined by unescaped `;`.
    if (slots.some((slot) => slot !== '')) out.push({ name: 'N', value: slots.join(';') })
  }

  if (name.full !== undefined && name.full !== '') {
    out.push({ name: 'FN', value: escapeText(name.full) })
  } else if (components.length > 0) {
    // FN is REQUIRED in vCard 4.0 (§6.2.1). Deriving one is worse than keeping the user's own, which
    // is why `full` wins — but emitting a card with no FN at all would be invalid, so a derived one
    // is the honest fallback. Display order, not N order.
    const derived = N_ORDER.filter((kind) => kind !== 'surname')
      .flatMap((kind) => components.filter((c) => c.kind === kind).map((c) => c.value))
      .concat(components.filter((c) => c.kind === 'surname').map((c) => c.value))
      .join(' ')
      .trim()
    out.push({ name: 'FN', value: escapeText(derived) })
  }
}

function emailLines(emails: Readonly<Record<Id, EmailAddress>> | undefined, out: WritableLine[]) {
  for (const [id, email] of Object.entries(emails ?? {})) {
    out.push({
      name: 'EMAIL',
      params: entryParams({
        id,
        types: setKeys(email.contexts).map((c) => CONTEXT_TO_TYPE[c] ?? c),
        pref: email.pref,
        label: email.label,
      }),
      value: escapeText(email.address),
    })
  }
}

function phoneLines(phones: Readonly<Record<Id, Phone>> | undefined, out: WritableLine[]) {
  for (const [id, phone] of Object.entries(phones ?? {})) {
    const types = [
      ...setKeys(phone.features).map((f) => FEATURE_TO_TYPE[f] ?? f),
      ...setKeys(phone.contexts).map((c) => CONTEXT_TO_TYPE[c] ?? c),
    ]
    out.push({
      name: 'TEL',
      params: entryParams({ id, types, pref: phone.pref, label: phone.label }),
      value: escapeText(phone.number),
    })
  }
}

function addressLines(addresses: Readonly<Record<Id, Address>> | undefined, out: WritableLine[]) {
  for (const [id, address] of Object.entries(addresses ?? {})) {
    const components = address.components ?? []
    const slots = ADR_ORDER.map((kind) =>
      components
        .filter((c) => c.kind === kind)
        .map((c) => c.value)
        .join(' '),
    )
    const params = entryParams({
      id,
      types: setKeys(address.contexts).map((c) => CONTEXT_TO_TYPE[c] ?? c),
      pref: address.pref,
      label: address.full,
    })
    if (address.countryCode !== undefined) params.set('CC', [address.countryCode])
    out.push({ name: 'ADR', params, value: joinStructured(slots) })
  }
}

function organizationLines(
  organizations: Readonly<Record<Id, Organization>> | undefined,
  out: WritableLine[],
) {
  for (const [id, org] of Object.entries(organizations ?? {})) {
    const components = [org.name ?? '', ...(org.units ?? []).map((unit) => unit.name)]
    const params = entryParams({
      id,
      types: setKeys(org.contexts).map((c) => CONTEXT_TO_TYPE[c] ?? c),
    })
    if (org.sortAs !== undefined) params.set('SORT-AS', [org.sortAs])
    out.push({ name: 'ORG', params, value: joinStructured(components) })
  }
}

function titleLines(titles: Readonly<Record<Id, Title>> | undefined, out: WritableLine[]) {
  for (const [id, title] of Object.entries(titles ?? {})) {
    out.push({
      name: title.kind === 'role' ? 'ROLE' : 'TITLE',
      params: entryParams({ id }),
      value: escapeText(title.name),
    })
  }
}

/** `1953-04-15`, or `--0415` when the year is withheld (§4.3.4). */
export function formatVCardDate(date: PartialDate | Timestamp): string | null {
  if ('utc' in date && typeof date.utc === 'string') return date.utc
  const partial = date as PartialDate
  const pad = (value: number) => String(value).padStart(2, '0')
  if (partial.year !== undefined && partial.month !== undefined && partial.day !== undefined) {
    return `${String(partial.year)}${pad(partial.month)}${pad(partial.day)}`
  }
  if (partial.month !== undefined && partial.day !== undefined) {
    return `--${pad(partial.month)}${pad(partial.day)}`
  }
  if (partial.year !== undefined && partial.month !== undefined) {
    return `${String(partial.year)}-${pad(partial.month)}`
  }
  if (partial.year !== undefined) return String(partial.year)
  return null
}

function anniversaryLines(card: Card, out: WritableLine[]) {
  const names: Readonly<Record<string, string>> = {
    birth: 'BDAY',
    wedding: 'ANNIVERSARY',
    death: 'DEATHDATE',
  }
  for (const [id, anniversary] of Object.entries(card.anniversaries ?? {})) {
    const name = names[anniversary.kind]
    const value = formatVCardDate(anniversary.date)
    if (name === undefined || value === null) continue
    out.push({ name, params: entryParams({ id }), value })
  }
}

function nicknameLines(nicknames: Readonly<Record<Id, Nickname>> | undefined, out: WritableLine[]) {
  for (const [id, nickname] of Object.entries(nicknames ?? {})) {
    out.push({
      name: 'NICKNAME',
      params: entryParams({
        id,
        types: setKeys(nickname.contexts).map((c) => CONTEXT_TO_TYPE[c] ?? c),
        pref: nickname.pref,
      }),
      value: escapeText(nickname.name),
    })
  }
}

function linkLines(links: Readonly<Record<Id, Link>> | undefined, out: WritableLine[]) {
  for (const [id, link] of Object.entries(links ?? {})) {
    // A URI value, unescaped — the same rule as PHOTO. Escaping a query string's `,` breaks it.
    // Unescaped is not unchecked: `renderLine` drops the control characters (CR/LF above all) that
    // an unescaped slot would otherwise let through as a forged second card.
    out.push({
      name: 'URL',
      params: entryParams({ id, pref: link.pref, label: link.label }),
      value: link.uri,
    })
  }
}

function noteLines(notes: Readonly<Record<Id, Note>> | undefined, out: WritableLine[]) {
  for (const [id, note] of Object.entries(notes ?? {})) {
    out.push({ name: 'NOTE', params: entryParams({ id }), value: escapeText(note.note) })
  }
}

function mediaLines(media: Readonly<Record<Id, Media>> | undefined, out: WritableLine[]) {
  for (const [id, item] of Object.entries(media ?? {})) {
    if (item.kind !== 'photo' && item.kind !== 'logo') continue
    const params = entryParams({ id, pref: item.pref })
    if (item.mediaType !== undefined) params.set('MEDIATYPE', [item.mediaType])
    // A URI value is NOT text-escaped in vCard 4.0 — escaping a `data:` URI would corrupt its
    // base64 payload wherever it contains a comma. `renderLine` still strips control characters
    // from it, which no legal `data:` or `https:` URI contains.
    out.push({ name: item.kind === 'photo' ? 'PHOTO' : 'LOGO', params, value: item.uri })
  }
}

/**
 * Write back the vCard properties this package never mapped (RFC 9555 §2.15.2).
 *
 * The value is used verbatim: it was captured verbatim on import, still escaped, so escaping it
 * again would double every backslash on each round trip — a corruption that compounds silently, one
 * export at a time.
 *
 * Verbatim is the escaping, not the syntax: `vCardProps` is the one part of a Card that carries
 * attacker-shaped property NAMES, parameter keys and raw values straight from a JSON import, and
 * `renderLine` removes the line breaks that would otherwise let any of the three end this card and
 * begin another.
 */
function preservedLines(props: readonly JCardProp[] | undefined, out: WritableLine[]) {
  for (const prop of props ?? []) {
    const [name, params, valueType, ...values] = prop
    const first = values[0]
    if (typeof first !== 'string') continue
    const written = new Map<string, string[]>()
    let group: string | null = null
    for (const [key, value] of Object.entries(params)) {
      if (key === 'group') {
        if (typeof value === 'string') group = value
        continue
      }
      const list = Array.isArray(value) ? value : [value]
      written.set(key.toUpperCase(), list.map(String))
    }
    // **The VALUE parameter has to come back.** jCard carries the value type in its own slot
    // (RFC 7095 §3.3) while vCard carries it as a parameter, so the import moves it out of the
    // parameters — and an export that does not move it back loses the type, one round trip at a
    // time. `unknown` is our own marker for "the vCard did not say", so it is not written.
    // Caught by the fixed-point test on the RFC 6350 example, whose `KEY;VALUE=uri` came back
    // untyped on the second pass.
    if (valueType !== '' && valueType !== 'unknown') {
      written.set('VALUE', [valueType])
    }
    out.push({ group, name: name.toUpperCase(), params: written, value: first })
  }
}

/** Convert one JSContact card to a vCard 4.0 document. */
export function toVCard(card: Card): string {
  const out: WritableLine[] = []

  // UID first, so a reader that streams sees the identity before anything else. Not required by the
  // format (only VERSION's position is), but it is what every exporter does and it reads better.
  out.push({ name: 'UID', value: escapeText(card.uid) })
  if (card.kind !== undefined) out.push({ name: 'KIND', value: card.kind })

  nameLines(card.name, out)
  nicknameLines(card.nicknames, out)
  emailLines(card.emails, out)
  phoneLines(card.phones, out)
  addressLines(card.addresses, out)
  organizationLines(card.organizations, out)
  titleLines(card.titles, out)
  anniversaryLines(card, out)
  noteLines(card.notes, out)
  mediaLines(card.media, out)
  linkLines(card.links, out)

  const keywords = Object.keys(card.keywords ?? {})
  if (keywords.length > 0) out.push({ name: 'CATEGORIES', value: joinList(keywords) })

  for (const uid of Object.keys(card.members ?? {})) {
    out.push({ name: 'MEMBER', value: escapeText(uid) })
  }

  if (card.updated !== undefined) out.push({ name: 'REV', value: card.updated })

  preservedLines(card.vCardProps, out)

  return renderCard(out)
}

/** Convert several cards into one vCard document, as an export file. */
export function toVCards(cards: readonly Card[]): string {
  return cards.map(toVCard).join('')
}
