/**
 * The account's contact cards, plus pure selectors for the group feature (M4.2, stage 6a). A group is
 * a {@link ContactCardRow} with `kind: 'group'`, so it lives in the SAME `contactCards` store the
 * individual list reads — one live query feeds three consumers: the rail's group list, the group
 * editor's member picker (candidates) and the local member/uid resolution ({@link ./expand-group}).
 * A group's members can reference cards in any book, so the query is account-wide, not book-scoped.
 *
 * That query is `useContactCards` (`sync/react.tsx`), the app's ONE shared `contactCards`
 * subscription (R-21) — it used to be opened here, and once more by every other consumer.
 */

import type { ContactCardRow } from '../sync'
// `contact-fields`, not `contact-group-mapping`: these selectors are reached EAGERLY from the mail
// reading pane (`SenderCard`), and the group mapping imports `contact-card-mapping` (~25 KB) at
// runtime for its `deepEqual` — which put the whole contact-editor mapping in the initial chunk.
import { isGroupCard, sortByDisplayName } from './contact-fields'

/** The groups for the rail: `kind: 'group'` cards in `bookId` (or all books), display-name ordered. */
export function selectGroups(
  cards: readonly ContactCardRow[],
  bookId: string | undefined,
): ContactCardRow[] {
  return sortByDisplayName(
    cards.filter(
      (card) => isGroupCard(card) && (bookId === undefined || card.addressBookIds[bookId] === true),
    ),
  )
}

/** The member-picker candidates: every NON-group card, display-name ordered. */
export function selectMemberCandidates(cards: readonly ContactCardRow[]): ContactCardRow[] {
  return sortByDisplayName(cards.filter((card) => !isGroupCard(card)))
}

/** Resolve a group's member uids to their cards, dropping any uid the replica cannot resolve. */
export function resolveMembers(
  memberUids: readonly string[],
  byUid: ReadonlyMap<string, ContactCardRow>,
): ContactCardRow[] {
  const out: ContactCardRow[] = []
  for (const uid of memberUids) {
    const card = byUid.get(uid)
    if (card !== undefined) out.push(card)
  }
  return out
}
