/**
 * Contact import/export IO (M4.3, FR-CON-06) — the pure and async logic behind
 * {@link ./ContactImportExportDialog}. Two formats: vCard 4.0 (RFC 6350) and JSContact JSON
 * (RFC 9553). CSV is deliberately out of scope (spec "Could"/backlog).
 *
 * **The jscontact conversion runtime is reached ONLY through `import('./jscontact-runtime')`** — a
 * dynamic import that keeps it in its own lazy chunk (see that file). Everything here that touches
 * vCard text is therefore `async`; everything that is pure JSContact/JSON manipulation (dedup,
 * export-card sanitising, JSON parsing/validation) stays synchronous and free of that runtime.
 *
 * ## Decisions baked in here
 *
 *  - **Dedup is against the existing cards, primary key = preferred email (case-insensitive),
 *    secondary key = `uid`.** The default is to SKIP a duplicate; the dialog also offers "keep both".
 *    No field-level merge (that risks silent data loss). A card accepted for creation is folded back
 *    into the seen sets, so a file that repeats a contact twice is deduped against itself too.
 *  - **`uid` is passed through on import**, not minted afresh: `fromVCard` always supplies one (the
 *    vCard's own `UID`, or a generated `urn:uuid`), and a JSON card keeps its `uid`. The server
 *    assigns the real JMAP `id` on create and MAY reassign the `uid`; passing the source `uid`
 *    through costs nothing and lets a re-import of THIS server's own export dedup by `uid`.
 *  - **Photo seam.** A photo stored inline as a `data:` URI round-trips (import keeps it, export
 *    embeds it). A photo the server externalised as a `blobId` (no inline `uri`) is NOT embedded on
 *    export — fetching the blob is out of scope for this etape — so such media entries are dropped
 *    from the exported card rather than emitted as a broken/`blobId`-bearing property.
 *
 * ## Why not `ContactCard/parse` (JMAP gap analysis, A-2 — checked, not built)
 *
 * The server can do this: Stalwart advertises `urn:ietf:params:jmap:contacts:parse` and
 * `ContactCard/parse` turns an uploaded vCard blob into JSContact. It was measured against v0.16.18
 * on 2026-08-21, side by side with `fromVCard`, on one vCard **3.0** card (the legacy dialect an
 * Outlook or Google export produces, and the case a server fallback would exist for). The server's
 * answer is not better — it is worse in three specific ways:
 *
 *  - `EMAIL;TYPE=INTERNET,PREF` came back as `contexts: {internet: true, pref: true}`. Neither is a
 *    JSContact context; `pref` is a separate integer property (RFC 9553 §1.5.3). `fromVCard`
 *    returns `{address, pref: 1}`.
 *  - Unmapped properties came back under a key called `vCard`. RFC 9555 §2.15.2 names it
 *    `vCardProps`, which is what `fromVCard` writes and what the round-trip back out depends on.
 *  - The parsed card carried **no `uid` at all**. RFC 9555 §2.1.1 requires one to be generated when
 *    the vCard has none; `fromVCard` does, and the import dedup above is built on it.
 *
 * There is also nothing to fall back FROM. `fromVCard` never throws and never drops a line in
 * silence: an unparsable line lands in `skipped` and is shown, and a property with no JSContact home
 * survives in `vCardProps`. So a fallback would trade an offline, better-conforming parser for an
 * upload plus a round trip that only works online — and pay for it in bytes. Not built; this note is
 * the result. Revisit if a real-world vCard is ever found that `fromVCard` mangles and the server
 * gets right.
 */

import type { ContactCard, ContactCardMedia, Id } from '@waxwing/jmap'
import type { Card, Media } from '@waxwing/jscontact'
import { type CardLike, preferred } from './contact-fields'

/** The two interchange formats this etape supports. CSV is out of scope (spec backlog). */
export type ContactFormat = 'vcard' | 'jscontact'

/**
 * A soft ceiling on one import: each card becomes one Outbox intent, so a runaway file would flood
 * the outbox. Past this the dialog imports the first {@link MAX_IMPORT_CARDS} and says so — a visible
 * cap, never a silent truncation.
 */
export const MAX_IMPORT_CARDS = 1000

/** Thrown by {@link parseImport} when the input cannot be read at all (e.g. malformed JSON). */
export class ContactImportError extends Error {
  constructor(readonly reason: 'invalid-json') {
    super(reason)
    this.name = 'ContactImportError'
  }
}

export interface ParsedImport {
  /** The cards the file yielded, ready for {@link dedupeAgainst}. */
  readonly cards: readonly Card[]
  /**
   * How many source lines (vCard) / array entries (JSON) could not be parsed. Surfaced in the
   * dialog's summary — never hidden: a partial import must say what it skipped.
   */
  readonly skipped: number
}

