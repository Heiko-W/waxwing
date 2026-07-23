/**
 * JSContact (RFC 9553) — the subset Waxwing reads and writes, typed exactly as it appears on the
 * wire, because these objects go straight into `ContactCard/set` (RFC 9610).
 *
 * **Two shapes recur and both are easy to mistype.** Collections are MAPS keyed by an opaque `Id`,
 * not arrays: `emails` is `{ "e1": {...} }`, and the key is the identity RFC 9555 maps to and from
 * vCard's `PROP-ID`. Sets are maps to `true` — `contexts: { work: true }` — never arrays of strings
 * and never `false`, since RFC 9553 §1.4.2 says a set member is present or absent, and writing
 * `false` is a way of saying nothing that some servers reject.
 *
 * Everything is `readonly` and optional-by-omission rather than nullable: `exactOptionalPropertyTypes`
 * is on across this repo, and a JSContact object with `"birthday": null` in it is not valid JSON
 * for RFC 9610 either.
 */

/** An opaque map key (RFC 9553 §1.4.1). Assigned by whoever creates the entry; never parsed. */
export type Id = string

/** A set: present means true. Absent means absent — `false` is never written (§1.4.2). */
export type BooleanSet = Readonly<Record<string, true>>

/** RFC 9553 §1.4.5 — `1` is the most preferred; higher is less. */
export type Pref = number

// ── Name ────────────────────────────────────────────────────────────────────────────────────────

/**
 * §2.2.1. The `kind` values are a closed IANA-registered set; the ones below are those RFC 9555
 * maps to and from vCard's five-component `N`.
 *
 * `separator` is a component whose value is literal text to place between the others — it exists so
 * a name that must render as "van der Berg, Anna" can say so without a locale rule.
 */
export type NameComponentKind =
  | 'title'
  | 'given'
  | 'given2'
  | 'surname'
  | 'surname2'
  | 'credential'
  | 'generation'
  | 'separator'

export interface NameComponent {
  readonly '@type'?: 'NameComponent'
  readonly kind: NameComponentKind
  readonly value: string
}

export interface Name {
  readonly '@type'?: 'Name'
  readonly components?: readonly NameComponent[]
  /**
   * The whole name as one string (vCard `FN`). Kept ALONGSIDE the components rather than derived:
   * RFC 9555 requires `FN` to use it when present, and deriving one loses every ordering a locale
   * or a person's own preference imposes.
   */
  readonly full?: string
  readonly sortAs?: Readonly<Partial<Record<NameComponentKind, string>>>
  /** `true` when `components` is in display order and must not be re-ordered by a renderer. */
  readonly isOrdered?: boolean
}

export interface Nickname {
  readonly '@type'?: 'Nickname'
  readonly name: string
  readonly contexts?: BooleanSet
  readonly pref?: Pref
}

// ── Communication ───────────────────────────────────────────────────────────────────────────────

/** §2.3.1. `contexts` uses `work` / `private` — NOT vCard's `home`; RFC 9555 renames it. */
export interface EmailAddress {
  readonly '@type'?: 'EmailAddress'
  readonly address: string
  readonly contexts?: BooleanSet
  readonly pref?: Pref
  readonly label?: string
}

/** §2.3.3 feature keys, as registered. `main-number` is hyphenated; the others are not. */
export type PhoneFeature =
  | 'mobile'
  | 'voice'
  | 'text'
  | 'video'
  | 'main-number'
  | 'textphone'
  | 'fax'
  | 'pager'

export interface Phone {
  readonly '@type'?: 'Phone'
  /** Free text or a `tel:` URI — RFC 9553 does not require the URI form, and exports rarely use it. */
  readonly number: string
  readonly features?: BooleanSet
  readonly contexts?: BooleanSet
  readonly pref?: Pref
  readonly label?: string
}

// ── Addresses ───────────────────────────────────────────────────────────────────────────────────

/** §2.5.1. The subset RFC 9555 maps to and from vCard's seven-component `ADR`. */
export type AddressComponentKind =
  | 'postOfficeBox'
  | 'apartment'
  | 'name'
  | 'locality'
  | 'region'
  | 'postcode'
  | 'country'
  | 'separator'

export interface AddressComponent {
  readonly '@type'?: 'AddressComponent'
  readonly kind: AddressComponentKind
  readonly value: string
}

