/**
 * Contacts search-as-you-type (M4.2), HYBRID by design:
 *
 *  1. an INSTANT local pass over the already-replicated book window (offline-complete, zero latency);
 *  2. PLUS a debounced server `ContactCard/query` (`text` filter) watched via the engine, so a book
 *     that is not fully replicated still surfaces matches the local pass cannot see.
 *
 * The two are unioned (local first, then server-only), de-duplicated by id, and both filtered against
 * the CURRENT needle — so a stale server echo for a previous query can never leak a non-matching card
 * between keystrokes.
 *
 * The search text is LOCAL component state and is written ONLY by the input's `onChange`. This is the
 * project's controlled-input-vs-async-source seam (the top local bug class): the base/server windows
 * are live queries that re-render this hook on every replica write, and if any of them wrote back into
 * `query` a keystroke landing mid-echo would be lost. Nothing here does — `query` flows one way out to
 * the debounce and the filters, never back — which is what the segment-race test pins.
 */

import type { ContactCardFilterCondition, Id } from '@waxwing/jmap'
import { useEffect, useMemo, useState } from 'react'
import { type ContactCardRow, canonicalContactQueryKey, useContactWindow } from '../sync'
import { useActiveEngine } from '../sync/engine'
import { contactMatches, contactSortKey } from './contact-fields'

/** Mirrors the mail search debounce ({@link ../mail/search/SearchBox}) so the two feel identical. */
const SEARCH_DEBOUNCE_MS = 200

export interface ContactSearchState {
  /** The controlled input value — local state, never reset by an async source (see file header). */
  readonly query: string
  setQuery(value: string): void
  /** Cards to render, in display order; `undefined` while the base window is still loading. */
  readonly cards: (ContactCardRow | undefined)[] | undefined
  /** True while a non-empty search is active — drives the "no matches" vs "no contacts" copy. */
  readonly searching: boolean
}

/**
 * A single ANDed `ContactCard/query` condition (RFC 9610 §3.3.1 — multiple present fields are ANDed,
 * so book + text need no boolean operator). `null` when unconstrained (all books, no text).
 */
function buildFilter(bookId: Id | undefined, text: string): ContactCardFilterCondition | null {
  const filter: ContactCardFilterCondition = {}
  if (bookId !== undefined) filter.inAddressBook = bookId
  if (text !== '') filter.text = text
  return Object.keys(filter).length === 0 ? null : filter
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), ms)
    return () => window.clearTimeout(timer)
  }, [value, ms])
  return debounced
}

function definedCards(list: (ContactCardRow | undefined)[] | undefined): ContactCardRow[] {
  return (list ?? []).filter((card): card is ContactCardRow => card !== undefined)
}

/**
 * Drop group cards (`kind: 'group'`) — they belong in the rail, not the individual list (Apple
 * Contacts convention). An undefined placeholder (a not-yet-synced row) is kept: its kind is unknown,
 * and dropping the skeleton would shorten the window; a group that resolves later simply disappears.
 */
function withoutGroups(list: (ContactCardRow | undefined)[]): (ContactCardRow | undefined)[] {
  return list.filter((card) => card === undefined || card.kind !== 'group')
}

/** Alphabetical by display name (Apple Contacts order), regardless of the server's window collation. */
function sortForDisplay(cards: (ContactCardRow | undefined)[]): (ContactCardRow | undefined)[] {
  return [...cards].sort((a, b) => {
    if (a === undefined) return 1
    if (b === undefined) return -1
    return contactSortKey(a).localeCompare(contactSortKey(b), undefined, { sensitivity: 'base' })
  })
}

export function useContactSearch(bookId: Id | undefined): ContactSearchState {
  const [query, setQuery] = useState('')
  const trimmed = query.trim()
  const debounced = useDebounced(trimmed, SEARCH_DEBOUNCE_MS)
  const engine = useActiveEngine()

  // Base window: every card in the book (or across all books). The instant local filter reads from
  // it, and it is the whole-list view when the box is empty.
  const baseSpec = useMemo(() => ({ filter: buildFilter(bookId, '') }), [bookId])
  const baseKey = useMemo(() => canonicalContactQueryKey(baseSpec), [baseSpec])
  useEffect(() => {
    if (engine === null) return
    const key = engine.watchContactQuery(baseSpec)
    return () => engine.unwatchContactQuery(key)
  }, [engine, baseSpec])

  // Server search window: watched only once the DEBOUNCED text is non-empty, so keystrokes don't spam
  // `ContactCard/query`. `null` spec ⇒ no watch and an empty key below.
  const searchSpec = useMemo(
    () => (debounced === '' ? null : { filter: buildFilter(bookId, debounced) }),
    [bookId, debounced],
  )
  const searchKey = useMemo(
    () => (searchSpec === null ? '' : canonicalContactQueryKey(searchSpec)),
    [searchSpec],
  )
  useEffect(() => {
    if (engine === null || searchSpec === null) return
    const key = engine.watchContactQuery(searchSpec)
    return () => engine.unwatchContactQuery(key)
  }, [engine, searchSpec])

  const baseCards = useContactWindow(baseKey)
  // An empty key resolves to an empty window (cache miss → `[]`), so this is inert until a search runs.
  const serverCards = useContactWindow(searchKey)

  const cards = useMemo(() => {
    if (baseCards === undefined) return undefined
    if (trimmed === '') return sortForDisplay(withoutGroups(baseCards))

    const needle = trimmed.toLowerCase()
    // Instant local pass, filtered by the CURRENT text (not the debounced one) for zero-latency,
    // offline-complete feedback. Groups never appear in the individual list.
    const local = definedCards(baseCards).filter(
      (card) => card.kind !== 'group' && contactMatches(card, needle),
    )
    const seen = new Set(local.map((card) => card.id))
    // Server-only matches (a partially-replicated book). Re-filtered by the CURRENT needle so a stale
    // echo for the previous query cannot leak a card that no longer matches.
    const serverOnly = definedCards(serverCards).filter(
      (card) => card.kind !== 'group' && !seen.has(card.id) && contactMatches(card, needle),
    )
    return sortForDisplay([...local, ...serverOnly])
  }, [baseCards, serverCards, trimmed])

  return { query, setQuery, cards, searching: trimmed !== '' }
}
