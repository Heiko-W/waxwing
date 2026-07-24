/**
 * Pure JSContact field helpers for the contacts read path (M4.2). Deliberately TYPE-ONLY imports of
 * `@waxwing/jscontact` and the JMAP contact media type: rendering a card needs the SHAPES, not the
 * conversion runtime, so nothing here adds a runtime edge to the lazy `ContactsPage` chunk (keeps the
 * size budget honest — the jscontact package must not land in the bundle for a read-only view).
 *
 * These functions are the single source of a card's DISPLAY identity — the name shown in the list, the
 * initials in the avatar, and the substring index the local search filters on — so the list row, the
 * detail header and the search all agree on what a contact "is called".
 */

import type { ContactCardMedia } from '@waxwing/jmap'
import type {
  Address,
  Anniversary,
  EmailAddress,
  Name,
  Note,
  Organization,
  PartialDate,
  Phone,
  Timestamp,
  Title,
} from '@waxwing/jscontact'

/**
 * The subset of a {@link import('../sync').ContactCardRow} these helpers read. Declared structurally
 * so the helpers stay usable from a test with a hand-built card and never depend on the full row.
 */
export interface CardLike {
  readonly uid?: string
  readonly name?: Name
  readonly nicknames?: Readonly<Record<string, { readonly name: string; readonly pref?: number }>>
  readonly emails?: Readonly<Record<string, EmailAddress>>
  readonly phones?: Readonly<Record<string, Phone>>
  readonly addresses?: Readonly<Record<string, Address>>
  readonly organizations?: Readonly<Record<string, Organization>>
  readonly titles?: Readonly<Record<string, Title>>
  readonly anniversaries?: Readonly<Record<string, Anniversary>>
  readonly notes?: Readonly<Record<string, Note>>
  readonly media?: Readonly<Record<string, ContactCardMedia>>
}

function prefOf(value: unknown): number {
  const pref = (value as { pref?: number }).pref
  return pref ?? Number.POSITIVE_INFINITY
}

/**
 * The values of a JSContact map (`emails`, `phones`, …) in preference order: `pref` 1 is the most
 * preferred (RFC 9553 §1.4.5), absent `pref` sorts last, and ties keep insertion order (a stable
 * sort). Every "primary X" and every "list the X" below reads from this, so the primary is always the
 * first element. Types that carry no `pref` (organizations, titles, notes, anniversaries) simply keep
 * their insertion order — the sort is stable and every key resolves to the same `Infinity`.
 */
export function preferred<T>(record: Readonly<Record<string, T>> | undefined): T[] {
  if (record === undefined) return []
  return Object.values(record).sort((a, b) => prefOf(a) - prefOf(b))
}

/**
 * Like {@link preferred}, but keeps each entry's JSContact map id alongside its value — the id is the
 * stable React key for rendering a list of emails/phones/etc. (never the array index).
 */
export function preferredEntries<T>(
  record: Readonly<Record<string, T>> | undefined,
): [string, T][] {
  if (record === undefined) return []
  return Object.entries(record).sort(([, a], [, b]) => prefOf(a) - prefOf(b))
}

/** The name components of a given kind, in card order. */
function componentValues(name: Name | undefined, kind: string): string[] {
  return (name?.components ?? [])
    .filter((component) => component.kind === kind)
    .map((component) => component.value)
    .filter((value) => value.trim() !== '')
}

/**
 * A card's display name (RFC 9555 order of preference): the whole-name `full` when the card carries
 * one (a locale/user ordering we must not second-guess), else given + surname, else every name
 * component joined, else the first nickname / organization / email, else `''`. Callers substitute a
 * localized "No name" for the empty result — this helper stays pure and translation-free.
 */
export function contactDisplayName(card: CardLike): string {
  const full = card.name?.full?.trim()
  if (full) return full

  const given = componentValues(card.name, 'given').join(' ')
  const surname = componentValues(card.name, 'surname').join(' ')
  const structured = [given, surname]
    .filter((part) => part !== '')
    .join(' ')
    .trim()
  if (structured) return structured

  const allComponents = (card.name?.components ?? [])
    .map((component) => component.value)
    .join(' ')
    .trim()
  if (allComponents) return allComponents

  const nickname = preferred(card.nicknames)[0]?.name.trim()
  if (nickname) return nickname
  const organization = preferred(card.organizations)[0]?.name?.trim()
  if (organization) return organization
  const email = preferred(card.emails)[0]?.address.trim()
  if (email) return email

  return ''
}

/**
 * The card's preferred photo, if any (RFC 9553 §2.7 media of `kind: 'photo'`). A photo may carry a
 * JMAP `blobId` (server-externalised, RFC 9610 §1.6.3) OR an inline `uri` (`data:` most often); this
 * returns the media object so the caller can pick whichever it has.
 */
