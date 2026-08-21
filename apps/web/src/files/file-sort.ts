/**
 * The order a folder is shown in (D-3).
 *
 * Two answers, deliberately, because they answer two different questions.
 *
 * **The server's sort decides what SURVIVES a truncated listing.** The root query is unfiltered and
 * paged (see `files-client.ts`); where an account is larger than the pages this client will spend,
 * the order the SERVER applied is what decides which nodes made it into the answer at all. So the
 * comparator goes on the wire.
 *
 * **The client's sort decides what the reader SEES.** It is applied to whatever came back, every
 * time, and it is the one that must not be wrong. A server that orders `file10` before `file2`, or
 * that quietly ignores a comparator it does not implement, changes the wire order and nothing else
 * — the screen stays right.
 *
 * WHAT GOES ON THE WIRE IS GATED ON THE SESSION'S OWN LIST. `fileNodeQuerySortOptions` is measured
 * (`["name","size","nodeType"]` on Stalwart 0.16.18) and it is not decoration: a `FileNode/query`
 * argument this server refuses does not merely fail that method, it takes the WHOLE request with it
 * (HTTP 400 `notRequest` — the failure that took the Files screen out once already). So a property
 * the session has not advertised is never sent, and `name` — the one the screen has always sent —
 * is what a refusal would fall back to.
 *
 * FOLDERS STAY ON TOP IN BOTH DIRECTIONS. Reversing the order is a question about the files, not
 * about the shape of the tree; iOS Files and Windows Explorer both keep the grouping, and a
 * "descending by name" that buries the folders under the files makes the way DOWN the tree the
 * thing that moved.
 */

import type { Comparator, FileNode, FileNodeCapability } from '@waxwing/jmap'

/** The properties this screen can order by — the three the server advertises, and no others. */
export const FILE_SORT_KEYS = ['name', 'size', 'nodeType'] as const

export type FileSortKey = (typeof FILE_SORT_KEYS)[number]

export interface FileSort {
  readonly key: FileSortKey
  readonly ascending: boolean
}

/** A→Z, which is what a file manager opens on. */
export const DEFAULT_FILE_SORT: FileSort = { key: 'name', ascending: true }

/**
 * The keys this session may be offered, in {@link FILE_SORT_KEYS} order.
 *
 * `null` capability — no session, or a server that announces file storage without limits — answers
 * with `name` alone. That is the conservative branch on purpose: this list is what the picker
 * offers, and offering an order the server has not claimed to support is how a request gets
 * refused whole.
 */
export function offeredSortKeys(capability: FileNodeCapability | null): readonly FileSortKey[] {
  const advertised = capability?.fileNodeQuerySortOptions ?? []
  const offered = FILE_SORT_KEYS.filter((key) => advertised.includes(key))
  return offered.length === 0 ? ['name'] : offered
}

/**
 * The comparator to send, or the `name` fallback where this key is not advertised.
 *
 * Never empty: a query with no `sort` is a query whose truncation point is the server's whim.
 */
export function serverSort(sort: FileSort, capability: FileNodeCapability | null): Comparator[] {
  const property = offeredSortKeys(capability).includes(sort.key) ? sort.key : 'name'
  return [{ property, isAscending: sort.ascending }]
}

/**
 * Natural-language name order: `file2` before `file10`, `Ä` beside `A`.
 *
 * `numeric` because a folder of numbered scans is the case where a plain code-point sort is most
 * obviously wrong, and `base` sensitivity because two names differing only in case or accent are
 * neighbours to a reader, not opposite ends of the list.
 */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/**
 * The order the reader sees: folders first, then `sort` within each group.
 *
 * Exported as the comparator rather than only as a sorted array because search results are not
 * nodes — they are nodes paired with the folder they were found in, and the pairing must survive
 * the sort.
 */
export function fileComparator(sort: FileSort): (a: FileNode, b: FileNode) => number {
  const direction = sort.ascending ? 1 : -1
  const within = (a: FileNode, b: FileNode): number => {
    switch (sort.key) {
      case 'size':
        // Ties broken by name rather than left to the input order: a folder of same-sized files
        // would otherwise reshuffle itself between two loads for no reason the reader can see.
        return (a.size - b.size) * direction || collator.compare(a.name, b.name)
      case 'nodeType':
        return (
          collator.compare(a.nodeType, b.nodeType) * direction || collator.compare(a.name, b.name)
        )
      default:
        return collator.compare(a.name, b.name) * direction
    }
  }
  const rank = (node: FileNode): number => (node.nodeType === 'directory' ? 0 : 1)
  return (a, b) => rank(a) - rank(b) || within(a, b)
}

/** {@link fileComparator} applied to a listing. */
export function sortNodes(nodes: readonly FileNode[], sort: FileSort): FileNode[] {
  return [...nodes].sort(fileComparator(sort))
}
