/**
 * Account selectors over a {@link ConnectedSession} (M4.4). The ConnectedSession-level counterpart
 * of `@waxwing/jmap`'s `secondaryMailAccounts(session, primaryId)`: where that operates on the raw
 * wire Session, these read the materialised `connected.accounts` list the {@link SessionProvider}
 * built. Kept as pure functions (no React) so the M4.4 Etappe 2/3 sync engine and sidebar can share
 * one definition of "the shared accounts" without recomputing it from the wire session.
 */

import type { Id, MailAccount } from '@waxwing/jmap'
import type { AreaAccess, ShareArea } from '../../sharing/probe'
import { grantedEverywhere } from '../../sharing/probe'
import type { ConnectedSession, DelegatedAccount } from './types'

/**
 * The delegated/shared mail accounts of a connected session: every entry of
 * `connected.accounts` that is not the user's own account ({@link ConnectedSession.accountId}).
 * `connected.accounts` lists the own account first, so this is its tail; `[]` when the server
 * shares nothing.
 */
export function secondaryMailAccounts(connected: ConnectedSession): readonly MailAccount[] {
  return connected.accounts.filter((account) => account.id !== connected.accountId)
}

/**
 * The delegated accounts whose `area` the server actually served (S-4) — what a rail lists as its
 * shared sections.
 *
 * `denied` is the ONLY thing that removes one. An account whose probe never answered (offline, a
 * 500) keeps every area, because a rail that empties itself on a network blip is worse than one
 * showing a section that turns out to be empty.
 */
export function delegatedAccountsFor(
  connected: ConnectedSession,
  area: ShareArea,
): readonly DelegatedAccount[] {
  return connected.delegated.filter((account) => account.areas[area] !== 'denied')
}

/**
 * The delegated accounts that serve NO mail but do serve contacts or a calendar (S-4).
 *
 * These are the accounts {@link secondaryMailAccounts} deliberately excludes — and excluding them
 * from the engine fleet is what made the S-4 rails draw a section that could never fill: the whole
 * client reads its PIM data out of the replica (K-8, M4.2), the replica is written by an engine,
 * and an account with no engine therefore shows an empty address-book list and a calendar that
 * spins for ever. Measured against the fixture before this existed: carol shares an address book,
 * `AddressBook/get` returns it to alice, and alice's rail says "No address books." indefinitely.
 *
 * They get an engine with its mail legs switched off ({@link FleetAccount.syncMail}), because
 * `Mailbox/get` on such an account answers `forbidden` — which fails the whole delta pass before it
 * reaches the contacts leg, which is the mechanism behind the empty rail.
 */
export function delegatedPimAccounts(connected: ConnectedSession): readonly DelegatedAccount[] {
  return connected.delegated.filter(
    (account) =>
      account.areas.mail === 'denied' &&
      (account.areas.contacts !== 'denied' || account.areas.calendar !== 'denied'),
  )
}

/**
 * Turn the session's ADVERTISED shared accounts plus the probe's verdicts into the two lists a
 * {@link ConnectedSession} carries: `accounts` (own + the ones with mail) and `delegated` (all of
 * them, each stamped with what it will serve).
 *
 * Pure, and separate from {@link SessionProvider} on purpose: the claim worth testing — "a shared
 * account with the full capability set and a `forbidden` on `Mailbox/get` never reaches the engine
 * fleet" — is a claim about this function, and the fleet reads `accounts` verbatim.
 *
 * A verdict missing from `verdicts` means the probe did not answer for that account, and is read as
 * {@link grantedEverywhere} for the same reason as above.
 */
export function deriveDelegation(
  own: MailAccount,
  advertised: readonly MailAccount[],
  verdicts: ReadonlyMap<Id, AreaAccess>,
): { readonly accounts: readonly MailAccount[]; readonly delegated: readonly DelegatedAccount[] } {
  const delegated: DelegatedAccount[] = advertised
    .filter((account) => account.id !== own.id)
    .map((account) => ({ ...account, areas: verdicts.get(account.id) ?? grantedEverywhere() }))
  return {
    accounts: [own, ...delegated.filter((account) => account.areas.mail !== 'denied')],
    delegated,
  }
}
