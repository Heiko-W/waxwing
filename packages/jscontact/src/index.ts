/**
 * `@waxwing/jscontact` — JSContact (RFC 9553) ⇄ vCard 4.0 (RFC 6350) conversion (MIT).
 *
 * The mapping is RFC 9555's, not one of our own: both directions follow it, and where this package
 * deviates the reason is written at the deviation. What it maps and what it does not is in
 * README.md as an explicit matrix — a list that is checked by a test rather than maintained by
 * hope, so a property that starts or stops being supported cannot leave the document behind.
 *
 * **Unmapped vCard properties are not lost.** They ride in `Card.vCardProps` as jCard-encoded
 * values (RFC 9555 §2.15.2) and are written back out on export, so a card imported from Apple
 * Contacts or Outlook keeps the vendor properties this package has never heard of.
 *
 * Zero dependencies, no DOM, no Node built-ins: it runs in the browser (client-side import/export,
 * FR-CON-06) and in a test runner unchanged.
 */

export { fromVCard, type ImportOptions, type ImportResult, parseVCardDate } from './from-vcard'
export { formatVCardDate, toVCard, toVCards } from './to-vcard'
export type {
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
  OnlineService,
  Organization,
  OrgUnit,
  PartialDate,
  Phone,
  PhoneFeature,
  Pref,
  Timestamp,
  Title,
} from './types'
export type { ContentLine, ParseResult, SkippedLine } from './vcard/lex'
export { parseContentLines } from './vcard/lex'
