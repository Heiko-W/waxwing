/**
 * The JMAP seam for Quota (M3.7, RFC 9425). One method, read-only.
 *
 * `Quota/get` MUST NOT be batched with mail calls. RFC 8620 §3.3 rejects a request whose `using` set
 * names a capability the server does not support — as a REQUEST-level error, which takes every other
 * call in the batch down with it. `usingForMethods` adds the quota URN automatically, so a quota call
 * riding along with a mailbox sync would kill the sync on any server without quota support. Its own
 * request, always; and {@link serverSupportsQuota} is what keeps it from being sent at all.
 */

import type { Id, JmapClient, Quota, QuotaGetResponse } from '@waxwing/jmap'
import { Capabilities, hasCapability, Methods } from '@waxwing/jmap'
import type { JmapSession } from '../app/session/types'

export interface QuotaClient {
  list(signal?: AbortSignal): Promise<Quota[]>
}

export function makeQuotaClient(client: JmapClient, accountId: Id): QuotaClient {
  return {
    async list(signal) {
      // `client.call` rather than the fluent builder: only it takes an AbortSignal, and a settings
      // screen the user navigates away from must not leave a request running.
      const responses = await client.call(
        [[Methods.quotaGet.name, { accountId, ids: null }, 'q0']],
        signal ? { signal } : {},
      )
      return responses.get<QuotaGetResponse>('q0').list
    },
  }
}

/** Does this server offer RFC 9425 quotas for this account? */
export function serverSupportsQuota(
  session: JmapSession | null,
  accountId: string | null,
): boolean {
  if (session === null || accountId === null) return false
  return hasCapability(session, Capabilities.quota, accountId)
}