export interface DedupeResult {
  /** Cards with no existing match — created unconditionally. */
  readonly toCreate: readonly Card[]
  /** Cards that match an existing contact — skipped by default, or created on "keep both". */
  readonly duplicates: readonly Card[]
}

/** Options for {@link parseImport}. `newUid` is injected in tests for deterministic ids. */
export interface ParseOptions {
  readonly newUid?: () => string
}

// ── Import ────────────────────────────────────────────────────────────────────────────────────

/**
 * Parse an import file into JSContact cards. vCard goes through `fromVCard` (which never throws and
 * reports unparsable lines); JSON is parsed and validated here. Throws {@link ContactImportError}
 * only when the whole document is unreadable (malformed JSON) — a vCard with some bad lines still
 * yields its good cards.
 */
export async function parseImport(
  text: string,
  format: ContactFormat,
  options: ParseOptions = {},
): Promise<ParsedImport> {
  if (format === 'vcard') {
    const { fromVCard } = await import('./jscontact-runtime')
    const result = fromVCard(text, options.newUid !== undefined ? { newUid: options.newUid } : {})
    return { cards: result.cards, skipped: result.skipped.length }
  }
  return parseJsonImport(text, options.newUid)
}

/** Hints that a plain object is meant to be a JSContact card (beyond an explicit `@type`). */
const CARD_HINT_KEYS = [
  'uid',
  'name',
  'emails',
  'phones',
  'addresses',
  'organizations',
  'nicknames',
]

function generateUid(newUid: (() => string) | undefined): string {
  if (newUid !== undefined) return newUid()
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (typeof cryptoObj?.randomUUID === 'function') return `urn:uuid:${cryptoObj.randomUUID()}`
  return `urn:uuid:${Math.random().toString(16).slice(2)}-${String(Date.now())}`
}

/**
 * Keys an imported file may never set on a card.
 *
 * The first four are this account's identity, not the file's: `id` and `addressBookIds` are
 * overwritten by {@link toContactCard} anyway, but `accountId` and `abk` are replica columns that
 * would travel into the store and then into `Card.*` unnoticed. `__proto__` is the one that is not
 * cosmetic — the copy below assigns per key, and `out['__proto__'] = …` REPLACES the object's
 * prototype rather than adding a property, so a JSON file could hand every later `card.foo` lookup
 * to attacker-chosen values. (`{ ...record }` would not have, which is exactly why the loop is the
 * riskier form and needs the guard.)
 */
const REJECT_ON_IMPORT = new Set(['id', 'addressBookIds', 'accountId', 'abk', '__proto__'])

function coerceJsonCard(value: unknown, newUid: (() => string) | undefined): Card | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const looksLikeCard = record['@type'] === 'Card' || CARD_HINT_KEYS.some((key) => key in record)
  if (!looksLikeCard) return undefined
  const rawUid = record.uid
  const uid = typeof rawUid === 'string' && rawUid.trim() !== '' ? rawUid : generateUid(newUid)
  // Force the JSContact envelope so the result is a valid Card even from a hand-written file.
  //
  // **Everything else rides along unvalidated, and that is a deliberate trade, not an oversight**:
  // JSContact allows vendor extension properties and this client is not the authority on them, so an
  // allow-list would silently amputate a card on every import. What the file does NOT get is
  // {@link REJECT_ON_IMPORT}. The remaining defence is at the seams — a hostile string cannot forge
  // a second card on export (the jscontact writer strips line-breaking characters from every
  // rendered line), and HTML/URI values are sanitised where they are rendered, not here.
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(record)) {
    if (REJECT_ON_IMPORT.has(key)) continue
    out[key] = entry
  }
  out['@type'] = 'Card'
  out.version = '1.0'
  out.uid = uid
  return out as unknown as Card
}

function parseJsonImport(text: string, newUid: (() => string) | undefined): ParsedImport {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new ContactImportError('invalid-json')
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed]
  const cards: Card[] = []
  let skipped = 0
  for (const entry of entries) {
    const card = coerceJsonCard(entry, newUid)
    if (card === undefined) skipped += 1
    else cards.push(card)
  }
  return { cards, skipped }
}

// ── Dedup ─────────────────────────────────────────────────────────────────────────────────────

function normalizedEmail(address: string): string {
  return address.trim().toLowerCase()
}

function primaryEmail(card: CardLike): string | undefined {
  const first = preferred(card.emails)[0]
  if (first === undefined) return undefined
  const value = normalizedEmail(first.address)
  return value === '' ? undefined : value
}

function allEmails(card: CardLike): string[] {
  return preferred(card.emails)
    .map((entry) => normalizedEmail(entry.address))
    .filter((value) => value !== '')
}

