/**
 * The test corpus (M4.1): vCards in the shapes real exporters actually emit, plus the RFC's own
 * examples. Kept as a module rather than as fixture files so the reason for each one travels with
 * it — a fixture directory turns into a pile of anonymous `.vcf` within a year.
 *
 * **These are transcriptions of real export shapes, not inventions.** Each carries the quirk it was
 * chosen for, and the quirks are what break importers: Apple's `item1.` group prefixes carrying
 * custom labels, Google's vCard 3.0 output with valueless `TYPE` parameters, Outlook's CRLF and
 * `X-MS-` extensions. An importer tested only against its own writer passes forever and fails on
 * the first file a user actually has.
 */

/** RFC 6350 §7.1 — the specification's own worked example. */
export const RFC_6350_EXAMPLE = [
  'BEGIN:VCARD',
  'VERSION:4.0',
  'FN:Simon Perreault',
  'N:Perreault;Simon;;;ing. jr,M.Sc.',
  'BDAY:--0203',
  'ANNIVERSARY:20090808T1430-0500',
  'GENDER:M',
  'LANG;PREF=1:fr',
  'LANG;PREF=2:en',
  'ORG;TYPE=work:Viagenie',
  'ADR;TYPE=work:;Suite D2-630;2875 Laurier;Quebec;QC;G1V 2M2;Canada',
  'TEL;VALUE=uri;TYPE="work,voice";PREF=1:tel:+1-418-656-9254;ext=102',
  'TEL;VALUE=uri;TYPE="work,cell,voice,video,text":tel:+1-418-262-6501',
  'EMAIL;TYPE=work:simon.perreault@viagenie.ca',
  'GEO;TYPE=work:geo:46.772673,-71.282945',
  'KEY;TYPE=work;VALUE=uri:http://www.viagenie.ca/simon.perreault/simon.asc',
  'TZ:-0500',
  'URL;TYPE=home:http://nomis80.org',
  'END:VCARD',
].join('\r\n')

/**
 * Apple Contacts. The `item1.` / `item2.` group prefixes are how it carries the custom labels its
 * UI shows — an `X-ABLabel` line bound to a property by the shared prefix. An importer that drops
 * group prefixes turns "Ferienhaus" into an unlabelled phone number, which is visible data loss.
 */
export const APPLE_EXPORT = [
  'BEGIN:VCARD',
  'VERSION:3.0',
  'PRODID:-//Apple Inc.//macOS 15.0//EN',
  'N:Meier;Anna;Maria;Dr.;',
  'FN:Dr. Anna Maria Meier',
  'ORG:Beckhoff Automation GmbH & Co. KG;Produktmanagement',
  'TITLE:Produktmanagerin',
  'EMAIL;type=INTERNET;type=WORK;type=pref:anna.meier@example.test',
  'EMAIL;type=INTERNET;type=HOME:anna@privat.test',
  'TEL;type=CELL;type=VOICE;type=pref:+49 171 1234567',
  'item1.TEL;type=VOICE:+49 5246 963000',
  'item1.X-ABLabel:Ferienhaus',
  'item2.ADR;type=WORK;type=pref:;;Hülshorstweg 20;Verl;;33415;Deutschland',
  'item2.X-ABADR:de',
  'BDAY;value=date:1982-04-15',
  'NOTE:Kennengelernt auf der SPS 2024.',
  'CATEGORIES:Arbeit,Automatisierung',
  'X-ABUID:ABPerson-1234',
  'UID:apple-anna-meier',
  'REV:2026-07-01T09:12:00Z',
  'END:VCARD',
].join('\r\n')

/**
 * Google Contacts exports vCard 3.0 with valueless `TYPE` shorthand (`TEL;CELL:`) and an `ITEM1.`
 * convention of its own. It also folds aggressively — the photo below is a real fold case.
 */
export const GOOGLE_EXPORT = [
  'BEGIN:VCARD',
  'VERSION:3.0',
  'FN:Björn Øst-Larsen',
  'N:Øst-Larsen;Björn;;;',
  'EMAIL;TYPE=INTERNET;TYPE=HOME:bjorn@example.test',
  'TEL;CELL:+47 900 00 000',
  'TEL;WORK;VOICE:+47 22 00 00 00',
  'ADR;HOME:;;Storgata 1;Oslo;;0155;Norge',
  'ORG:Nordisk Design AS;',
  'NOTE:Snakker norsk\\, svensk og litt tysk.',
  'PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJ',
  ' CQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/',
  'END:VCARD',
].join('\r\n')

