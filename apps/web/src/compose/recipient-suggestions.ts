/**
 * Recipient autocomplete sources (M2.4, FR-CMP-05). A {@link RecipientSuggestionSource} is the seam
 * the pill fields query; M2.4 ships the recents source (the replica's `addressStats`, ranked by
 * frequency × recency). M4.3 adds a contacts source implementing the SAME interface and merges them
 * with {@link combineSuggestionSources}, so the field never changes.
 */

import type { ContactCardMedia, EmailAddress, Id } from '@waxwing/jmap'
import { type AddressStatRow, type ReplicaDb, suggestAddresses } from '../sync'

/**
 * A ranked suggestion for ONE address. It IS an {@link EmailAddress} (`{ name, email }` — the shape
 * that commits to a pill), plus an OPTIONAL local `photo` reference used only for the option avatar.
 * The photo is display-only: {@link import('./RecipientField').RecipientField} strips it back to
 * `{ name, email }` on commit, so a stored recipient never carries it. The contacts source (M4.3) is
 * the only producer that sets it; the recents source leaves it absent.
 */
export interface AddressSuggestion extends EmailAddress {
  readonly kind?: 'address'
  readonly photo?: ContactCardMedia
  /**
   * The organisation this address belongs to — a quiet third line under the name (S-5).
   *
   * Set only by the directory source, and it is what tells a reader that the row came from the
   * company directory rather than their own contacts. Deliberately a FACT about the person rather
   * than a badge saying "directory": Apple states affiliation, it does not label the source.
   * Display-only, like {@link photo} — stripped on commit by {@link suggestionAddresses}.
   */
  readonly organization?: string
}

/**
 * A contact GROUP offered as a recipient (A-4 of the JMAP gap analysis).
 *
 * A group has no address of its own — that is precisely why it needs its own variant rather than an
 * extra field on {@link AddressSuggestion}: there is no `email` to put in one, and a synthetic
 * placeholder would leak into the dedup key, into the pill and into the sent envelope. Committing
 * this option commits its {@link members}, which the source has ALREADY expanded (resolution is a
 * pure function of the cards it is built over, so the field never awaits anything on Enter).
 *
 * Groups are a client-side convenience, never an address the server knows: the recipients that go
 * out are the members, individually, exactly as if they had been typed.
 */
export interface GroupSuggestion {
  readonly kind: 'group'
  /** The group card's JSContact `uid` — this option's identity when sources are merged. */
  readonly uid: string
  /** The group's display name: what the option shows, and what the reader is choosing. */
  readonly name: string
  /** The members' addresses, already resolved and deduped. Never empty — an empty group is not offered. */
  readonly members: readonly EmailAddress[]
}

/** One option in the recipient autocomplete: a single address, or a group that expands into several. */
export type RecipientSuggestion = AddressSuggestion | GroupSuggestion

/** The addresses committing `suggestion` adds — one for an address, its members for a group. */
export function suggestionAddresses(suggestion: RecipientSuggestion): EmailAddress[] {
  return suggestion.kind === 'group'
    ? suggestion.members.map((member) => ({ name: member.name, email: member.email }))
    : // The `photo` reference is display-only and never stored on a recipient.
      [{ name: suggestion.name, email: suggestion.email }]
}

/** A suggestion's identity for deduplication across sources: a group by uid, an address by address. */
export function suggestionKey(suggestion: RecipientSuggestion): string {
  return suggestion.kind === 'group' ? `group:${suggestion.uid}` : suggestion.email.toLowerCase()
}

export interface RecipientSuggestionSource {
  query(prefix: string, limit: number): Promise<RecipientSuggestion[]>
}

/** Rank = frequency (sent weighted 3×) × recency with a 30-day half-life. Pure, unit-tested. */
export function scoreAddressStat(row: AddressStatRow, now: number): number {
  const frequency = row.sentCount * 3 + row.receivedCount + 1
  const ageDays = Math.max(0, (now - row.lastSeenAt) / 86_400_000)
  return frequency * 0.5 ** (ageDays / 30)
}

const toEmailAddress = (row: AddressStatRow): EmailAddress => ({ name: row.name, email: row.email })

/** M2.4 v1 — recent correspondents from the replica, ranked by {@link scoreAddressStat}. */
export function createRecentsSuggestionSource(
  db: ReplicaDb,
  accountId: Id,
): RecipientSuggestionSource {
  return {
    async query(prefix, limit) {
      const rows = await suggestAddresses(db, accountId, prefix)
      const now = Date.now()
      return [...rows]
        .sort((a, b) => scoreAddressStat(b, now) - scoreAddressStat(a, now))
        .slice(0, limit)
        .map(toEmailAddress)
    },
  }
}

/** M4.3 seam: merge sources in order, dedup by {@link suggestionKey}, cap to `limit`. */
export function combineSuggestionSources(
  sources: readonly RecipientSuggestionSource[],
): RecipientSuggestionSource {
  return {
    async query(prefix, limit) {
      const results = await Promise.all(sources.map((source) => source.query(prefix, limit)))
      const seen = new Set<string>()
      const out: RecipientSuggestion[] = []
      for (const suggestion of results.flat()) {
        const key = suggestionKey(suggestion)
        if (seen.has(key)) continue
        seen.add(key)
        out.push(suggestion)
        if (out.length >= limit) break
      }
      return out
    },
  }
}

/** Yields nothing — used when no replica is available (e.g. outside a ReplicaProvider, or in tests). */
export const EMPTY_SUGGESTION_SOURCE: RecipientSuggestionSource = { query: async () => [] }
