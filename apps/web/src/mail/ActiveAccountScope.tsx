/**
 * The acting-account boundary (M4.4 Etappe 4).
 *
 * PASS-THROUGH with nothing shared: no extra provider, not even an extra element, so the
 * single-account tree is byte-for-byte the pre-M4.4 one — the same discipline {@link AccountTrees}
 * and {@link MailScreen} already keep, and their tests pin.
 *
 * With ≥1 delegated account it is a nested {@link ReplicaProvider} on the ACTIVE account, and inside
 * it every mailbox lookup, every email id and every engine handle resolves to the account the user is
 * acting in. The split is deliberate and worth stating, because getting a surface on the wrong side
 * of it is how the cross-account write comes back:
 *
 *  - INSIDE — anything that reads mailbox ids, email ids, or an engine for the acting account: the
 *    list and reading panes, and the keyboard layer (`ShortcutProvider`, which pairs role mailbox ids
 *    with the active list's selection).
 *  - OUTSIDE — anything device- or identity-global: the composer (there is no send-as from a
 *    delegated account yet, so a draft must stay on the user's own identity), contacts, the quota
 *    bar, the sync status badge, `QueuedSends`, and the conflict notifier.
 *
 * Kept a separate file from `active-account.ts` so that module stays React-free and pure-testable.
 */

import type { ReactNode } from 'react'
import { secondaryMailAccounts } from '../app/session/accounts'
import { useSessionOptional } from '../app/session/context'
import { ReplicaProvider, useReplicaOptional } from '../sync'
import { useActiveMailAccountId } from './active-account'

export function ActiveAccountScope({ children }: { children: ReactNode }): ReactNode {
  const connected = useSessionOptional()
  const replica = useReplicaOptional()
  const activeAccountId = useActiveMailAccountId()

  if (connected === null || replica === null || activeAccountId === null) return children
  // Nothing shared ⇒ the active account IS the primary and a second provider would only add a
  // re-render boundary. Pass through, and the single-account path stays exactly today's.
  if (secondaryMailAccounts(connected).length === 0) return children

  return (
    <ReplicaProvider accountId={activeAccountId} db={replica.db}>
      {children}
    </ReplicaProvider>
  )
}
