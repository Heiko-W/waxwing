/**
 * Where the sent copy of a message belongs (issue #101, ADR-049).
 *
 * A message is filed in the Sent folder of the address it was sent FROM. For an ordinary identity
 * that is the user's own Sent, and the send's `onSuccessUpdateEmail` puts it there. For an identity
 * whose address is a GROUP account the user can see (a shared `info@` mailbox), the copy belongs in
 * that account's Sent, so every member sees what went out under the shared address.
 *
 * The send itself stays in the user's own account — a group account's submission endpoint is closed
 * (ADR-020) — so this only names the folder a follow-up `Email/copy` moves the copy into.
 *
 * The match is the account NAME, which Stalwart sets to the group's primary address. Aliases of the
 * group (`postmaster@`, `abuse@` …) are not in the session and are not matched: those sends stay in
 * the personal Sent, as before.
 */

import type { Id, MailAccount } from '@waxwing/jmap'
import { mailboxByRole, type ReplicaDb } from '../sync'

export interface SentTarget {
  readonly accountId: Id
  readonly mailboxId: Id
}

/**
 * The other account's Sent folder this address belongs to, or `null` for "the user's own Sent".
 *
 * `null` whenever there is any doubt: no account carries the address, the account is read-only,
 * its Sent folder has not synced, or the user may not add to it. Each of those falls back to
 * today's behaviour instead of attempting a copy that could only fail.
 */
export async function sentTargetFor(
  db: ReplicaDb,
  accounts: readonly MailAccount[],
  ownAccountId: Id,
  fromEmail: string,
): Promise<SentTarget | null> {
  const address = fromEmail.trim().toLowerCase()
  const account = accounts.find(
    (candidate) =>
      candidate.id !== ownAccountId &&
      !candidate.isPersonal &&
      !candidate.isReadOnly &&
      candidate.name.trim().toLowerCase() === address,
  )
  if (account === undefined) return null
  const sent = await mailboxByRole(db, account.id, 'sent')
  if (sent === undefined || sent.myRights.mayAddItems !== true) return null
  return { accountId: account.id, mailboxId: sent.id }
}