/**
 * Split freshly parsed cards into `toCreate` (no existing match) and `duplicates`. Primary key is the
 * incoming card's preferred email checked against ALL emails of the existing cards (case-insensitive);
 * secondary key is `uid`. An accepted card is folded into the seen sets so the batch is deduped
 * against itself as well as against the account.
 */
export function dedupeAgainst(cards: readonly Card[], existing: readonly CardLike[]): DedupeResult {
  const seenEmails = new Set<string>()
  const seenUids = new Set<string>()
  for (const card of existing) {
    for (const address of allEmails(card)) seenEmails.add(address)
    if (card.uid !== undefined && card.uid !== '') seenUids.add(card.uid)
  }

  const toCreate: Card[] = []
  const duplicates: Card[] = []
  for (const card of cards) {
    const email = primaryEmail(card)
    const uid = card.uid
    const isDuplicate =
      (email !== undefined && seenEmails.has(email)) ||
      (uid !== undefined && uid !== '' && seenUids.has(uid))
    if (isDuplicate) {
      duplicates.push(card)
      continue
    }
    toCreate.push(card)
    if (email !== undefined) seenEmails.add(email)
    if (uid !== undefined && uid !== '') seenUids.add(uid)
  }
  return { toCreate, duplicates }
}

// ── To a creatable card ─────────────────────────────────────────────────────────────────────

/**
 * Turn a parsed JSContact card into a {@link ContactCard} ready for `create`, in the target book. The
 * `id` is a placeholder (`enqueueCreateContactCard` overwrites it with the server creationId); the
 * `uid` is the source card's own (see the file header).
 */
export function toContactCard(card: Card, targetBookId: Id): ContactCard {
  return {
    ...card,
    '@type': 'Card',
    version: '1.0',
    id: card.uid,
    addressBookIds: { [targetBookId]: true },
  }
}

// ── Export ────────────────────────────────────────────────────────────────────────────────────

/** JMAP/replica-only properties that must not leak into a portable JSContact/vCard export. */
const OMIT_ON_EXPORT = new Set(['id', 'addressBookIds', 'accountId', 'abk', 'media'])

function sanitizeExportMedia(
  media: Readonly<Record<Id, ContactCardMedia>> | undefined,
): Record<Id, Media> | undefined {
  if (media === undefined) return undefined
  const out: Record<Id, Media> = {}
  for (const [key, item] of Object.entries(media)) {
    // Photo seam: a blobId-only photo (server-externalised, no inline uri) is NOT embedded on export.
    if (item.uri === undefined) continue
    const cleaned = { ...item } as Record<string, unknown>
    delete cleaned.blobId
    out[key] = cleaned as unknown as Media
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** Strip the JMAP object layer and blobId media, leaving a clean JSContact {@link Card}. */
function toExportCard(card: ContactCard): Card {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(card)) {
    if (!OMIT_ON_EXPORT.has(key)) out[key] = value
  }
  out['@type'] = 'Card'
  out.version = '1.0'
  const media = sanitizeExportMedia((card as { media?: Record<Id, ContactCardMedia> }).media)
  if (media !== undefined) out.media = media
  return out as unknown as Card
}

/**
 * Serialise cards for download in the chosen format. vCard uses `toVCards` (from the lazy runtime);
 * JSON is a plain array of JSContact cards. Both first strip the JMAP layer via {@link toExportCard}.
 */
export async function serializeExport(
  cards: readonly ContactCard[],
  format: ContactFormat,
): Promise<string> {
  const exportCards = cards.map(toExportCard)
  if (format === 'vcard') {
    const { toVCards } = await import('./jscontact-runtime')
    return toVCards(exportCards)
  }
  return `${JSON.stringify(exportCards, null, 2)}\n`
}

/** The MIME type for a download blob of the given format. */
export function exportMimeType(format: ContactFormat): string {
  return format === 'vcard' ? 'text/vcard;charset=utf-8' : 'application/json;charset=utf-8'
}

const MAX_FILENAME_STEM = 100

/**
 * A safe download filename for the given stem and format. The stem may be a contact's display name
 * (user data), so it is stripped of control/bidi/path characters the same way the .eml saver is
 * ({@link ../mail/use-message-source}), falling back to `contacts` when it sanitises to nothing.
 */
export function exportFilename(stem: string, format: ContactFormat): string {
  const extension = format === 'vcard' ? 'vcf' : 'json'
  const cleaned = stem
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
    .replace(/[/\\:*?"<>|]/g, '')
    .replace(/\.{2,}/g, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, MAX_FILENAME_STEM)
    .replace(/[.\s]+$/, '')
  return `${cleaned === '' ? 'contacts' : cleaned}.${extension}`
}
