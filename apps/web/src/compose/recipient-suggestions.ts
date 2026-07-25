/**
 * Recipient autocomplete sources (M2.4, FR-CMP-05). A {@link RecipientSuggestionSource} is the seam
 * the pill fields query; M2.4 ships the recents source (the replica's `addressStats`, ranked by
 * frequency × recency). M4.3 adds a contacts source implementing the SAME interface and merges them
 * with {@link combineSuggestionSources}, so the field never changes.
 */

import type { ContactCardMedia, EmailAddress, Id } from '@waxwing/jmap'
import { type AddressStatRow, type ReplicaDb, suggestAddresses } from '../sync'

/**
 * A ranked recipient suggestion. It IS an {@link EmailAddress} (`{ name, email }` — the shape that
 * commits to a pill), plus an OPTIONAL local `photo` reference used only for the option avatar. The
 * photo is display-only: {@link import('./RecipientField').RecipientField} strips it back to
 * `{ name, email }` on commit, so a stored recipient never carries it. The contacts source (M4.3) is
 * the only producer that sets it; the recents source leaves it absent.
 */
export interface RecipientSuggestion extends EmailAddress {
  readonly photo?: ContactCardMedia
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

/** M4.3 seam: merge sources in order, dedup by lowercased email, cap to `limit`. */
export function combineSuggestionSources(
  sources: readonly RecipientSuggestionSource[],
): RecipientSuggestionSource {
  return {
    async query(prefix, limit) {
      const results = await Promise.all(sources.map((source) => source.query(prefix, limit)))
      const seen = new Set<string>()
      const out: RecipientSuggestion[] = []
      for (const address of results.flat()) {
        const key = address.email.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        out.push(address)
        if (out.length >= limit) break
      }
      return out
    },
  }
}

/** Yields nothing — used when no replica is available (e.g. outside a ReplicaProvider, or in tests). */
export const EMPTY_SUGGESTION_SOURCE: RecipientSuggestionSource = { query: async () => [] }
