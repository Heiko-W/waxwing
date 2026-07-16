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
