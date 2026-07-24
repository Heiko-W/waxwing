/**
 * Recipient-expansion seam (M4.2, stage 6a) — the pure boundary the composer will call in M4.3 to
 * turn a contact GROUP into the recipient pills its members resolve to. A group's `members` set holds
 * JSContact **`uid`**s (RFC 9553 §2.1.6), NOT JMAP `id`s, so expansion resolves each uid against the
 * replica's cards and takes that card's preferred email.
 *
 * The result is `EmailAddress[]` in the JMAP mail shape (`{ name, email }`) — DELIBERATELY the exact
 * element type {@link import('../compose').RecipientSuggestionSource} already yields, so M4.3 can feed
 * an expanded group straight into the recipient field (and merge a contacts suggestion source) without
 * a conversion layer. M4.2 ships only this seam; it does not touch the composer.
 *
 * The core ({@link expandGroupMembers}) is pure and resolver-injected, so a unit test pins "preferred
 * email per member", "member without an email skipped" and "unknown uid ignored" with hand-built
 * cards and no replica. {@link expandGroup} is the thin replica-backed wrapper the app wires up.
 */

import type { EmailAddress, Id } from '@waxwing/jmap'
import type { ReplicaDb } from '../sync'
import { type CardLike, contactDisplayName, preferred } from './contact-fields'
import { groupMemberUids } from './contact-group-mapping'

/** A card's preferred email address (RFC 9553 §1.4.5 order), trimmed, or `undefined` when it has none. */
function preferredEmail(card: CardLike): string | undefined {
  const address = preferred(card.emails)[0]?.address?.trim()
  return address === undefined || address === '' ? undefined : address
}

/**
 * Resolve a group's member uids to one {@link EmailAddress} each (JMAP shape). For every member uid:
 * look up its card via `resolve`, take its preferred email, and emit `{ name, email }` with the card's
 * display name (or `null` when it has none). Members whose uid does not resolve, or whose card has no
 * email, are skipped; duplicate emails (case-insensitive) are collapsed so a person in a group twice —
 * or two cards sharing an address — yields one pill.
 */
export function expandGroupMembers(
  memberUids: readonly string[],
  resolve: (uid: string) => CardLike | undefined,
): EmailAddress[] {
  const out: EmailAddress[] = []
  const seen = new Set<string>()
  for (const uid of memberUids) {
    const card = resolve(uid)
    if (card === undefined) continue
    const email = preferredEmail(card)
    if (email === undefined) continue
    const key = email.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    // A card whose only identity is its email address ({@link contactDisplayName} falls back to it)
    // has no real name — emit `null` rather than a pill whose name repeats its address.
    const display = contactDisplayName(card).trim()
    const name = display === '' || display.toLowerCase() === key ? null : display
    out.push({ name, email })
  }
  return out
}

/** Index a card list by its JSContact `uid` (last write wins on a duplicate uid). */
export function indexCardsByUid<T extends CardLike>(cards: readonly T[]): Map<string, T> {
  const index = new Map<string, T>()
  for (const card of cards) {
    if (card.uid !== undefined && card.uid !== '') index.set(card.uid, card)
  }
  return index
}

/**
 * Replica-backed expansion (the seam M4.3 consumes): resolve the group with this `uid` to its members'
 * preferred emails. Reads the account's cards once, indexes them by uid, and delegates to the pure
 * {@link expandGroupMembers}. Returns `[]` for an unknown group uid or a group with no resolvable
 * members. The `uid` argument is the group card's JSContact `uid`, never its JMAP `id`.
 */
export async function expandGroup(
  db: ReplicaDb,
  accountId: Id,
  groupUid: string,
): Promise<EmailAddress[]> {
  const cards = await db.contactCards.where('accountId').equals(accountId).toArray()
  const index = indexCardsByUid(cards)
  const group = index.get(groupUid)
  if (group === undefined) return []
  return expandGroupMembers(groupMemberUids(group), (uid) => index.get(uid))
}
