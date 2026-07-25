/**
 * Account selectors over a {@link ConnectedSession} (M4.4). The ConnectedSession-level counterpart
 * of `@waxwing/jmap`'s `secondaryMailAccounts(session, primaryId)`: where that operates on the raw
 * wire Session, these read the materialised `connected.accounts` list the {@link SessionProvider}
 * built. Kept as pure functions (no React) so the M4.4 Etappe 2/3 sync engine and sidebar can share
 * one definition of "the shared accounts" without recomputing it from the wire session.
 */

import type { MailAccount } from '@waxwing/jmap'
import type { ConnectedSession } from './types'

/**
 * The delegated/shared mail accounts of a connected session: every entry of
 * `connected.accounts` that is not the user's own account ({@link ConnectedSession.accountId}).
 * `connected.accounts` lists the own account first, so this is its tail; `[]` when the server
 * shares nothing.
 */
export function secondaryMailAccounts(connected: ConnectedSession): readonly MailAccount[] {
  return connected.accounts.filter((account) => account.id !== connected.accountId)
}
