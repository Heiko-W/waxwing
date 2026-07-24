/**
 * Lossless {@link ContactCard} ⇄ form-model mapping for the contact editor (M4.2, stage 5b).
 *
 * Two invariants make an edit safe to send as a `ContactCard/set update`:
 *
 *  1. **Map-key identity.** JSContact collections (`emails`, `phones`, `addresses`, `media`, …) are
 *     `Record<Id, …>` with OPAQUE keys that RFC 9555 maps to and from vCard's `PROP-ID`. This module
 *     remembers each entry's key on the way in ({@link cardToForm}) and writes it back under the SAME
 *     key ({@link formToCard}); only a genuinely new row mints a fresh key from an injected id source.
 *     Reusing keys is what keeps the server diff a real diff — without it every edit looks like a full
 *     replacement of the collection.
 *
 *  2. **Nothing the form does not know about is dropped.** {@link formToCard} builds its result as
 *     `{ ...base, <overridden fields> }`, so unmapped `Card` properties (`nicknames`, `links`,
 *     `keywords`, `members`, `vCardProps`, `uid`, …) and every entry-level property the form does not
 *     surface (`pref`, `label`, an address's `coordinates`, a photo's extra media props) ride through
 *     untouched. Sub-collections that the form edits only PARTIALLY — the birthday inside
 *     `anniversaries`, the photo inside `media` — carry their siblings in {@link ContactFormModel.preserved}.
 *
 * The write is expressed as a MINIMAL {@link PatchObject} via {@link diffCardPatch}: only the top-level
 * JSContact properties that actually changed appear, each replaced whole (RFC 8620 §5.3 top-level
 * replace / remove) — the patch shape {@link enqueueUpdateContactCard} (stage 5a) forwards verbatim.
 *
 * Pure and id-source-injectable, so a test pins round-trip identity, single-field diffs and key
 * stability deterministically.
 */

import type { ContactCard, ContactCardMedia, Id, PatchObject } from '@waxwing/jmap'
import type {
  Address,
  AddressComponent,
  AddressComponentKind,
  Anniversary,
  BooleanSet,
  EmailAddress,
  Name,
  NameComponent,
  NameComponentKind,
  Note,
  Organization,
  PartialDate,
  Phone,
  Timestamp,
  Title,
} from '@waxwing/jscontact'
import { communicationTypeKey, preferredEntries } from './contact-fields'

/** A client-generated, collision-free key source (injectable for deterministic tests). */
export type IdSource = () => Id

/** Phone `features` (RFC 9553 §2.3.3) — a type in this set writes to `features`, others to `contexts`. */
const PHONE_FEATURES: ReadonlySet<string> = new Set([
  'mobile',
  'voice',
  'text',
  'video',
  'main-number',
  'textphone',
  'fax',
  'pager',
])

// ── Form model ────────────────────────────────────────────────────────────────────────────────

/** The five editable {@link Name} component slots (Apple Contacts: Prefix/First/Middle/Last/Suffix). */
export interface NameFields {
  readonly prefix: string
  readonly given: string
  readonly given2: string
  readonly surname: string
  readonly suffix: string
}

export interface EmailEntry {
  readonly key: Id
  readonly type: string
  readonly address: string
  readonly original?: EmailAddress
}

export interface PhoneEntry {
  readonly key: Id
  readonly type: string
  readonly number: string
  readonly original?: Phone
}

export interface AddressEntry {
  readonly key: Id
  readonly type: string
  readonly street: string
  readonly locality: string
  readonly region: string
  readonly postcode: string
  readonly country: string
  readonly original?: Address
}

export interface NoteEntry {
  readonly key: Id
  readonly text: string
  readonly original?: Note
}

/** The single edited photo (RFC 9553 §2.7 media `kind: 'photo'`); `previewUrl` is display-only. */
export interface PhotoField {
  readonly key: Id
  readonly mediaType?: string
  readonly blobId?: string
  readonly uri?: string
  readonly previewUrl?: string
  readonly original?: ContactCardMedia
}

