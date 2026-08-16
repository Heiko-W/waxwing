/**
 * Search-highlight hook (M3.1, FR-SRCH-01). For the VISIBLE slice of a search, fetches
 * `SearchSnippet/get` and returns the sanitized (`<mark>`-only) subject/preview per email. Empty when
 * not searching or offline (the list then renders the plain server preview). Snippets are transient
 * VIEW data — never persisted; re-fetched as the visible slice scrolls (bounded to the slice).
 */

import type { EmailFilter, Id } from '@waxwing/jmap'
import { useEffect, useRef, useState } from 'react'
import { useAccountEngine } from '../../sync/engine'
import { sanitizeSnippet } from './snippet'

export interface Snippet {
  readonly subject: string
  readonly preview: string
}

const EMPTY: Map<Id, Snippet> = new Map()

export function useSnippets(
  filter: EmailFilter | null | undefined,
  visibleIds: Id[],
): Map<Id, Snippet> {
  const engine = useAccountEngine()
  const [snippets, setSnippets] = useState<Map<Id, Snippet>>(EMPTY)
  const idsKey = visibleIds.join(',')
  // Depend on the filter's VALUE, not its object identity: a mailbox-table write re-derives an
  // equal-but-fresh filter ref, which would otherwise re-run a redundant SearchSnippet/get.
  const filterKey = filter ? JSON.stringify(filter) : ''
  const filterRef = useRef(filter)
  filterRef.current = filter

  // The effect reads the live filter via ref and re-runs on the value-stable filterKey (not the
  // churn-prone filter object identity); dropping filterKey would stop it re-fetching on a real change.
  // The engine is THIS pane's account's (M4.4 Etappe 4) — snippets are highlights for ITS results.
  // Lowest-risk of the account-scoped reads: this is transient VIEW data, so the wrong engine costs
  // missing highlights, never a wrong write.
  // biome-ignore lint/correctness/useExhaustiveDependencies: filterKey is the intended re-fetch trigger; `engine` is a real dep.
  useEffect(() => {
    const activeFilter = filterRef.current
    if (activeFilter === undefined || activeFilter === null || idsKey === '') {
      setSnippets((prev) => (prev.size === 0 ? prev : EMPTY))
      return
    }
    if (engine === null) return
    let cancelled = false
    void engine.fetchSnippets(idsKey.split(','), activeFilter).then((raw) => {
      if (cancelled) return
      const next = new Map<Id, Snippet>()
      for (const [id, snippet] of raw) {
        next.set(id, {
          subject: sanitizeSnippet(snippet.subject ?? ''),
          preview: sanitizeSnippet(snippet.preview ?? ''),
        })
      }
      setSnippets(next)
    })
    return () => {
      cancelled = true
    }
  }, [filterKey, idsKey, engine])

  return snippets
}
