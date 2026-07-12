/**
 * Label-browse view state (M3.2). A label view is NOT a fake folder — it reuses the M3.1
 * search/query-window seam with a `{ hasKeyword }` filter, driven by the `?label=<keyword>` query
 * param on the `/mail` route (`label` wins over `?q=`). Returns the descriptor the message list's
 * `search` prop expects, or `null` when no label is active.
 */

import type { Id } from '@waxwing/jmap'
import { useMemo } from 'react'
import { useRoute } from '../../app/route'
import type { QuerySpec } from '../../sync'

export interface LabelView {
  readonly activeLabel: string
  readonly listSearch: { readonly spec: QuerySpec; readonly scopeMailboxId: Id | undefined }
}

export function useLabelView(): LabelView | null {
  const route = useRoute()
  const label = route.search.get('label')
  return useMemo(() => {
    if (label === null || label === '') return null
    return {
      activeLabel: label,
      listSearch: {
        spec: {
          filter: { hasKeyword: label },
          sort: [{ property: 'receivedAt', isAscending: false }],
          collapseThreads: false,
        },
        scopeMailboxId: undefined,
      },
    }
  }, [label])
}
