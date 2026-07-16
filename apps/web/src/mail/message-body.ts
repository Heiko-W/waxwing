/**
 * Pure helpers for the reading experience (M1.8). Turn a stored {@link EmailBodyRow} into the
 * strings the renderer needs and enumerate its inline (`cid:`) parts, applying the SP.4 rules:
 * "has HTML" is decided from a genuine `text/html` part (a text-only mail lists its text/plain part
 * in BOTH textBody and htmlBody), and `bodyValues` is keyed by `partId`.
 */

import type { EmailAddress, EmailBodyPart } from '@waxwing/jmap'
import type { EmailBodyRow } from '../sync'

export interface BodyText {
  readonly partId: string
  readonly value: string
}

/** The genuine `text/html` body parts (decoded), or `null` when the message has no real HTML. */
export function pickHtmlBody(body: EmailBodyRow): BodyText[] | null {
  const parts = body.htmlBody.filter(
    (part): part is EmailBodyPart & { partId: string } =>
      part.partId !== null && part.type === 'text/html',
  )
  if (parts.length === 0) return null
  return parts.map((part) => ({
    partId: part.partId,
    value: body.bodyValues[part.partId]?.value ?? '',
  }))
}

/** The concatenated decoded `text/plain` body. */
export function pickTextBody(body: EmailBodyRow): string {
  return body.textBody
    .filter(
      (part): part is EmailBodyPart & { partId: string } =>
        part.partId !== null && part.type === 'text/plain',
    )
    .map((part) => body.bodyValues[part.partId]?.value ?? '')
    .join('\n')
}

export interface CidPart {
  readonly cid: string
  readonly blobId: string
  readonly type: string
  readonly name: string | null
}

/** Every inline part with a `cid` AND a `blobId`, walking the structure/htmlBody/attachments. */
export function collectCidParts(body: EmailBodyRow): CidPart[] {
  const out: CidPart[] = []
  const seen = new Set<string>()
  const visit = (part: EmailBodyPart | undefined): void => {
    if (!part) return
    if (part.cid !== null && part.blobId !== null && !seen.has(part.cid)) {
      seen.add(part.cid)
      out.push({
        cid: part.cid,
        blobId: part.blobId,
        type: part.type,
        name: part.name,
      })
    }
    for (const sub of part.subParts ?? []) visit(sub)
  }
  visit(body.bodyStructure)
  for (const part of body.htmlBody) visit(part)
  for (const part of body.attachments) visit(part)
  return out
}

/** Format an address list as `Name <email>` (or the fallback when empty). */
export function formatAddressList(addresses: EmailAddress[] | null, noneLabel: string): string {
  if (addresses === null || addresses.length === 0) return noneLabel
  return addresses
    .map((address) =>
      address.name !== null && address.name !== ''
        ? `${address.name} <${address.email}>`
        : address.email,
    )
    .join(', ')
}

/** The best single display name for the sender (name, else email, else fallback). */
export function senderName(from: EmailAddress[] | null, noneLabel: string): string {
  const first = from?.[0]
  if (!first) return noneLabel
  return first.name !== null && first.name !== '' ? first.name : first.email
}

/** The sender's raw address (for the per-sender remote-content allowlist), or null. */
export function senderAddress(from: EmailAddress[] | null): string | null {
  return from?.[0]?.email ?? null
}

