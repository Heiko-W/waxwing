/**
 * Wires the {@link SyncEngine} into the connected shell (M1.3). Mounted inside the `ready` branch:
 * it starts the engine on connect, stops it on disconnect, and provides the {@link ReplicaProvider}
 * the feature panes read from. Where `Web Locks` are unavailable (older browsers, SSR, jsdom tests)
 * it degrades gracefully — the UI still reads the replica, sync just does not run.
 */

import { createPushChannel } from '@waxwing/jmap'
import { type ReactNode, useEffect, useSyncExternalStore } from 'react'
import { useConfig } from '../../app/config-context'
import { secondaryMailAccounts } from '../../app/session/accounts'
import { useSession } from '../../app/session/context'
import type { ConnectedSession } from '../../app/session/types'
import { createMailNotifier } from '../../notify/notifier'
import { PushSubscriptionHost } from '../../notify/use-push-subscription'
import { getReplica } from '../db'
import { ReplicaProvider } from '../react'
import { upsertAccount } from '../repo'
import {
  createSyncEngine,
  getActiveEngine,
  type SyncEngine,
  setActiveEngine,
  subscribeActiveEngine,
} from './engine'
import { createPushMux, type EngineSpec, type FleetAccount, startEngineFleet } from './fleet'
import { createJmapPort } from './port'

/**
 * The running {@link SyncEngine} for this tab, or `null` before it starts (or where it cannot run).
 * Reactive: components re-render the moment {@link setActiveEngine} sets it, so a watch registered on
 * mount is not lost to the start-order race with {@link SyncEngineHost}.
 */
export function useActiveEngine(): SyncEngine | null {
  return useSyncExternalStore(subscribeActiveEngine, getActiveEngine, () => null)
}

/** True when the runtime primitives the single-writer engine needs are present. */
function canRunEngine(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.locks?.request === 'function' &&
    typeof BroadcastChannel !== 'undefined'
  )
}

/**
 * The mail accounts to run engines for: the user's own PRIMARY first, then every delegated/shared
 * account (M4.4). `[primary]` alone when the server shares nothing — the byte-for-byte single-account
 * case. The primary's display name comes off its own {@link MailAccount} entry, falling back to the
 * login username.
 */
function fleetAccounts(connected: ConnectedSession): FleetAccount[] {
  const primary = connected.accounts.find((account) => account.id === connected.accountId)
  return [
    { id: connected.accountId, name: primary?.name ?? connected.username, isPrimary: true },
    ...secondaryMailAccounts(connected).map((account) => ({
      id: account.id,
      name: account.name,
      isPrimary: false,
    })),
  ]
}

export function SyncEngineHost({ children }: { children: ReactNode }): ReactNode {
  const { connected, getAuthProvider, reportAuthExpired } = useSession()
  const config = useConfig()
  const cacheDays = config.offline.cacheDays
  const maxStorageMB = config.offline.maxStorageMB
  const productName = config.branding.productName

  useEffect(() => {
    if (!connected || !canRunEngine()) return
    const auth = getAuthProvider()
    if (!auth) return

    // One engine per mail account: the own PRIMARY plus every delegated/shared account (M4.4). The
    // account set is baked into `connected` at connect, so this effect's `connected` dependency IS the
    // 0→1→0 lifecycle: a session that gains/loses a share is a new `connected`, which tears the whole
    // fleet down and rebuilds it — no partial reconciliation to get wrong.
    const accounts = fleetAccounts(connected)

    const createEngine = (spec: EngineSpec): SyncEngine =>
      createSyncEngine({
        db: getReplica(),
        port: createJmapPort(connected.client, spec.account.id),
        session: connected.client.session,
        auth,
        config: { cacheDays, maxStorageMB },
        onAuthExpired: reportAuthExpired,
        // Only the PRIMARY notifies (M3.6): a background shared account must never raise banners, and
        // this is the one place that has the replica, the account and the branding at once.
        ...(spec.isPrimary
          ? {
              notify: createMailNotifier({
                db: getReplica(),
                accountId: spec.account.id,
                productName,
              }),
            }
          : {}),
        // The account-varying wiring the fleet resolved; each is omitted for the primary so its engine
        // stays byte-for-byte the pre-M4.4 one (bare lock, own SSE channel, real bus, global badge).
        ...(spec.lockName === undefined ? {} : { lockName: spec.lockName }),
        ...(spec.createBus === undefined ? {} : { createBus: spec.createBus }),
        ...(spec.createPush === undefined ? {} : { createPush: spec.createPush }),
        ...(spec.publishStatus === undefined ? {} : { publishStatus: spec.publishStatus }),
      })

    return startEngineFleet(accounts, {
      createEngine,
      createPushMux: () => createPushMux((session, options) => createPushChannel(session, options)),
      setActive: setActiveEngine,
      register: (account) => {
        const now = Date.now()
        void upsertAccount(getReplica(), {
          id: account.id,
          username: account.name,
          name: account.name,
          issuer: null,
          isPrimary: account.isPrimary,
          addedAt: now,
          lastSeenAt: now,
        })
      },
    })
  }, [connected, getAuthProvider, reportAuthExpired, cacheDays, maxStorageMB, productName])

  if (!connected) return children
  return (
    <ReplicaProvider accountId={connected.accountId} db={getReplica()}>
      {/* Inside the provider, because it reads the notification prefs from `localPrefs` (M4.0). It
          renders nothing of its own — it reconciles the Web Push subscription, which has to happen
          on every start: the server grants seven days at a time and only a running client renews. */}
      <PushSubscriptionHost>{children}</PushSubscriptionHost>
    </ReplicaProvider>
  )
}
