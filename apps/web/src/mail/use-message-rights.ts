/**
 * The React seam over {@link messageRights} (M4.4, defect B34) — the ONE way a write surface learns
 * whether it may act, and what to say when it may not.
 *
 * WHY THE GATE IS NOT INSIDE `useMessageActions`. That hook's handlers receive ids and hold no
 * subscription over the rows behind them, so a check there could only be stale or asynchronous — and
 * by then the damage is done: the control has already been offered. The UI needs the verdict at
 * RENDER time, because refusing well means saying why, next to the control, before it is pressed.
 * `useMessageActions` therefore stays a pure dispatch seam, and any new write surface pairs it with
 * one of the hooks here.
 *
 * Both hooks read the ACTING account — the one the enclosing `ReplicaProvider` names (M4.4 stage 4) —
 * so rights and dispatch can never disagree about which account they are talking about. Outside a
 * provider (component tests) they degrade to {@link ALL_GRANTED}, which is what the single-account
 * world has always effectively been.
 */

import type { Id } from '@waxwing/jmap'
import { useMemo } from 'react'
import { useSessionOptional } from '../app/session/context'
import { type EmailRow, type MailboxRow, useEmailWindow, useMailboxes } from '../sync'
import { useReplicaOptional } from '../sync/react'
import { ALL_GRANTED, type MessageRights, messageRights } from './rights'

/**
 * `MailAccount.isReadOnly` for the acting account (RFC 8620 §2). Context reads only — no query.
 *
 * Weak by nature: Stalwart reports `false` even for a share granting nothing but read (verified
 * against the live fixture), so this can refuse but never permit. The per-mailbox `myRights` carry
 * the real answer, which is why {@link messageRights} ANDs this in rather than branching on it.
 */
export function useAccountIsReadOnly(): boolean {
  const connected = useSessionOptional()
  const accountId = useReplicaOptional()?.accountId
  if (connected === null || accountId === undefined) return false
  // `accounts` is optional-by-shape here: component tests provide a partial connected session.
  return connected.accounts?.find((account) => account.id === accountId)?.isReadOnly ?? false
}

/**
 * Rights for subjects the caller ALREADY subscribes to — adds no query of its own.
 *
 * `mailboxes` is optional so a caller that already holds the account's mailboxes (the list, the
 * folder tree) can hand them over instead of opening a second identical liveQuery.
 */
export function useMessageRightsFor(
  rows: readonly (EmailRow | undefined)[] | undefined,
  total: number,
  mailboxes?: readonly MailboxRow[] | undefined,
): MessageRights {
  const ownMailboxes = useMailboxes()
  const inProvider = useReplicaOptional() !== null
  const accountReadOnly = useAccountIsReadOnly()
  const effective = mailboxes ?? ownMailboxes

  return useMemo(
    () =>
      inProvider
        ? messageRights({ rows, total, mailboxes: effective, accountReadOnly })
        : ALL_GRANTED,
    [inProvider, rows, total, effective, accountReadOnly],
  )
}

/** Rights for subjects the caller knows only by id — it subscribes to their rows itself. */
export function useMessageRights(ids: readonly Id[]): MessageRights {
  const idList = useMemo(() => [...ids], [ids])
  const rows = useEmailWindow(idList)
  return useMessageRightsFor(rows, idList.length)
}
