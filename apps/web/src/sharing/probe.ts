/**
 * Which shared accounts really have mail in them (the S-4 measurement, applied to the mail rail).
 *
 * ## The session lies, and it lies in the direction that shows a section for nothing
 *
 * `secondaryMailAccounts()` decides "this account has mail" from the account's OWN
 * `accountCapabilities` — the strictest test the session offers, and documented at length as such.
 * It is still not enough. **Measured against Stalwart v0.16.18 on 2026-08-21:** carol shared ONE
 * CALENDAR with alice and nothing else, and alice's session then listed carol's account with all
 * **seventeen** capabilities, `urn:ietf:params:jmap:mail` among them. The share made the whole
 * account visible; it did not make the mail in it readable.
 *
 * What the sidebar did with that is the defect: a labelled "carol@waxwing.test" section, a folder
 * tree that can never fill, and a sync engine started for an account every request to which comes
 * back `forbidden`.
 *
 * ## The fix is one extra round trip for the whole rail, and the server made it cheap
 *
 * Asking is unambiguous where the capability is not:
 * ```
 * Mailbox/get { accountId: "d", ids: [] } → error forbidden "You do not have access to account d"
 * ```
 * That is better than an empty list, which would also be the answer for "shared, but empty".
 *
 * And **`forbidden` is a LOCAL error**: measured, a batch of five calls of which three were refused
 * returned all five method responses. (Unlike `Principal/set` or an unknown `using` URN, either of
 * which takes the entire request down with HTTP 400 `notRequest` — see `packages/jmap`'s
 * `sharing.test.ts`.) So one call per account, all in ONE batch, settles the whole rail.
 *
 * `ids: []` rather than `ids: null`: the access check happens before the fetch — measured, an empty
 * id list is refused exactly the same way — so the probe costs the server nothing but the lookup.
 */

import type { Id, JmapClient } from '@waxwing/jmap'
import { Methods } from '@waxwing/jmap'

/** The probe's verdict for one account. */
export type MailAccess = 'granted' | 'denied'

/**
 * Which of `accountIds` answer `Mailbox/get` — one batch, one call each.
 *
 * A `granted` verdict means the server served a mailbox list for that account; `denied` means it
 * refused. Accounts the caller did not ask about are absent from the map.
 *
 * **A transport failure is not a denial.** If the request itself fails — offline, 500, an expired
 * token — this returns `granted` for everything, because the alternative is a sidebar that empties
 * itself the moment the network hiccups. The false positive it leaves behind is exactly today's
 * behaviour and is recoverable on the next probe; a false negative silently removes an account the
 * user was working in.
 */
export async function probeMailAccess(
  client: JmapClient,
  accountIds: readonly Id[],
): Promise<ReadonlyMap<Id, MailAccess>> {
  const verdicts = new Map<Id, MailAccess>()
  if (accountIds.length === 0) return verdicts

  const callIds = accountIds.map((accountId, index) => [`p${index}`, accountId] as const)
  try {
    const responses = await client.call(
      callIds.map(([callId, accountId]) => [
        Methods.mailboxGet.name,
        { accountId, ids: [], properties: ['id'] },
        callId,
      ]),
    )
    for (const [callId, accountId] of callIds) {
      // `get` throws on a method-level error; that throw IS the answer, and it is per call.
      try {
        responses.get(callId)
        verdicts.set(accountId, 'granted')
      } catch {
        verdicts.set(accountId, 'denied')
      }
    }
  } catch {
    for (const [, accountId] of callIds) verdicts.set(accountId, 'granted')
  }
  return verdicts
}

/**
 * The accounts a mail rail may show: the primary always, plus every shared account not yet PROVEN to
 * be mail-less.
 *
 * "Not yet proven" is the load-bearing word. A `verdicts` map that is empty — because the probe has
 * not answered — keeps everything, so the sidebar does not flicker an account out and back in on
 * every reconnect. Only an explicit `denied` removes one.
 */
export function accountsWithMail<A extends { readonly id: Id }>(
  accounts: readonly A[],
  primaryAccountId: Id,
  verdicts: ReadonlyMap<Id, MailAccess>,
): readonly A[] {
  return accounts.filter(
    (account) => account.id === primaryAccountId || verdicts.get(account.id) !== 'denied',
  )
}
