/**
 * Recipient autocomplete sources (M2.4, FR-CMP-05). A {@link RecipientSuggestionSource} is the seam
 * the pill fields query; M2.4 ships the recents source (the replica's `addressStats`, ranked by
 * frequency × recency). M4.3 adds a contacts source implementing the SAME interface and merges them
 * with {@link combineSuggestionSources}, so the field never changes.
 */

import type { EmailAddress, Id } from '@waxwing/jmap'
import { type AddressStatRow, type ReplicaDb, suggestAddresses } from '../sync'

export interface RecipientSuggestionSource {
  query(prefix: string, limit: number): Promise<EmailAddress[]>
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
      const out: EmailAddress[] = []
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
