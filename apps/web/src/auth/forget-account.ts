/**
 * Removing one account without touching the others (M5.10, FR-AUTH-07).
 *
 * Both halves of the wipe already existed before multi-account did — ADR-004 gave the auth layer a
 * per-scope `deleteDatabase`, and ADR-008 gave the replica `clearAccount` over the shared database.
 * What was missing is that they have to happen TOGETHER, and in this order.
 *
 * **Credentials first.** If the replica is cleared and the secret wipe then fails — a frozen tab
 * blocking `deleteDatabase` is the real case — the account is gone from view while its refresh
 * token is still on disk, decryptable by any later page on this origin. Doing it the other way
 * round leaves at worst some cached mail with no way to reach the server, which is inert.
 *
 * A failure therefore propagates rather than being swallowed: "signed out" is a claim that has to
 * be true.
 */

import type { Id } from '@waxwing/jmap'
import { clearAccount, type ReplicaDb } from '../sync/db'
import { SecretStore } from './secret-store'

export interface ForgetAccountOptions {
  /** The auth storage scope (ADR-004) — the `waxwing-auth-<scope>` database to delete. */
  readonly scope: string
  /** The JMAP account id whose replica rows go with it. */
  readonly accountId: Id
  readonly db: ReplicaDb
  /** Injected in tests. */
  readonly store?: SecretStore
}

/**
 * Deletes one account's credentials and cached data.
 *
 * Throws if the credential wipe fails, and does NOT clear the replica in that case: reporting a
 * sign-out that did not happen is worse than leaving the cached mail in place.
 */
export async function forgetAccount(options: ForgetAccountOptions): Promise<void> {
  const store = options.store ?? new SecretStore({ scope: options.scope })
  // Credentials first — see the note above.
  await store.wipe()
  await clearAccount(options.db, options.accountId)
}
