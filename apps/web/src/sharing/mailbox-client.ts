/**
 * The JMAP seam for sharing a mail folder (S-3, RFC 9670 §1.2).
 *
 * Online-only and deliberately outside the sync engine's replica, for a measured reason:
 * `Mailbox/get` **does not return `shareWith` unless it is asked for**. Against Stalwart v0.16.18 a
 * property-less get answers with eleven keys and `shareWith` is not among them; the engine's
 * `Mailbox/get` (`sync/engine/port.ts`) sends no `properties`, so no replica row has ever held a
 * grant map. Reading one out of the replica would therefore mean reading `undefined` and writing
 * `{}` over whatever the server has — a silent revoke of everyone.
 *
 * So the dialog fetches the map when it opens and writes the whole of it back. That is also the only
 * way to be current: `Mailbox/set` REPLACES `shareWith`, and the round trip is the window in which
 * another client's change can be lost. Short is the best that shape allows.
 *
 * The `using` set is core + mail, with no `urn:ietf:params:jmap:mail:share` — measured, both the get
 * and the set succeed without it, and an unrecognised `using` entry costs the WHOLE request on this
 * server (HTTP 400 `notRequest`). See `Capabilities.mailShare`.
 */

import type { Id, JmapClient, Mailbox, Principal } from '@waxwing/jmap'
import { Methods } from '@waxwing/jmap'
import type { MailboxShareWith } from './mailbox'
import { searchPrincipals } from './principals'

/** Why a share write failed, in the terms the UI can explain. */
export type MailboxShareFailure = 'forbidden' | 'invalidRights' | 'rejected'

export class MailboxShareError extends Error {
  constructor(
    readonly failure: MailboxShareFailure,
    description?: string | null,
  ) {
    super(description ?? failure)
    this.name = 'MailboxShareError'
  }
}

export interface MailboxSharingClient {
  /** The grant map the server currently holds for `mailboxId`. `{}` when nobody has access. */
  load(mailboxId: Id): Promise<MailboxShareWith>
  searchPrincipals(query: string): Promise<Principal[]>
  /** Replaces the folder's WHOLE grant map. */
  setShareWith(mailboxId: Id, shareWith: MailboxShareWith): Promise<void>
}

export function makeMailboxSharingClient(
  client: JmapClient,
  accountId: Id,
  /** Excluded from principal searches. */
  selfPrincipalId: Id | null = null,
): MailboxSharingClient {
  return {
    async load(mailboxId) {
      const responses = await client.call([
        [
          Methods.mailboxGet.name,
          // EXPLICIT properties — see the module note. `id` rides along so a `notFound` is legible.
          { accountId, ids: [mailboxId], properties: ['id', 'shareWith'] },
          'm0',
        ],
      ])
      const { list } = responses.get<{ list: Partial<Mailbox>[] }>('m0')
      return (list[0]?.shareWith ?? {}) as MailboxShareWith
    },

    async searchPrincipals(query) {
      return await searchPrincipals(client, accountId, query, selfPrincipalId)
    },

    async setShareWith(mailboxId, shareWith) {
      const responses = await client.call([
        [Methods.mailboxSet.name, { accountId, update: { [mailboxId]: { shareWith } } }, 'm0'],
      ])
      const response = responses.get<{
        notUpdated: Record<string, { type: string; description?: string | null }> | null
      }>('m0')
      /*
       * A refusal here is PER OBJECT, not per request — `notUpdated`, with the batch intact. The one
       * that will actually happen is `invalidProperties` ("Invalid permission …"): measured, that is
       * what an unknown rights key gets, and it is why `mailbox.ts` writes the ten measured keys out
       * rather than trusting a spec.
       */
      const first = Object.values(response.notUpdated ?? {})[0]
      if (first !== undefined) throw new MailboxShareError(classify(first.type), first.description)
    },
  }
}

function classify(type: string): MailboxShareFailure {
  if (type === 'forbidden') return 'forbidden'
  if (type === 'invalidProperties') return 'invalidRights'
  return 'rejected'
}
