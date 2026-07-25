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
  preferred,
} from '../contacts/contact-fields'
import type { AddressStatRow, ContactCardRow, ReplicaDb } from '../sync'
import {
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
 * A contacts recipient-suggestion source over `cards` (the account's contact cards; may be `undefined`
 * while the live query resolves — treated as empty, never a crash). Groups (`kind: 'group'`) are
 * excluded: a group is not itself a sendable address. Each matched card yields EXACTLY ONE suggestion
 * (its chosen address), deduped so two cards sharing an address collapse to one.
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

      const candidates: Candidate[] = []
      const seen = new Set<string>()
      for (const card of list) {
        // A group is not a sendable address (RFC 9553 §2.1.4 — this is `isGroupCard`, inlined). We do
        // NOT import it from `../contacts`: that barrel re-exports the group-mapping module, which
        // would drag `contact-card-mapping` (~25 KB) into the composer's initial graph. `contact-fields`
        // above is type-only-importing and pure, so it is the one safe contacts module to pull in here.
        if (card.kind === 'group') continue
        if (!contactMatches(card, needleLower)) continue
        const email = pickAddress(card, needleLower)
        if (email === undefined) continue
        const emailLower = email.toLowerCase()
        if (seen.has(emailLower)) continue // one suggestion per address
        seen.add(emailLower)
        candidates.push({ card, email, emailLower, media: contactPhoto(card) })
      }
      if (candidates.length === 0) return []

      // Usage join: rank by the recents' addressStats when a replica is available, else pure alpha.
      const scoreByEmail = await usageScores(candidates, opts)
      const ranked = [...candidates].sort((a, b) => {
        const delta = (scoreByEmail.get(b.emailLower) ?? 0) - (scoreByEmail.get(a.emailLower) ?? 0)
        if (delta !== 0) return delta
        return contactSortKey(a.card).localeCompare(contactSortKey(b.card))
      })

      return ranked.slice(0, limit).map((candidate) => {
        const name = contactDisplayName(candidate.card) || null
        return {
          name,
          email: candidate.email,
          ...(candidate.media !== undefined ? { photo: candidate.media } : {}),
        } satisfies RecipientSuggestion
      })
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