export function contactPhoto(card: CardLike): ContactCardMedia | undefined {
  const photos = preferred(card.media).filter((media) => media.kind === 'photo')
  return photos.find((media) => media.blobId !== undefined || media.uri !== undefined) ?? photos[0]
}

/** True when the card matches a (already-lowercased) search needle anywhere a user would expect. */
export function contactMatches(card: CardLike, needleLower: string): boolean {
  if (needleLower === '') return true
  const haystack: string[] = [contactDisplayName(card)]
  haystack.push(...componentValues(card.name, 'given'))
  haystack.push(...componentValues(card.name, 'surname'))
  for (const nickname of preferred(card.nicknames)) haystack.push(nickname.name)
  for (const email of preferred(card.emails)) haystack.push(email.address)
  for (const phone of preferred(card.phones)) haystack.push(phone.number)
  for (const organization of preferred(card.organizations)) {
    if (organization.name !== undefined) haystack.push(organization.name)
  }
  return haystack.some((value) => value.toLowerCase().includes(needleLower))
}

/** A locale-comparable sort key for the list (Apple Contacts orders alphabetically by display name). */
export function contactSortKey(card: CardLike): string {
  return contactDisplayName(card).toLowerCase()
}

// ── Detail-view field extraction ────────────────────────────────────────────────────────────────

/** The card's job title / role text (first title's name), or `undefined`. */
export function contactTitle(card: CardLike): string | undefined {
  return preferred(card.titles)[0]?.name?.trim() || undefined
}

/** The card's organization name (first org), or `undefined`. */
export function contactOrganization(card: CardLike): string | undefined {
  return preferred(card.organizations)[0]?.name?.trim() || undefined
}

/** The card's birthday anniversary (`kind: 'birth'`), or `undefined`. */
export function contactBirthday(card: CardLike): Anniversary | undefined {
  return preferred(card.anniversaries).find((anniversary) => anniversary.kind === 'birth')
}

function isTimestamp(date: PartialDate | Timestamp): date is Timestamp {
  return (date as Timestamp).utc !== undefined
}

/**
 * A birthday rendered as a plain string (locale-independent, translation-free). A full `PartialDate`
 * or `Timestamp` renders as a localized date via the caller's `Intl`; a partial date (e.g. "born on
 * 4 April, year withheld" → `--0404`, which no `Date` can hold) renders as `MM-DD` / the year alone.
 * Returns `undefined` when there is nothing printable.
 */
export function formatBirthday(anniversary: Anniversary, locale?: string): string | undefined {
  const date = anniversary.date
  if (isTimestamp(date)) {
    const parsed = new Date(date.utc)
    return Number.isNaN(parsed.getTime())
      ? undefined
      : parsed.toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric' })
  }
  const { year, month, day } = date
  if (year !== undefined && month !== undefined && day !== undefined) {
    // Construct at UTC noon so a negative timezone offset cannot roll the day backwards.
    return new Date(Date.UTC(year, month - 1, day, 12)).toLocaleDateString(locale, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })
  }
  const pad = (value: number): string => String(value).padStart(2, '0')
  if (month !== undefined && day !== undefined) return `${pad(month)}-${pad(day)}`
  if (year !== undefined) return String(year)
  return undefined
}

/**
 * The address components joined into printed lines (RFC 9553 §2.5). Prefers the pre-formatted `full`
 * when present (it is what the source app chose to display); otherwise joins the structured
 * components in a conventional order. Returns the lines so the caller can render `<br>`-separated.
 */
export function formatAddressLines(address: Address): string[] {
  const full = address.full?.trim()
  if (full)
    return full
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')

  const value = (kind: string): string =>
    (address.components ?? [])
      .filter((component) => component.kind === kind)
      .map((component) => component.value)
      .join(' ')
      .trim()

  const street = [value('postOfficeBox'), value('name'), value('apartment')]
    .filter((part) => part !== '')
    .join(' ')
  const cityLine = [value('postcode'), value('locality'), value('region')]
    .filter((part) => part !== '')
    .join(' ')
  const country = value('country')
  return [street, cityLine, country].filter((line) => line !== '')
}

/**
 * The label key for a communication entry's type (email/phone/address). A phone's `features` (mobile,
 * fax, …) win over its `contexts` (work/private); an explicit free-text `label` on the entry is the
 * caller's job to show verbatim (it is user data, not a translatable key). Returns a bare key such as
 * `mobile` / `work` / `private`, or `undefined` when the entry carries no recognisable type — the
 * caller maps a KNOWN key to a localized string and drops the rest, so no untranslated key is shown.
 */
export function communicationTypeKey(entry: {
  readonly features?: Readonly<Record<string, true>>
  readonly contexts?: Readonly<Record<string, true>>
}): string | undefined {
  const first = (set: Readonly<Record<string, true>> | undefined): string | undefined =>
    set === undefined ? undefined : Object.keys(set)[0]
  return first(entry.features) ?? first(entry.contexts)
}