/** Sub-collection entries the form does not surface as rows but must carry through a round-trip. */
export interface PreservedCollections {
  readonly organizations: Readonly<Record<Id, Organization>>
  readonly titles: Readonly<Record<Id, Title>>
  readonly anniversaries: Readonly<Record<Id, Anniversary>>
  readonly media: Readonly<Record<Id, ContactCardMedia>>
}

export interface ContactFormModel {
  readonly name: NameFields
  readonly nameOriginal?: Name
  readonly organization: string
  readonly organizationKey?: Id
  readonly organizationOriginal?: Organization
  readonly title: string
  readonly titleKey?: Id
  readonly titleOriginal?: Title
  readonly emails: readonly EmailEntry[]
  readonly phones: readonly PhoneEntry[]
  readonly addresses: readonly AddressEntry[]
  /** Birthday as an `<input type="date">` value (`YYYY-MM-DD`); `''` when absent or non-representable. */
  readonly birthday: string
  readonly birthdayKey?: Id
  readonly birthdayOriginal?: Anniversary
  readonly notes: readonly NoteEntry[]
  readonly photo: PhotoField | null
  readonly preserved: PreservedCollections
}

/** A blank form for a brand-new contact (no rows revealed yet; the UI adds the first ones). */
export function emptyFormModel(): ContactFormModel {
  return {
    name: { prefix: '', given: '', given2: '', surname: '', suffix: '' },
    organization: '',
    title: '',
    emails: [],
    phones: [],
    addresses: [],
    birthday: '',
    notes: [],
    photo: null,
    preserved: { organizations: {}, titles: {}, anniversaries: {}, media: {} },
  }
}

// ── Row factories (the UI mints keys through the same injected source as formToCard) ────────────

export function newEmailEntry(newId: IdSource): EmailEntry {
  return { key: newId(), type: '', address: '' }
}
export function newPhoneEntry(newId: IdSource): PhoneEntry {
  return { key: newId(), type: '', number: '' }
}
export function newAddressEntry(newId: IdSource): AddressEntry {
  return { key: newId(), type: '', street: '', locality: '', region: '', postcode: '', country: '' }
}
export function newNoteEntry(newId: IdSource): NoteEntry {
  return { key: newId(), text: '' }
}

// ── card → form ─────────────────────────────────────────────────────────────────────────────

export function cardToForm(card: Partial<ContactCard>): ContactFormModel {
  const emails: EmailEntry[] = preferredEntries(card.emails).map(([key, value]) => ({
    key,
    type: communicationTypeKey(value) ?? '',
    address: value.address,
    original: value,
  }))
  const phones: PhoneEntry[] = preferredEntries(card.phones).map(([key, value]) => ({
    key,
    type: communicationTypeKey(value) ?? '',
    number: value.number,
    original: value,
  }))
  const addresses: AddressEntry[] = preferredEntries(card.addresses).map(([key, value]) => ({
    key,
    type: communicationTypeKey(value) ?? '',
    ...extractAddressFields(value),
    original: value,
  }))
  const notes: NoteEntry[] = preferredEntries(card.notes).map(([key, value]) => ({
    key,
    text: value.note,
    original: value,
  }))

  const orgEntry = preferredEntries(card.organizations)[0]
  const titleEntry = preferredEntries(card.titles)[0]
  const birthEntry = preferredEntries(card.anniversaries).find(([, a]) => a.kind === 'birth')
  const photo = photoEntry(card)

  return {
    name: extractNameFields(card.name),
    ...(card.name ? { nameOriginal: card.name } : {}),
    organization: orgEntry?.[1].name ?? '',
    ...(orgEntry ? { organizationKey: orgEntry[0], organizationOriginal: orgEntry[1] } : {}),
    title: titleEntry?.[1].name ?? '',
    ...(titleEntry ? { titleKey: titleEntry[0], titleOriginal: titleEntry[1] } : {}),
    emails,
    phones,
    addresses,
    birthday: extractBirthdayString(birthEntry?.[1]),
    ...(birthEntry ? { birthdayKey: birthEntry[0], birthdayOriginal: birthEntry[1] } : {}),
    notes,
    photo: photo ? { key: photo[0], ...pickMediaFields(photo[1]), original: photo[1] } : null,
    preserved: {
      organizations: omitKey(card.organizations, orgEntry?.[0]),
      titles: omitKey(card.titles, titleEntry?.[0]),
      anniversaries: omitKey(card.anniversaries, birthEntry?.[0]),
      media: omitKey(card.media, photo?.[0]),
    },
  }
}

