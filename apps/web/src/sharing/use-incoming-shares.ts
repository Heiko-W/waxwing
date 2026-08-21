/**
 * The two hooks the mail rail needs from the sharing layer (S-1, S-4).
 *
 * Both do the same shape of work — one JMAP call whose answer decides what the sidebar renders —
 * and both hold to the same rule: **a failure changes nothing on screen.** An account is only
 * removed when the server has explicitly refused it, and a notification card only appears when the
 * server has explicitly sent one. Anything else (offline, a 500, a token about to be refreshed)
 * leaves the rail exactly as it was.
 */

import type { Id, MailAccount } from '@waxwing/jmap'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSessionOptional } from '../app/session/context'
import { useEngineStatus } from '../sync/engine/status'
import {
  byNewestFirst,
  describeShare,
  makeIncomingSharesClient,
  type ShareAnnouncement,
} from './incoming'
import { accountsWithMail, type MailAccess, probeMailAccess } from './probe'

/**
 * `accounts`, minus every shared account the server refuses `Mailbox/get` on.
 *
 * See `probe.ts` for why the session's own capability list cannot answer this: a single shared
 * CALENDAR makes an account advertise `urn:ietf:params:jmap:mail` (measured), and the rail then grew
 * a labelled section for an account with no reachable mail in it.
 */
export function useMailAccounts(
  accounts: readonly MailAccount[],
  primaryAccountId: Id,
): readonly MailAccount[] {
  const connected = useSessionOptional()
  const [verdicts, setVerdicts] = useState<ReadonlyMap<Id, MailAccess>>(new Map())

  // The ids, as a stable string: `accounts` is a fresh array on every session render, and probing
  // once per render would be one round trip per keystroke elsewhere in the app.
  const sharedIds = accounts
    .filter((account) => account.id !== primaryAccountId)
    .map((account) => account.id)
  const key = sharedIds.join(',')

  useEffect(() => {
    if (connected === null || key === '') {
      setVerdicts(new Map())
      return
    }
    let cancelled = false
    void (async () => {
      const result = await probeMailAccess(connected.client, key.split(','))
      if (!cancelled) setVerdicts(result)
    })()
    return () => {
      cancelled = true
    }
  }, [connected, key])

  return useMemo(
    () => accountsWithMail(accounts, primaryAccountId, verdicts),
    [accounts, primaryAccountId, verdicts],
  )
}

/** What {@link useIncomingShares} hands the card strip. */
export interface IncomingShares {
  readonly announcements: readonly ShareAnnouncement[]
  /** Destroys the notification server-side, so it stays gone on every device. */
  dismiss: (id: Id) => void
}

const EMPTY: readonly ShareAnnouncement[] = []

/**
 * Outstanding `ShareNotification`s for the user's own account, newest first.
 *
 * **Re-fetched on the engine's sync tick rather than on a timer, and that is the measurement
 * paying off.** Stalwart v0.16.18 emits a `StateChange` carrying a `ShareNotification` type the
 * moment someone shares something (measured over a WebSocket:
 * `{"changed":{"b":{"ShareNotification":"…"}}}`), and the engine's push channel now subscribes to
 * that type — so the sync it triggers is the signal, arriving in seconds and costing nothing while
 * nothing happens. A poll would have been the fallback if the answer had gone the other way.
 *
 * `lastSyncedAt` is the tick: it is broadcast across tabs with the rest of the engine status, so a
 * share that arrives while this tab is in the background still lands.
 */
export function useIncomingShares(objectType: string): IncomingShares {
  const connected = useSessionOptional()
  const status = useEngineStatus()
  const [announcements, setAnnouncements] = useState<readonly ShareAnnouncement[]>(EMPTY)

  const accountId = connected?.accountId ?? null
  const client = useMemo(
    () =>
      connected === null || accountId === null
        ? null
        : makeIncomingSharesClient(connected.client, accountId),
    [connected, accountId],
  )

  // Account id → name, so a card can say WHOSE folder this is. The session is the reliable source;
  // `changedBy` is not (see `incoming.ts`).
  const namesByAccount = useMemo(() => {
    const map = new Map<Id, string>()
    for (const account of connected?.accounts ?? []) map.set(account.id, account.name)
    return map
  }, [connected])

  /*
   * `lastSyncedAt` is a TRIGGER, not an input: the effect below re-runs when it changes and never
   * reads it. Named here rather than inlined so the dependency list says what it is watching.
   */
  const syncedAt = status.lastSyncedAt

  // biome-ignore lint/correctness/useExhaustiveDependencies: `syncedAt` is the intended re-fetch trigger — the engine stamps it on every completed sync, and a share notification is what causes one.
  useEffect(() => {
    if (client === null) return
    let cancelled = false
    void (async () => {
      try {
        const list = await client.list()
        if (cancelled) return
        setAnnouncements(
          list
            .filter((notification) => notification.objectType === objectType)
            .map((notification) =>
              describeShare(notification, namesByAccount.get(notification.objectAccountId) ?? null),
            )
            .sort(byNewestFirst),
        )
      } catch {
        // Deliberately silent, and deliberately NOT `setAnnouncements([])`: a failed fetch is not
        // "nothing was shared with you". The strip keeps showing whatever it last knew.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [client, objectType, namesByAccount, syncedAt])

  const dismiss = useCallback(
    (id: Id) => {
      // Optimistic: the card goes now. A destroy that fails leaves the notification on the server,
      // so the next sync brings the card back — which is the honest outcome and needs no error
      // surface of its own.
      setAnnouncements((current) => current.filter((entry) => entry.id !== id))
      void client?.dismiss([id]).catch(() => {})
    },
    [client],
  )

  return { announcements, dismiss }
}
