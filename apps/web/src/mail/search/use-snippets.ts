/**
 * Search-highlight hook (M3.1, FR-SRCH-01). For the VISIBLE slice of a search, fetches
 * `SearchSnippet/get` and returns the sanitized (`<mark>`-only) subject/preview per email. Empty when
 * not searching or offline (the list then renders the plain server preview). Snippets are transient
 * VIEW data — never persisted; re-fetched as the visible slice scrolls (bounded to the slice).
 */

import type { EmailFilter, Id } from '@waxwing/jmap'
import { useEffect, useState } from 'react'
import { getActiveEngine } from '../../sync/engine'
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
  const [snippets, setSnippets] = useState<Map<Id, Snippet>>(EMPTY)
  const idsKey = visibleIds.join(',')

  useEffect(() => {
    if (filter === undefined || filter === null || idsKey === '') {
      setSnippets((prev) => (prev.size === 0 ? prev : EMPTY))
      return
    }
    const engine = getActiveEngine()
    if (engine === null) return
    let cancelled = false
    void engine.fetchSnippets(idsKey.split(','), filter).then((raw) => {
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
  }, [filter, idsKey])

  return snippets
}