// ── form → card ─────────────────────────────────────────────────────────────────────────────

/**
 * Fold a form back onto `base` (the original card for an edit, or a fresh seed for a create),
 * overriding only the JSContact properties the form controls and leaving everything else in place.
 */
export function formToCard(
  form: ContactFormModel,
  base: ContactCard,
  newId: IdSource,
): ContactCard {
  const result: Record<string, unknown> = { ...(base as unknown as Record<string, unknown>) }
  setOrDelete(result, 'name', formToName(form.name, form.nameOriginal))
  setOrDelete(result, 'organizations', formToOrganizations(form, newId))
  setOrDelete(result, 'titles', formToTitles(form, newId))
  setOrDelete(result, 'emails', formToEmails(form.emails))
  setOrDelete(result, 'phones', formToPhones(form.phones))
  setOrDelete(result, 'addresses', formToAddresses(form.addresses))
  setOrDelete(result, 'anniversaries', formToAnniversaries(form, newId))
  setOrDelete(result, 'notes', formToNotes(form.notes))
  setOrDelete(result, 'media', formToMedia(form))
  return result as unknown as ContactCard
}

/** Top-level JSContact properties the form owns — the only keys {@link diffCardPatch} may emit. */
const CONTROLLED_PROPS = [
  'name',
  'organizations',
  'titles',
  'emails',
  'phones',
  'addresses',
  'anniversaries',
  'notes',
  'media',
] as const

/**
 * A minimal {@link PatchObject} between the original card and the form's reconstruction: one entry per
 * top-level property that changed, replaced whole (or `null` to remove). A property the form did not
 * touch reconstructs deep-equal to the original and never appears — so a single-field edit is a
 * single-key patch.
 */
export function diffCardPatch(
  original: Partial<ContactCard>,
  next: Partial<ContactCard>,
): PatchObject {
  const patch: PatchObject = {}
  for (const key of CONTROLLED_PROPS) {
    const before = (original as Record<string, unknown>)[key]
    const after = (next as Record<string, unknown>)[key]
    if (before === undefined && after === undefined) continue
    if (deepEqual(before, after)) continue
    patch[key] = after === undefined ? null : after
  }
  return patch
}

// ── Name ──────────────────────────────────────────────────────────────────────────────────────

const EDITABLE_NAME_KINDS: ReadonlySet<NameComponentKind> = new Set([
  'title',
  'given',
  'given2',
  'surname',
  'generation',
])

function joinComponents(name: Name | undefined, kind: NameComponentKind): string {
  return (name?.components ?? [])
    .filter((component) => component.kind === kind)
    .map((component) => component.value)
    .join(' ')
}

function extractNameFields(name: Name | undefined): NameFields {
  return {
    prefix: joinComponents(name, 'title'),
    given: joinComponents(name, 'given'),
    given2: joinComponents(name, 'given2'),
    surname: joinComponents(name, 'surname'),
    suffix: joinComponents(name, 'generation'),
  }
}

