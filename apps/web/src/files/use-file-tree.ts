/**
 * The Files screen's read path (D-4) — the replica, and nothing else.
 *
 * Until D-4 this screen re-queried the whole account on every visit and kept nothing, so a lost
 * connection produced "Your files could not be loaded." over a folder the device had listed a minute
 * earlier. Mail and Contacts have read from the replica since M1.2; this is Files joining them.
 *
 * **Search moved off the wire, and that is not a shortcut.** The replica holds the WHOLE tree — it
 * has to, because Stalwart refuses `filter: {parentId: null}` and takes the whole request with it, so
 * the root level was already being reassembled from an unfiltered account-wide query
 * (`files-client.ts`). Given every node locally, a server round-trip per keystroke bought nothing
 * the client could not answer itself, and cost the one thing that matters here: an answer with no
 * network. The one case where the server would know more is a tree the walk could not finish, and
 * {@link useFileTreeState}'s `truncated` is exactly the sentence the screen says about that.
 *
 * Blobs are deliberately NOT here. A node's bytes are a download, and a folder you can read offline
 * is a different (and much cheaper) promise than a file you can open offline.
 */

import { useMemo } from 'react'
import { useAllFileNodes } from '../sync'
import type { FileSearchHit } from './files-client'

/**
 * Mirrors `SEARCH_LIMIT` in `files-client.ts`: a result list nobody scrolls to the end of is not a
 * better answer, and the two paths should not disagree about how long "too long" is.
 */
const SEARCH_LIMIT = 100

/**
 * Nodes anywhere in the account whose name contains `query`, each with the folder it sits in.
 *
 * A blank query answers `[]` — NOT everything. `{ name: "" }` matches every node there is, and
 * answering an empty field with the whole tree is not what anyone asked for (the same rule the
 * server-side search followed).
 *
 * The parent is not decoration: a search spans the whole account, so `report.txt` can appear three
 * times over, and three identical rows are worse than no search at all.
 */
export function useFileSearch(query: string): readonly FileSearchHit[] | undefined {
  // Read the whole tree only while a search is actually running — a folder listing needs one level.
  const all = useAllFileNodes(query !== '')

  return useMemo(() => {
    if (query === '') return []
    if (all === undefined) return undefined
    const needle = query.toLowerCase()
    const byId = new Map(all.map((node) => [node.id, node]))
    return all
      .filter((node) => node.name.toLowerCase().includes(needle))
      .slice(0, SEARCH_LIMIT)
      .map((node) => ({
        node,
        parent: node.parentId === null ? null : (byId.get(node.parentId) ?? null),
      }))
  }, [all, query])
}
