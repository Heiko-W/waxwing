/**
 * Message-list data hook (M1.6). Binds a (mailbox + sort + threading) query to the replica's
 * server-ordered `queryCache` window that the M1.3 engine keeps fresh:
 *  - it computes the SAME canonical key the engine watches (via {@link windowQueryKey}) so it can
 *    subscribe immediately, and asks the engine to `watchWindow` it (register + backfill-if-absent);
 *  - it returns the ordered id window + total for the virtualizer, plus `loadMore` for infinite
 *    scroll. Row hydration for the VISIBLE slice is the list component's job (`useEmailWindow`), so
 *    a 100 k-message window never bulk-loads every row.
 *
 * Each (mailbox, sort, flat/threaded) is its OWN watched query (FR-LST-05: "each sort is its own
 * watched query"), keyed distinctly — switching sort swaps to a different `queryCache` window.
 */

import type { EmailComparator, Id } from '@waxwing/jmap'
import { useCallback, useEffect, useMemo } from 'react'
import { useConfig } from '../app/config-context'
import { canonicalQueryKey, type QuerySpec, useQueryWindow } from '../sync'
import { useAccountEngine, type WindowSpec, windowQueryKey } from '../sync/engine'

/**
 * The list's sort keys (M-10). `date` is the RECEIVED date — the one a mailbox is ordered by — and
 * `sentAt` is the date the sender put on it, which differ for anything delayed, imported or
 * re-delivered. `to` exists for Sent and Drafts, where the recipient is the only useful key and
 * sorting by sender orders every row identically.
 */
export type MessageSort = 'date' | 'sentAt' | 'from' | 'to' | 'subject' | 'size'

/** What the list renders: a folder's recent window, or an arbitrary search query (M3.1). */
export type ListSource =
  | { readonly kind: 'folder'; readonly mailboxId: Id }
  | { readonly kind: 'search'; readonly spec: QuerySpec }

export interface MessageListOptions {
  /** Sort unread messages to the top (a keyword-based comparator prepended to the base sort). */
  readonly unreadFirst?: boolean
  /** Flat (per-message) view instead of server-collapsed threads (FR-LST-02). */
  readonly flat?: boolean
}

export interface MessageListState {
  /** The canonical query key of the window (also the `useEmailWindow` source of `ids`). */
  readonly key: string
  /** Server-ordered ids; the virtualizer renders in THIS order (empty until the window resolves). */
  readonly ids: Id[]
  /** Total matching messages (for the virtualizer count + "load more" trigger), if known. */
  readonly total: number | undefined
  /** True while a mailbox is selected but its window has not resolved yet. */
  readonly loading: boolean
  /** Page the next window of older messages into the query (infinite scroll). */
  readonly loadMore: () => void
}

const PAGE_SIZE = 50
const EMPTY_IDS: Id[] = []

// All six are in the session's `emailQuerySortOptions` and were measured working against Stalwart
// v0.16.14/.18 — dates newest-first, names and subjects A→Z, size largest-first.
const BASE_SORT: Record<MessageSort, EmailComparator[]> = {
  date: [{ property: 'receivedAt', isAscending: false }],
  sentAt: [{ property: 'sentAt', isAscending: false }],
  from: [{ property: 'from', isAscending: true }],
  to: [{ property: 'to', isAscending: true }],
  subject: [{ property: 'subject', isAscending: true }],
  size: [{ property: 'size', isAscending: false }],
}

function comparators(sort: MessageSort, unreadFirst: boolean): EmailComparator[] {
  // A stored preference is user data and can name a sort this build no longer has; falling back
  // beats indexing into `undefined` and rendering nothing.
  const base = BASE_SORT[sort] ?? BASE_SORT.date
  // Unread-first: `hasKeyword $seen` ascending puts unread (no `$seen`) before read.
  return unreadFirst
    ? [{ property: 'hasKeyword', keyword: '$seen', isAscending: true }, ...base]
    : [...base]
}

export function useMessageList(
  source: ListSource | undefined,
  sort: MessageSort = 'date',
  options: MessageListOptions = {},
): MessageListState {
  const cacheDays = useConfig().offline.cacheDays
  const { unreadFirst = false, flat = false } = options

  // Folder windows key off (mailbox + sort + threading); a search keys off its own spec.
  const folderSpec = useMemo<WindowSpec>(
    () => ({ sort: comparators(sort, unreadFirst), collapseThreads: !flat }),
    [sort, unreadFirst, flat],
  )

  const key = useMemo(() => {
    if (source === undefined) return ''
    if (source.kind === 'search') return canonicalQueryKey(source.spec)
    return windowQueryKey(source.mailboxId, cacheDays, Date.now(), folderSpec).key
  }, [source, cacheDays, folderSpec])

  // Depend on the reactive engine so the watch re-runs the moment the engine appears (it is set by
  // SyncEngineHost's effect, which can commit AFTER this child's) — otherwise a deep-linked/reloaded
  // non-default window would never backfill and would spin forever. A search is EPHEMERAL: unwatch it
  // on unmount / when the query changes so `watched` does not grow unbounded.
  //
  // The engine of THIS pane's account (M4.4 Etappe 4). The watch has to run on the same engine whose
  // account the window is read back under (`useQueryWindow` → `queryCache[[accountId, key]]`), and
  // `windowQueryKey` carries no account. On the primary engine a shared account's Inbox happened to
  // work by accident — the shared engine's own `ensureInboxWindow` produces a byte-identical key at
  // the default sort — but any other folder, sort, unread-first, flat, search or label view backfills
  // under the wrong account's key and spins forever, and `loadMoreFor` pages the PRIMARY's
  // identically-keyed window.
  const engine = useAccountEngine()
  useEffect(() => {
    if (source === undefined) return
    if (source.kind === 'search') {
      const searchKey = engine?.watchQuery(source.spec)
      return () => {
        if (searchKey !== undefined) engine?.unwatchQuery(searchKey)
      }
    }
    engine?.watchWindow(source.mailboxId, folderSpec)
    return undefined
  }, [engine, source, folderSpec])

  const window = useQueryWindow(key)
  const loadMore = useCallback(() => {
    if (key !== '') void engine?.loadMoreFor(key, PAGE_SIZE)
  }, [key, engine])

  return {
    key,
    ids: window?.ids ?? EMPTY_IDS,
    total: window?.total ?? undefined,
    loading: source !== undefined && window === undefined,
    loadMore,
  }
}