function formToName(fields: NameFields, original: Name | undefined): Name | undefined {
  const extracted = extractNameFields(original)
  const unchanged =
    original !== undefined &&
    fields.prefix === extracted.prefix &&
    fields.given === extracted.given &&
    fields.given2 === extracted.given2 &&
    fields.surname === extracted.surname &&
    fields.suffix === extracted.suffix
  if (unchanged) return original

  const components: NameComponent[] = []
  const push = (kind: NameComponentKind, value: string): void => {
    if (value.trim() !== '') components.push({ '@type': 'NameComponent', kind, value })
  }
  push('title', fields.prefix)
  push('given', fields.given)
  push('given2', fields.given2)
  push('surname', fields.surname)
  push('generation', fields.suffix)
  // Keep any component of a kind the form does not surface (credential, surname2, separator).
  for (const component of original?.components ?? []) {
    if (!EDITABLE_NAME_KINDS.has(component.kind)) components.push(component)
  }
  if (components.length === 0) return undefined
  return { '@type': 'Name', components }
}

// ── Communication type (contexts / features) ────────────────────────────────────────────────

function applyType(
  base: Record<string, unknown>,
  formType: string,
  original: { readonly features?: BooleanSet; readonly contexts?: BooleanSet } | undefined,
  allowFeatures: boolean,
): void {
  const extracted = original ? (communicationTypeKey(original) ?? '') : ''
  if (formType === extracted) return // unchanged → keep the original buckets verbatim
  delete base.features
  delete base.contexts
  if (formType === '') return
  if (allowFeatures && PHONE_FEATURES.has(formType)) base.features = { [formType]: true }
  else base.contexts = { [formType]: true }
}

// ── Emails / phones ─────────────────────────────────────────────────────────────────────────

