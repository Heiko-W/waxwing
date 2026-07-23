/**
 * Wires the {@link SyncEngine} into the connected shell (M1.3). Mounted inside the `ready` branch:
 * it starts the engine on connect, stops it on disconnect, and provides the {@link ReplicaProvider}
 * the feature panes read from. Where `Web Locks` are unavailable (older browsers, SSR, jsdom tests)
 * it degrades gracefully — the UI still reads the replica, sync just does not run.
 */

import { type ReactNode, useEffect, useSyncExternalStore } from 'react'
import { useConfig } from '../../app/config-context'
import { useSession } from '../../app/session/context'
import { createMailNotifier } from '../../notify/notifier'
import { PushSubscriptionHost } from '../../notify/use-push-subscription'
import { getReplica } from '../db'
import { ReplicaProvider } from '../react'
import {
  createSyncEngine,
  getActiveEngine,
  type SyncEngine,
  setActiveEngine,
  subscribeActiveEngine,
} from './engine'
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
    const engine = createSyncEngine({
      db: getReplica(),
      port: createJmapPort(connected.client, connected.accountId),
      session: connected.client.session,
      auth,
      config: { cacheDays, maxStorageMB },
      onAuthExpired: reportAuthExpired,
      // This is the one place that has the replica, the account and the branding at once — and the
      // engine is where the leader/first-pass/foreground guards live (M3.6).
      notify: createMailNotifier({
        db: getReplica(),
        accountId: connected.accountId,
        productName,
      }),
    })
    setActiveEngine(engine)
    engine.start()
    return () => {
      setActiveEngine(null)
      void engine.stop()
    }
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
