/**
 * Contacts autocomplete source (M4.3, FR-CON-03): the composer's second recipient-suggestion source
 * next to the recents one ({@link createRecentsSuggestionSource}). It implements the SAME
 * {@link RecipientSuggestionSource} seam, so {@link combineSuggestionSources} merges the two without
 * the field knowing there is more than one.
 *
 * It reads ONLY pure contact helpers ({@link contactMatches}, {@link preferred}, … from
 * `../contacts/contact-fields`) and never a contacts React component — importing a component here would
 * drag the lazy `ContactsPage` chunk into the eager composer chunk and blow the recipient-chunk budget.
 *
 * Ranking WITHIN the contacts is a join against the recents' `addressStats`: a contact whose address is
 * a frequent correspondent ranks by {@link scoreAddressStat} (usage), and the rest fall back to
 * alphabetical {@link contactSortKey}. Contacts carry no usage counter of their own — the signal lives
 * in `addressStats`, keyed by the address. The db handle is optional: without it the source ranks
 * purely alphabetically (used by the pure unit tests), which keeps it a no-crash source.
 */

import type { ContactCardMedia, Id } from '@waxwing/jmap'
import {
  contactDisplayName,
  contactMatches,
  contactPhoto,
  contactSortKey,
  groupMemberUids,
  groupName,
  isGroupCard,
  preferred,
} from '../contacts/contact-fields'
// Deliberately the MODULE, not the `../contacts` barrel: the barrel re-exports the group mapping,
// which reaches `contact-card-mapping` (~25 KB) at runtime. `expand-group` itself imports nothing
// but `contact-fields`, whose own imports are type-only.
import { expandGroupMembers, indexCardsByUid } from '../contacts/expand-group'
import type { AddressStatRow, ContactCardRow, ReplicaDb } from '../sync'
import {
  type GroupSuggestion,
  type RecipientSuggestion,
  type RecipientSuggestionSource,
  scoreAddressStat,
} from './recipient-suggestions'

export interface ContactSuggestionOptions {
  /** Replica handle for the usage join — rank a contact's address by its {@link AddressStatRow}. */
  readonly db?: ReplicaDb
  readonly accountId?: Id
  /** Injectable clock for the recency half-life (tests pin it). Defaults to {@link Date.now}. */
  readonly now?: () => number
}

interface Candidate {
  readonly card: ContactCardRow
  readonly email: string
  readonly emailLower: string
  readonly media: ContactCardMedia | undefined
}

/**
 * The address to SHOW for a matched card: the address the needle actually matched (so typing toward a
 * secondary address surfaces that one), else the card's preferred/primary address. `undefined` when
 * the card carries no email at all — such a card can never become a recipient, so it is dropped.
 */
function pickAddress(card: ContactCardRow, needleLower: string): string | undefined {
  const emails = preferred(card.emails)
  if (emails.length === 0) return undefined
  if (needleLower !== '') {
    const matching = emails.find((entry) => entry.address.toLowerCase().includes(needleLower))
    if (matching !== undefined) return matching.address
  }
  return emails[0]?.address
}

/**
 * The account's contact GROUPS that match the needle, each already expanded to its members'
 * addresses (A-4 of the JMAP gap analysis).
 *
 * A group is not itself a sendable address, which is why it used to be skipped here entirely — and
 * that left the one thing a distribution list is FOR without a way to use it. It is offered as its
 * own kind of option instead: {@link expandGroupMembers} resolves each member `uid` against the same
 * card list, and committing the option commits those addresses. A group whose members resolve to no
 * address at all is dropped rather than offered as a pill that would add nothing.
 *
 * Matching is on the group's NAME only. `contactMatches` would also search the member cards' fields
 * through the group card, which is not what it holds — a group card carries `members`, not emails —
 * so the name is the whole of what a reader can be typing toward.
 */
function matchingGroups(cards: readonly ContactCardRow[], needleLower: string): GroupSuggestion[] {
  const groups = cards.filter((card) => isGroupCard(card) && card.uid !== '')
  if (groups.length === 0) return []
  const byUid = indexCardsByUid(cards)
  const out: GroupSuggestion[] = []
  for (const group of groups) {
    const name = groupName(group)
    if (name === '' || !name.toLowerCase().includes(needleLower)) continue
    const members = expandGroupMembers(groupMemberUids(group), (uid) => byUid.get(uid))
    if (members.length === 0) continue
    out.push({ kind: 'group', uid: group.uid, name, members })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * A contacts recipient-suggestion source over `cards` (the account's contact cards; may be `undefined`
 * while the live query resolves — treated as empty, never a crash). Each matched person yields
 * EXACTLY ONE suggestion (its chosen address), deduped so two cards sharing an address collapse to
 * one; each matched GROUP yields one option that expands to its members on commit.
 *
 * Groups are listed FIRST. There are few of them, they are named deliberately, and a reader who has
 * typed enough of a list's name to match it is not looking for the person two rows down — while a
 * group ranked by the usage join would lose to any frequent correspondent and fall off a six-row
 * listbox exactly when it was wanted.
 */
export function createContactSuggestionSource(
  cards: readonly ContactCardRow[] | undefined,
  opts: ContactSuggestionOptions = {},
): RecipientSuggestionSource {
  const list = cards ?? []
  return {
    async query(prefix, limit) {
      if (list.length === 0 || limit <= 0) return []
      const needleLower = prefix.trim().toLowerCase()

      const groups = matchingGroups(list, needleLower).slice(0, limit)

      const candidates: Candidate[] = []
      const seen = new Set<string>()
      for (const card of list) {
        if (isGroupCard(card)) continue
        if (!contactMatches(card, needleLower)) continue
        const email = pickAddress(card, needleLower)
        if (email === undefined) continue
        const emailLower = email.toLowerCase()
        if (seen.has(emailLower)) continue // one suggestion per address
        seen.add(emailLower)
        candidates.push({ card, email, emailLower, media: contactPhoto(card) })
      }
      if (candidates.length === 0) return groups

      // Usage join: rank by the recents' addressStats when a replica is available, else pure alpha.
      const scoreByEmail = await usageScores(candidates, opts)
      const ranked = [...candidates].sort((a, b) => {
        const delta = (scoreByEmail.get(b.emailLower) ?? 0) - (scoreByEmail.get(a.emailLower) ?? 0)
        if (delta !== 0) return delta
        return contactSortKey(a.card).localeCompare(contactSortKey(b.card))
      })

      const people = ranked.slice(0, Math.max(0, limit - groups.length)).map((candidate) => {
        const name = contactDisplayName(candidate.card) || null
        return {
          name,
          email: candidate.email,
          ...(candidate.media !== undefined ? { photo: candidate.media } : {}),
        } satisfies RecipientSuggestion
      })
      return [...groups, ...people]
    },
  }
}

/** Look up each candidate address' usage score from `addressStats`; empty map without a replica. */
async function usageScores(
  candidates: readonly Candidate[],
  opts: ContactSuggestionOptions,
): Promise<Map<string, number>> {
  const { db, accountId, now } = opts
  const scores = new Map<string, number>()
  if (db === undefined || accountId === undefined) return scores
  const rows = await db.addressStats.bulkGet(
    candidates.map((candidate): [Id, string] => [accountId, candidate.emailLower]),
  )
  const at = (now ?? Date.now)()
  rows.forEach((row: AddressStatRow | undefined, index) => {
    if (row !== undefined) {
      const candidate = candidates[index]
      if (candidate !== undefined) scores.set(candidate.emailLower, scoreAddressStat(row, at))
    }
  })
  return scores
}