/**
 * A display name shaped like an email address — one that is NOT the sender's actual address
 * (M3.9, FR-RD-08).
 *
 * `From: "security@bank.test" <attacker@evil.tld>` is the oldest trick in the file, and it works
 * because every mail client shows the display name and most hide the address. Waxwing shows the real
 * address next to the name always, which already defuses it — but a dimmed address is easy to skim
 * past when the thing beside it *also* looks like an address. So this one shape gets a marker of its
 * own: the name is not merely different from the address, it is impersonating one.
 *
 * ## The address is a WORD in the name, not the whole name
 * Requiring the entire display name to be an address missed the shape that actually gets sent:
 * `From: "Bank Support <security@bank.test>" <attacker@evil.tld>`. That is not a lesser version of
 * the bare trick, it is a better one — the label supplies the plausibility and the brackets supply
 * the authority, and it read as an ordinary display name to a whole-string test. So the name is
 * split into words and any address-shaped word is the claim.
 *
 * ## Compared by DOMAIN, because the domain is who the sender is
 * `"noreply@example.com" <no-reply@example.com>` is one organisation with two spellings of its own
 * robot, and comparing addresses whole made it a warning. Nothing is impersonated there. The marker
 * exists for a name that claims a DIFFERENT party than the address delivers, so a differing local
 * part at the same domain (or under it — `alice@mail.bank.test` named beside `noreply@bank.test`) is
 * silence. The cost: an address in the name that is genuinely at another domain always marks, even
 * where a ticketing system put it there honestly. That is the right side to err on — the marker says
 * "this name names someone else", which in that case is true.
 *
 * Deliberately strict about what "looks like an address" means. No dotted domain, or a space where an
 * address cannot have one, and it is a name — the marker is worth nothing if it fires on
 * "Alice (Support)". Same PSL-free limit as `@waxwing/mail-html`'s link check: a claimed `x@co.uk`
 * would count `y@evil.co.uk` as the same party.
 */
const ADDRESS_SHAPED = /^([^\s@]+)@([^\s@.]+\.[^\s@]+)$/
/** Surrounding punctuation on a word — the `<`/`>` of the bracketed form above, above all. */
const WORD_TRIM = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu

/** The domain of the first address-shaped word in a display name, lowercased, or `null`. */
function claimedDomain(name: string): string | null {
  for (const word of name.split(/\s+/)) {
    const match = ADDRESS_SHAPED.exec(word.replace(WORD_TRIM, ''))
    if (match?.[2] !== undefined) return match[2].toLowerCase()
  }
  return null
}

/** The same party: the claimed domain IS the real one, or one sits under the other. */
function sameParty(claimed: string, real: string): boolean {
  return claimed === real || claimed.endsWith(`.${real}`) || real.endsWith(`.${claimed}`)
}

export function nameLooksLikeAddress(from: EmailAddress[] | null): boolean {
  const first = from?.[0]
  const name = first?.name
  const email = first?.email
  // Same defensive posture as `addressSet` below: this runs during RENDER on server data.
  if (typeof name !== 'string' || typeof email !== 'string') return false
  const claimed = claimedDomain(name)
  if (claimed === null) return false
  const real = ADDRESS_SHAPED.exec(email.trim())?.[2]?.toLowerCase()
  // An unparseable real address cannot clear the claim: the name names a party, and we cannot show
  // it is the sender's own.
  if (real === undefined) return true
  return !sameParty(claimed, real)
}

/**
 * Whether two address lists name the same mailboxes — order- and display-name-insensitive (M3.9).
 * The header details use it to decide whether a `Reply-To`/`Sender` is worth showing at all: one that
 * merely repeats `From` (the overwhelmingly common case) is noise, not information.
 *
 * Addresses are compared case-insensitively in full. The local part is technically case-sensitive
 * (RFC 5321 §2.3.11), but this is a "would the reader notice a difference?" test, not routing.
 */
export function sameAddresses(a: EmailAddress[] | null, b: EmailAddress[] | null): boolean {
  const left = addressSet(a)
  const right = addressSet(b)
  if (left.size !== right.size) return false
  for (const address of left) if (!right.has(address)) return false
  return true
}

/**
 * Defensive on purpose: `EmailAddress.email` is non-nullable per RFC 8621, but this runs during
 * RENDER on server data, and `db.ts`'s byte estimator already treats the very same rows as possibly
 * malformed (`address?.email?.length ?? 0`, "a throw costs the whole app"). A `TypeError` here would
 * take the entire mail screen down to the error boundary over one bad address. Every sibling helper
 * (`senderAddress`, `formatAddressList`) is already guarded; this was the only bare method call.
 */
function addressSet(list: EmailAddress[] | null): Set<string> {
  const out = new Set<string>()
  for (const address of list ?? []) {
    const email = address?.email
    if (typeof email === 'string') out.add(email.toLowerCase())
  }
  return out
}