export interface Address {
  readonly '@type'?: 'Address'
  readonly components?: readonly AddressComponent[]
  /** The formatted address (vCard's `LABEL` parameter). */
  readonly full?: string
  readonly countryCode?: string
  readonly coordinates?: string
  readonly timeZone?: string
  readonly contexts?: BooleanSet
  readonly pref?: Pref
  readonly isOrdered?: boolean
}

// ── Organisation, titles ────────────────────────────────────────────────────────────────────────

export interface OrgUnit {
  readonly '@type'?: 'OrgUnit'
  readonly name: string
}

export interface Organization {
  readonly '@type'?: 'Organization'
  readonly name?: string
  readonly units?: readonly OrgUnit[]
  readonly sortAs?: string
  readonly contexts?: BooleanSet
}

/** §2.2.5. vCard's `TITLE` → `kind: 'title'`; `ROLE` → `kind: 'role'`. */
export interface Title {
  readonly '@type'?: 'Title'
  readonly name: string
  readonly kind?: 'title' | 'role'
  readonly organizationId?: Id
}

// ── Dates, notes, media ─────────────────────────────────────────────────────────────────────────

/**
 * §2.8.1. A partial date: any of the three may be absent, which is how "born on 4 April, year
 * withheld" is expressed — a case vCard writes as `--0404` and a `Date` object cannot hold at all.
 */
export interface PartialDate {
  readonly '@type'?: 'PartialDate'
  readonly year?: number
  readonly month?: number
  readonly day?: number
  readonly calendarScale?: string
}

export interface Timestamp {
  readonly '@type'?: 'Timestamp'
  readonly utc: string
}

export interface Anniversary {
  readonly '@type'?: 'Anniversary'
  readonly kind: 'birth' | 'death' | 'wedding'
  readonly date: PartialDate | Timestamp
}

export interface Note {
  readonly '@type'?: 'Note'
  readonly note: string
}

export interface Media {
  readonly '@type'?: 'Media'
  readonly kind: 'photo' | 'sound' | 'logo'
  readonly uri: string
  readonly mediaType?: string
  readonly pref?: Pref
}

export interface Link {
  readonly '@type'?: 'Link'
  readonly uri: string
  readonly kind?: string
  readonly pref?: Pref
  readonly label?: string
}

// ── The card ────────────────────────────────────────────────────────────────────────────────────

/**
 * A jCard-encoded property (RFC 7095 §3.3): `[name, params, valueType, ...values]`.
 *
 * This is the vehicle RFC 9555 §2.15.2 defines for keeping vCard properties that JSContact has no
 * home for. It is what makes an import lossless in the direction that matters: a card that came
 * from someone's Outlook keeps its `X-MS-CARDPICTURE` through an edit-and-export cycle instead of
 * quietly shedding it.
 */
export type JCardProp = readonly [
  name: string,
  params: Readonly<Record<string, unknown>>,
  valueType: string,
  ...values: unknown[],
]

/** RFC 9553 §2. Only the properties this package converts are typed; the rest travel in `vCardProps`. */
export interface Card {
  readonly '@type': 'Card'
  readonly version: '1.0'
  readonly uid: string
  readonly kind?: 'individual' | 'group' | 'org' | 'location' | 'device' | 'application'
  readonly created?: string
  readonly updated?: string
  readonly name?: Name
  readonly nicknames?: Readonly<Record<Id, Nickname>>
  readonly emails?: Readonly<Record<Id, EmailAddress>>
  readonly phones?: Readonly<Record<Id, Phone>>
  readonly addresses?: Readonly<Record<Id, Address>>
  readonly organizations?: Readonly<Record<Id, Organization>>
  readonly titles?: Readonly<Record<Id, Title>>
  readonly anniversaries?: Readonly<Record<Id, Anniversary>>
  readonly notes?: Readonly<Record<Id, Note>>
  readonly media?: Readonly<Record<Id, Media>>
  readonly links?: Readonly<Record<Id, Link>>
  readonly keywords?: BooleanSet
  /** Group membership (`kind: 'group'`): a set of member UIDs. */
  readonly members?: BooleanSet
  /** RFC 9555 §2.15.2 — vCard properties with no JSContact equivalent, kept verbatim. */
  readonly vCardProps?: readonly JCardProp[]
}
