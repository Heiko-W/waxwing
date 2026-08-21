/**
 * Which shared accounts really have mail, contacts or files in them (the S-4 measurement).
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
 *
 * ## The same question, for the other two areas (S-4, measured 2026-08-21)
 *
 * Mail is not special. Re-measured against the same fixture, in both directions, with exactly one
 * object shared:
 * ```
 * # alice shares nothing with carol; carol asks about account b
 * AddressBook/get {ids:[]}  → forbidden        FileNode/get {ids:[]}  → forbidden
 * Mailbox/get    {ids:[]}   → forbidden        FileNode/query          → forbidden
 *
 * # alice shares ONE ADDRESS BOOK with carol; carol asks again, same batch
 * AddressBook/get {ids:[]}  → { list: [] }     FileNode/get {ids:[]}  → forbidden
 * Mailbox/get    {ids:[]}   → forbidden        FileNode/query          → forbidden
 * ```
 * So the probe generalises without qualification: one `Foo/get` with an EMPTY id list per area,
 * per account, all in one batch. `FileNode/get` and `FileNode/query` were measured to agree in
 * every observed state, and `/get` is chosen so all three areas send the same shape.
 *
 * **One known lag, and it is the server's:** revoking the last share of an area leaves that area
 * answering for a while (measured — destroying the only shared `FileNode` left `FileNode/query`
 * answering an empty list rather than `forbidden`). The failure mode is an empty section, never a
 * wrong one, and it settles by itself.
 */

import type { Id, JmapClient } from '@waxwing/jmap'
import { Methods } from '@waxwing/jmap'

/** The probe's verdict for one account (in one area). */
export type MailAccess = 'granted' | 'denied'

/**
 * A kind of shared content this client can open. `calendar` is deliberately absent: the calendar
 * rail is a package of its own, and an area nothing renders would be a promise in a type.
 */
export type ShareArea = 'mail' | 'contacts' | 'files'

/** Every area the probe asks about by default, in rail order. */
export const SHARE_AREAS: readonly ShareArea[] = ['mail', 'contacts', 'files']

/**
 * The method whose refusal is the answer, per area.
 *
 * All three are a `/get` with an empty id list, because all three were measured to refuse that
 * exactly as they refuse a real fetch — see the module header.
 */
const AREA_METHOD: Readonly<Record<ShareArea, string>> = {
  mail: Methods.mailboxGet.name,
  contacts: Methods.addressBookGet.name,
  files: Methods.fileNodeGet.name,
}

/** One account's verdict in every probed area. */
export type AreaAccess = Readonly<Record<ShareArea, MailAccess>>

const ALL_GRANTED: AreaAccess = { mail: 'granted', contacts: 'granted', files: 'granted' }

/** The optimistic default — see {@link probeSharedAreas} on why a failure grants rather than denies. */
export function grantedEverywhere(): AreaAccess {
  return ALL_GRANTED
}

/**
 * Which of `accountIds` will serve which `areas` — ONE batch, one call per account and area.
 *
 * A `granted` verdict means the server answered that area's `/get` for that account; `denied` means
 * it refused. Accounts the caller did not ask about are absent from the map. An area not probed is
 * reported `granted`, because "not asked" is not evidence of anything.
 *
 * **A transport failure is not a denial.** If the request itself fails — offline, 500, an expired
 * token — this returns `granted` for everything, because the alternative is a sidebar that empties
 * itself the moment the network hiccups. The false positive it leaves behind is exactly today's
 * behaviour and is recoverable on the next probe; a false negative silently removes an account the
 * user was working in.
 */
export async function probeSharedAreas(
  client: JmapClient,
  accountIds: readonly Id[],
  areas: readonly ShareArea[] = SHARE_AREAS,
): Promise<ReadonlyMap<Id, AreaAccess>> {
  const verdicts = new Map<Id, AreaAccess>()
  if (accountIds.length === 0 || areas.length === 0) return verdicts

  const calls = accountIds.flatMap((accountId, accountIndex) =>
    areas.map((area, areaIndex) => ({
      callId: `p${accountIndex}_${areaIndex}`,
      accountId,
      area,
    })),
  )
  try {
    const responses = await client.call(
      calls.map(({ callId, accountId, area }) => [
        AREA_METHOD[area],
        { accountId, ids: [], properties: ['id'] },
        callId,
      ]),
    )
    for (const accountId of accountIds) verdicts.set(accountId, { ...ALL_GRANTED })
    for (const { callId, accountId, area } of calls) {
      // `get` throws on a method-level error; that throw IS the answer, and it is per call.
      let access: MailAccess
      try {
        responses.get(callId)
        access = 'granted'
      } catch {
        access = 'denied'
      }
      verdicts.set(accountId, { ...(verdicts.get(accountId) ?? ALL_GRANTED), [area]: access })
    }
  } catch {
    for (const accountId of accountIds) verdicts.set(accountId, ALL_GRANTED)
  }
  return verdicts
}

/**
 * Which of `accountIds` answer `Mailbox/get` — the mail-only shorthand over
 * {@link probeSharedAreas}, kept because "does this account have mail" is asked on its own.
 */
export async function probeMailAccess(
  client: JmapClient,
  accountIds: readonly Id[],
): Promise<ReadonlyMap<Id, MailAccess>> {
  const areas = await probeSharedAreas(client, accountIds, ['mail'])
  return new Map([...areas].map(([accountId, access]) => [accountId, access.mail]))
}

/**
 * The accounts a rail may show in `area`: the primary always, plus every shared account not yet
 * PROVEN to lack it.
 *
 * "Not yet proven" is the load-bearing word. A `verdicts` map that is empty — because the probe has
 * not answered — keeps everything, so a rail does not flicker an account out and back in on every
 * reconnect. Only an explicit `denied` removes one.
 */
export function accountsWithArea<A extends { readonly id: Id }>(
  accounts: readonly A[],
  primaryAccountId: Id,
  area: ShareArea,
  verdicts: ReadonlyMap<Id, AreaAccess>,
): readonly A[] {
  return accounts.filter(
    (account) =>
      account.id === primaryAccountId || verdicts.get(account.id)?.[area] !== ('denied' as const),
  )
}
