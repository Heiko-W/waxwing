/**
 * Finding the people a thing can be shared with (RFC 9670 §2.3).
 *
 * One `Principal/query` + `Principal/get` round trip, shared by every share dialog. Lifted out of
 * `files/files-client.ts` when mail folders needed the same picker (S-3); the file client now calls
 * this rather than carrying its own copy, so the two rules below hold in one place.
 */

import type { Id, JmapClient, Principal } from '@waxwing/jmap'
import { Capabilities, Methods, principalSearchFilter } from '@waxwing/jmap'
import type { JmapSession } from '../app/session/types'

/** A result list nobody scrolls to the end of is not a better answer. */
const SEARCH_LIMIT = 50

/**
 * Everyone `accountId` may share with, matching `query` — never `selfPrincipalId`.
 *
 * An empty query lists everyone rather than nobody: a picker that shows nothing until you type
 * hides the fact that there are only three colleagues to choose from.
 */
export async function searchPrincipals(
  client: JmapClient,
  accountId: Id,
  query: string,
  selfPrincipalId: Id | null = null,
): Promise<Principal[]> {
  const builder = client.request()
  /*
   * `principalSearchFilter` answers `null` for an empty query — "everyone" — and a share picker
   * opens on exactly that. "No filter" is an ABSENT key, not a null one: the same shape that took
   * the Files screen out when `{ parentId: null }` was sent to `FileNode/query`, one round trip
   * away from here.
   */
  const filter = principalSearchFilter(query)
  const found = builder.invoke(Methods.principalQuery, {
    accountId,
    // `text`, not `name`: measured, see `principalSearchFilter`.
    ...(filter === null ? {} : { filter }),
    limit: SEARCH_LIMIT,
  })
  const principals = builder.invoke(Methods.principalGet, {
    accountId,
    '#ids': found.ref('/ids'),
  })
  const responses = await builder.send()
  return responses.get(principals).list.filter((principal) => principal.id !== selfPrincipalId)
}

/**
 * The user's own principal id, from the account capability.
 *
 * `null` when the server does not advertise it — in which case a picker cannot exclude the user and
 * does not pretend to. Sharing something with yourself is harmless; silently filtering the wrong row
 * out would not be.
 */
export function currentUserPrincipalId(
  session: JmapSession | null,
  accountId: Id | null,
): Id | null {
  if (session === null || accountId === null) return null
  const capability = session.accounts?.[accountId]?.accountCapabilities?.[Capabilities.principals]
  return (
    (capability as { currentUserPrincipalId?: Id | null } | undefined)?.currentUserPrincipalId ??
    null
  )
}