/**
 * Outlook / Exchange. Emits vCard 2.1-flavoured 3.0 with `X-MS-` extensions and a `CHARSET`
 * parameter, and writes an empty `ADR` for fields the user left blank — an importer that treats an
 * all-empty structured value as an address ends up creating blank entries on every import.
 */
export const OUTLOOK_EXPORT = [
  'BEGIN:VCARD',
  'VERSION:3.0',
  'N;CHARSET=utf-8:Schmidt;Karl-Heinz;;Herr;',
  'FN;CHARSET=utf-8:Herr Karl-Heinz Schmidt',
  'ORG;CHARSET=utf-8:Muster GmbH;Vertrieb',
  'TITLE;CHARSET=utf-8:Leiter Vertrieb',
  'TEL;WORK;VOICE:+49 30 123456',
  'TEL;WORK;FAX:+49 30 123457',
  'ADR;WORK;PREF:;;Musterstr. 5;Berlin;;10115;Deutschland',
  'ADR;HOME:;;;;;;',
  'EMAIL;PREF;INTERNET:k.schmidt@muster.test',
  'X-MS-OL-DESIGN;CHARSET=utf-8:<card outlineColor="#FFFFFF"/>',
  'X-MS-CARDPICTURE;ENCODING=b:AAAA',
  'REV:20260701T091200Z',
  'END:VCARD',
].join('\r\n')

/**
 * A group card (RFC 6350 §6.1.4). `KIND:group` plus `MEMBER` UIDs — the shape FR-CON-04 needs, and
 * the one an importer written only against individuals silently turns into a contact named "Team".
 */
/**
 * A vCard 4.0 photo as a `data:` URI — the form RFC 9553 stores and the one that breaks a naive
 * writer, because `data:image/png;base64,iVBOR…` contains **both** a semicolon and a comma. A URI
 * value is not text-escaped in vCard 4.0 (§6.2.4 gives it `VALUE=uri`), so escaping it corrupts the
 * payload; and the corruption survives casual testing, because a base64 blob without a comma in it
 * looks fine either way.
 *
 * It also carries explicit, NON-conventional `PROP-ID`s, so honouring them is distinguishable from
 * re-deriving `e1`, `tel1`, … in the same order.
 */
export const DATA_URI_CARD = [
  'BEGIN:VCARD',
  'VERSION:4.0',
  'UID:data-uri-1',
  'FN:Photo Person',
  'PHOTO;PROP-ID=portrait:data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
  'EMAIL;PROP-ID=privat-1:person@example.test',
  'TEL;PROP-ID=handy;TYPE=cell:+49 171 0000000',
  'END:VCARD',
].join('\r\n')

export const GROUP_CARD = [
  'BEGIN:VCARD',
  'VERSION:4.0',
  'KIND:group',
  'FN:Produktteam',
  'UID:urn:uuid:group-1',
  'MEMBER:urn:uuid:member-a',
  'MEMBER:urn:uuid:member-b',
  'END:VCARD',
].join('\r\n')

/**
 * Two cards in one file, which is what every export actually is — and a reminder that `fromVCard`
 * takes a document, not a card.
 */
export const MULTI_CARD = [APPLE_EXPORT, OUTLOOK_EXPORT].join('\r\n')

/** Everything that has to survive escaping: separators, backslashes and newlines in one card. */
export const ESCAPING_TORTURE = [
  'BEGIN:VCARD',
  'VERSION:4.0',
  'UID:torture-1',
  'FN:Meier\\, Anna (Dr.)',
  'N:Meier\\; von;Anna,Maria;;Dr.,Prof.;',
  'NOTE:Zeile 1\\nZeile 2\\; mit Semikolon\\, Komma und C:\\\\pfad',
  'ADR:;;Weg 1\\, Hinterhaus;Verl;;33415;Deutschland',
  'CATEGORIES:a\\,b,c',
  'END:VCARD',
].join('\r\n')

export const ALL_CARDS: readonly { readonly name: string; readonly text: string }[] = [
  { name: 'RFC 6350 example', text: RFC_6350_EXAMPLE },
  { name: 'Apple Contacts', text: APPLE_EXPORT },
  { name: 'Google Contacts', text: GOOGLE_EXPORT },
  { name: 'Outlook', text: OUTLOOK_EXPORT },
  { name: 'data: URI photo', text: DATA_URI_CARD },
  { name: 'group card', text: GROUP_CARD },
  { name: 'escaping torture', text: ESCAPING_TORTURE },
]