function formToEmails(entries: readonly EmailEntry[]): Record<Id, EmailAddress> | undefined {
  const out: Record<Id, EmailAddress> = {}
  for (const entry of entries) {
    if (entry.address.trim() === '') continue
    const base: Record<string, unknown> = entry.original
      ? { ...entry.original }
      : { '@type': 'EmailAddress' }
    base.address = entry.address
    applyType(base, entry.type, entry.original, false)
    out[entry.key] = base as unknown as EmailAddress
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function formToPhones(entries: readonly PhoneEntry[]): Record<Id, Phone> | undefined {
  const out: Record<Id, Phone> = {}
  for (const entry of entries) {
    if (entry.number.trim() === '') continue
    const base: Record<string, unknown> = entry.original
      ? { ...entry.original }
      : { '@type': 'Phone' }
    base.number = entry.number
    applyType(base, entry.type, entry.original, true)
    out[entry.key] = base as unknown as Phone
  }
  return Object.keys(out).length > 0 ? out : undefined
}

// ── Addresses ─────────────────────────────────────────────────────────────────────────────────

const ADDRESS_ORDER: readonly (readonly [keyof AddressFields, AddressComponentKind])[] = [
  ['street', 'name'],
  ['locality', 'locality'],
  ['region', 'region'],
  ['postcode', 'postcode'],
  ['country', 'country'],
]

interface AddressFields {
  readonly street: string
  readonly locality: string
  readonly region: string
  readonly postcode: string
  readonly country: string
}

function addrValue(address: Address, kind: AddressComponentKind): string {
  return (address.components ?? [])
    .filter((component) => component.kind === kind)
    .map((component) => component.value)
    .join(' ')
}

function extractAddressFields(address: Address): AddressFields {
  return {
    street: addrValue(address, 'name'),
    locality: addrValue(address, 'locality'),
    region: addrValue(address, 'region'),
    postcode: addrValue(address, 'postcode'),
    country: addrValue(address, 'country'),
  }
}

function addressFieldsEmpty(entry: AddressEntry): boolean {
  return ADDRESS_ORDER.every(([field]) => entry[field].trim() === '')
}

function addressUnchanged(entry: AddressEntry, original: Address): boolean {
  const extracted = extractAddressFields(original)
  return (
    ADDRESS_ORDER.every(([field]) => entry[field] === extracted[field]) &&
    entry.type === (communicationTypeKey(original) ?? '')
  )
}

function formToAddresses(entries: readonly AddressEntry[]): Record<Id, Address> | undefined {
  const out: Record<Id, Address> = {}
  for (const entry of entries) {
    // A blank row the user added but never filled is discarded; an original with only a `full`
    // string (no structured components) has empty fields yet must survive — keep it.
    if (entry.original === undefined && addressFieldsEmpty(entry)) continue
    if (entry.original !== undefined && addressUnchanged(entry, entry.original)) {
      out[entry.key] = entry.original
      continue
    }
    const components: AddressComponent[] = []
    for (const [field, kind] of ADDRESS_ORDER) {
      const value = entry[field]
      if (value.trim() !== '') components.push({ '@type': 'AddressComponent', kind, value })
    }
    const base: Record<string, unknown> = { '@type': 'Address' }
    if (components.length > 0) base.components = components
    applyType(base, entry.type, entry.original, false)
    out[entry.key] = base as Address
  }
  return Object.keys(out).length > 0 ? out : undefined
}

// ── Notes ─────────────────────────────────────────────────────────────────────────────────────

function formToNotes(entries: readonly NoteEntry[]): Record<Id, Note> | undefined {
  const out: Record<Id, Note> = {}
  for (const entry of entries) {
    if (entry.text.trim() === '') continue
    const base: Record<string, unknown> = entry.original
      ? { ...entry.original }
      : { '@type': 'Note' }
    base.note = entry.text
    out[entry.key] = base as unknown as Note
  }
  return Object.keys(out).length > 0 ? out : undefined
}

// ── Organization / title (single edited value + preserved siblings) ─────────────────────────

function formToOrganizations(
  form: ContactFormModel,
  newId: IdSource,
): Record<Id, Organization> | undefined {
  const preserved = { ...form.preserved.organizations }
  const original = form.organizationOriginal
  const extracted = original?.name ?? ''
  let edited: Organization | undefined
  if (form.organization === extracted && original !== undefined) {
    edited = original
  } else if (form.organization.trim() !== '') {
    const base: Record<string, unknown> = original ? { ...original } : { '@type': 'Organization' }
    base.name = form.organization
    edited = base as Organization
  }
  const result: Record<Id, Organization> =
    edited !== undefined ? { [form.organizationKey ?? newId()]: edited, ...preserved } : preserved
  return Object.keys(result).length > 0 ? result : undefined
}

function formToTitles(form: ContactFormModel, newId: IdSource): Record<Id, Title> | undefined {
  const preserved = { ...form.preserved.titles }
  const original = form.titleOriginal
  const extracted = original?.name ?? ''
  let edited: Title | undefined
  if (form.title === extracted && original !== undefined) {
    edited = original
  } else if (form.title.trim() !== '') {
    const base: Record<string, unknown> = original ? { ...original } : { '@type': 'Title' }
    base.name = form.title
    edited = base as unknown as Title
  }
  const result: Record<Id, Title> =
    edited !== undefined ? { [form.titleKey ?? newId()]: edited, ...preserved } : preserved
  return Object.keys(result).length > 0 ? result : undefined
}

// ── Birthday (inside anniversaries) ─────────────────────────────────────────────────────────

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0')
}

function extractBirthdayString(anniversary: Anniversary | undefined): string {
  if (anniversary === undefined) return ''
  const date = anniversary.date
  if (isTimestamp(date)) {
    const parsed = new Date(date.utc)
    if (Number.isNaN(parsed.getTime())) return ''
    return `${pad(parsed.getUTCFullYear(), 4)}-${pad(parsed.getUTCMonth() + 1)}-${pad(parsed.getUTCDate())}`
  }
  if (date.year !== undefined && date.month !== undefined && date.day !== undefined) {
    return `${pad(date.year, 4)}-${pad(date.month)}-${pad(date.day)}`
  }
  return ''
}

function isTimestamp(date: PartialDate | Timestamp): date is Timestamp {
  return (date as Timestamp).utc !== undefined
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function formToAnniversaries(
  form: ContactFormModel,
  newId: IdSource,
): Record<Id, Anniversary> | undefined {
  const preserved = { ...form.preserved.anniversaries }
  const original = form.birthdayOriginal
  const extracted = extractBirthdayString(original)
  let birthday: Anniversary | undefined
  if (form.birthday === extracted && original !== undefined) {
    birthday = original
  } else if (ISO_DATE.test(form.birthday)) {
    const [year, month, day] = form.birthday.split('-').map(Number) as [number, number, number]
    birthday = {
      '@type': 'Anniversary',
      kind: 'birth',
      date: { '@type': 'PartialDate', year, month, day },
    }
  }
  const result: Record<Id, Anniversary> =
    birthday !== undefined ? { [form.birthdayKey ?? newId()]: birthday, ...preserved } : preserved
  return Object.keys(result).length > 0 ? result : undefined
}

// ── Media (photo + preserved logos/sounds) ────────────────────────────────────────────────

function photoEntry(card: Partial<ContactCard>): [Id, ContactCardMedia] | undefined {
  const photos = preferredEntries(card.media).filter(([, media]) => media.kind === 'photo')
  return (
    photos.find(([, media]) => media.blobId !== undefined || media.uri !== undefined) ?? photos[0]
  )
}

function pickMediaFields(media: ContactCardMedia): {
  mediaType?: string
  blobId?: string
  uri?: string
} {
  return {
    ...(media.mediaType !== undefined ? { mediaType: media.mediaType } : {}),
    ...(media.blobId !== undefined ? { blobId: media.blobId } : {}),
    ...(media.uri !== undefined ? { uri: media.uri } : {}),
  }
}

function formToMedia(form: ContactFormModel): Record<Id, ContactCardMedia> | undefined {
  const preserved = { ...form.preserved.media }
  const photo = form.photo
  if (photo === null) {
    return Object.keys(preserved).length > 0 ? preserved : undefined
  }
  const base: Record<string, unknown> = photo.original
    ? { ...photo.original }
    : { '@type': 'Media', kind: 'photo' }
  if (photo.blobId !== undefined) {
    base.blobId = photo.blobId
    delete base.uri
  } else if (photo.uri !== undefined) {
    base.uri = photo.uri
    delete base.blobId
  }
  if (photo.mediaType !== undefined) base.mediaType = photo.mediaType
  return { [photo.key]: base as unknown as ContactCardMedia, ...preserved }
}

// ── Small utilities ─────────────────────────────────────────────────────────────────────────

function setOrDelete(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined) delete target[key]
  else target[key] = value
}

function omitKey<T>(
  record: Readonly<Record<Id, T>> | undefined,
  key: Id | undefined,
): Record<Id, T> {
  if (record === undefined) return {}
  const out: Record<Id, T> = {}
  for (const [entryKey, value] of Object.entries(record)) {
    if (entryKey !== key) out[entryKey] = value
  }
  return out
}

/**
 * Structural equality over plain JSON-ish values (ignores object key order). Exported so the group
 * mapping ({@link ./contact-group-mapping}) computes its minimal `name`/`members` patch on the SAME
 * comparison this module's {@link diffCardPatch} uses, rather than duplicating the recursion.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  const arrayA = Array.isArray(a)
  const arrayB = Array.isArray(b)
  if (arrayA !== arrayB) return false
  if (arrayA && arrayB) {
    if (a.length !== b.length) return false
    return a.every((value, index) => deepEqual(value, b[index]))
  }
  const recordA = a as Record<string, unknown>
  const recordB = b as Record<string, unknown>
  const keysA = Object.keys(recordA)
  const keysB = Object.keys(recordB)
  if (keysA.length !== keysB.length) return false
  return keysA.every((key) => Object.hasOwn(recordB, key) && deepEqual(recordA[key], recordB[key]))
}
