/**
 * Search state hook (M3.1). The search lives entirely in the URL (`?q=…&scope=folder|all`) — this hook
 * reads it, parses `q` into a `QuerySpec` for the results list + derives the chips, and exposes
 * setters that navigate. Because chips/spec derive from the SAME `q`, the box and the chips can never
 * drift. Search results sort by date and show each matching message (no thread collapse).
 */

import type { Id } from '@waxwing/jmap'
import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useRoute } from '../../app/route'
import { type QuerySpec, useMailboxesFor } from '../../sync'
import { folderDisplayName } from '../folder-tree'
import { type ChipTranslate, type SearchChip, searchChips } from './search-chips'
import {
  parseSearchQuery,
  type SearchContext,
  type SearchToken,
  serializeTokens,
} from './search-query'

export type SearchScope = 'folder' | 'all'

export interface SearchState {
  /** True when there is a non-empty query (⇒ the list shows results, not the folder). */
  readonly active: boolean
  readonly q: string
  readonly scope: SearchScope
  /** The results query, or `null` when inactive. */
  readonly spec: QuerySpec | null
  /** The source mailbox for scope=folder bulk-move; `undefined` for scope=all. */
  readonly scopeMailboxId: Id | undefined
  readonly chips: SearchChip[]
  setQuery(raw: string, opts?: { replace?: boolean }): void
  setScope(scope: SearchScope): void
  removeChip(index: number): void
  clear(): void
}

const SEARCH_SORT = [{ property: 'receivedAt', isAscending: false }]

/**
 * `accountId` is passed in, not taken from context (M4.4 Etappe 4): this hook runs in `MailScreen`'s
 * BODY, above the acting-account scope it feeds, so context here is always the primary's. Its output
 * reaches two account-sensitive places — the `in:` filter term, and `moveSource`, which becomes the
 * `from` of a bulk move. Resolving folder names against the primary while the list dispatches for a
 * shared account yields either a silently dropped token or a FOREIGN mailbox id used as a move
 * source; and that gets strictly worse now that the engine itself routes correctly.
 */
export function useSearch(currentMailboxId: Id | undefined, accountId: Id): SearchState {
  const { t } = useTranslation()
  const route = useRoute()
  const navigate = useNavigate()
  const mailboxes = useMailboxesFor(accountId)

  const q = route.search.get('q') ?? ''
  const scope: SearchScope = route.search.get('scope') === 'all' ? 'all' : 'folder'
  // The scope the FILTER uses (ANDed unless an explicit `in:` overrides). Distinct from the bulk-move
  // source, which must be the ACTUAL single results folder (see `moveSource` below).
  const filterScope = scope === 'folder' ? currentMailboxId : undefined

  const resolveMailbox = useCallback(
    (name: string): Id | undefined => {
      const needle = name.trim().toLowerCase()
      const match = (mailboxes ?? []).find(
        (mailbox) =>
          mailbox.role === needle ||
          mailbox.name.toLowerCase() === needle ||
          folderDisplayName(mailbox, t).toLowerCase() === needle,
      )
      return match?.id
    },
    [mailboxes, t],
  )

  const { spec, chips, tokens, moveSource } = useMemo(() => {
    const ctx: SearchContext = {
      resolveMailbox,
      now: Date.now(),
      ...(filterScope !== undefined ? { scopeMailboxId: filterScope } : {}),
    }
    const parsed = parseSearchQuery(q, ctx)
    const nextSpec: QuerySpec | null =
      parsed.filter === null
        ? null
        : { filter: parsed.filter, sort: [...SEARCH_SORT], collapseThreads: false }
    // The single mailbox all results come from (for a correct bulk-move `from`): one explicit `in:`
    // wins; else the scoped folder when there's no `in:`; else undefined (multi-folder → moves gated).
    const inIds = parsed.tokens
      .filter(
        (tk): tk is Extract<SearchToken, { type: 'op' }> => tk.type === 'op' && tk.op === 'in',
      )
      .map((tk) => resolveMailbox(tk.value))
      .filter((id): id is Id => id !== undefined)
    const nextMoveSource =
      inIds.length === 1
        ? inIds[0]
        : inIds.length === 0 && scope === 'folder'
          ? currentMailboxId
          : undefined
    // `t` satisfies ChipTranslate at runtime; the cast sidesteps i18next's exactOptional overloads.
    return {
      spec: nextSpec,
      chips: searchChips(parsed.tokens, ctx, t as ChipTranslate),
      tokens: parsed.tokens,
      moveSource: nextMoveSource,
    }
  }, [q, resolveMailbox, filterScope, scope, currentMailboxId, t])

  const goto = useCallback(
    (rawQ: string, nextScope: SearchScope, opts?: { replace?: boolean }) => {
      const params = new URLSearchParams()
      if (rawQ.trim() !== '') {
        params.set('q', rawQ)
        if (nextScope === 'all') params.set('scope', 'all')
      }
      const qs = params.toString()
      const target = qs ? `${route.path}?${qs}` : route.path
      navigate(target, opts?.replace ? { replace: true } : undefined)
    },
    [navigate, route.path],
  )

  const setQuery = useCallback(
    (raw: string, opts?: { replace?: boolean }) => goto(raw, scope, opts),
    [goto, scope],
  )
  const setScope = useCallback((next: SearchScope) => goto(q, next), [goto, q])
  const removeChip = useCallback(
    (index: number) => goto(serializeTokens(tokens.filter((_, i) => i !== index)), scope),
    [goto, tokens, scope],
  )
  const clear = useCallback(() => goto('', scope), [goto, scope])

  return {
    active: q.trim() !== '',
    q,
    scope,
    spec,
    scopeMailboxId: moveSource,
    chips,
    setQuery,
    setScope,
    removeChip,
    clear,
  }
}
