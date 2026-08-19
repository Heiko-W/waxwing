/**
 * Saved searches as virtual folders (M5.5, FR-SRCH-03).
 *
 * A saved search is a **query string and a name**, nothing more. It deliberately does not store a
 * parsed filter: the parser resolves `in:archive` against the account's actual mailboxes at run
 * time, so a saved filter would freeze a mailbox id that a rename or a re-created folder can
 * invalidate. Re-parsing on every use costs nothing and cannot go stale.
 *
 * Stored per account in the local preferences, alongside the other client-side lists. The server
 * has no concept of a saved search, so there is nothing to sync it to.
 */

export const SAVED_SEARCH_PREF_KEY = 'search.saved'

/** A guard against an unbounded preference row; also the point where a sidebar stops being a list. */
export const MAX_SAVED_SEARCHES = 20

export interface SavedSearch {
  readonly id: string
  readonly name: string
  /** The raw query, exactly as typed — `from:ada has:attachment`. */
  readonly query: string
  /** Whether it searches everywhere or only the folder it was saved in. */
  readonly scope: 'all' | 'folder'
}

/** Reads the stored list, tolerating any shape. */
export function coerceSavedSearches(value: unknown): SavedSearch[] {
  if (!Array.isArray(value)) return []
  const out: SavedSearch[] = []
  for (const candidate of value) {
    if (typeof candidate !== 'object' || candidate === null) continue
    const raw = candidate as Record<string, unknown>
    if (typeof raw.id !== 'string' || typeof raw.name !== 'string') continue
    if (typeof raw.query !== 'string' || raw.query.trim() === '') continue
    out.push({
      id: raw.id,
      name: raw.name,
      query: raw.query,
      // Anything unrecognised means "everywhere", which is the safer default: a saved search that
      // silently narrowed itself to one folder would look like it had lost results.
      scope: raw.scope === 'folder' ? 'folder' : 'all',
    })
  }
  return out.slice(0, MAX_SAVED_SEARCHES)
}

export function addSavedSearch(
  searches: readonly SavedSearch[],
  entry: SavedSearch,
): SavedSearch[] {
  const existing = searches.findIndex((saved) => saved.id === entry.id)
  if (existing >= 0) return searches.map((saved, i) => (i === existing ? entry : saved))
  return [...searches, entry].slice(0, MAX_SAVED_SEARCHES)
}

export function removeSavedSearch(searches: readonly SavedSearch[], id: string): SavedSearch[] {
  return searches.filter((saved) => saved.id !== id)
}

/** Whether this query is already saved (compared on the query, not the name). */
export function findByQuery(
  searches: readonly SavedSearch[],
  query: string,
  scope: 'all' | 'folder',
): SavedSearch | undefined {
  const needle = query.trim()
  return searches.find((saved) => saved.query.trim() === needle && saved.scope === scope)
}

/** A default name for a query the user has not named: the query itself, clamped. */
export function defaultName(query: string, maxLength = 40): string {
  const trimmed = query.trim()
  return trimmed.length <= maxLength ? trimmed : `${trimmed.slice(0, maxLength - 1)}…`
}
