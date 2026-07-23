/**
 * The permission, as React state (M3.6; made SHARED in M4.0 after the B29 hand-check).
 *
 * It re-reads on `visibilitychange` and — where the browser has it — on the Permissions API's
 * `change` event, because the user can grant or revoke the permission in browser settings, in another
 * tab, entirely outside our knowledge. A section that showed a stale "blocked" note after the user had
 * just unblocked us would be worse than no note at all.
 *
 * **The state lives in `permission-store.ts`, not in a `useState` here, and that is a bug fix rather
 * than a refactor.** With one copy per caller, the settings screen could ask the browser and update
 * its own while `PushSubscriptionHost` — the component that actually subscribes — kept a stale
 * `default` and never subscribed. Permission granted, switch on, nothing happening, and no way to
 * see why. Both listeners below missed it: the tab never lost visibility, and Safari does not
 * deliver the Permissions API `change` event for `notifications` (see `permission.ts`).
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { type NotificationPermissionState, readPermission, requestPermission } from './permission'
import {
  getPermissionServerSnapshot,
  getPermissionSnapshot,
  publishPermission,
  refreshPermission,
  subscribeToPermission,
} from './permission-store'

export interface NotificationPermissionApi {
  readonly state: NotificationPermissionState
  /** Ask the browser. MUST be called from a user gesture — see `permission.ts`. */
  request(): Promise<NotificationPermissionState>
}

export interface NotificationPermissionDeps {
  readonly read?: () => NotificationPermissionState
  readonly ask?: () => Promise<NotificationPermissionState>
}

export function useNotificationPermission(
  deps: NotificationPermissionDeps = {},
): NotificationPermissionApi {
  const read = deps.read ?? readPermission
  const ask = deps.ask ?? requestPermission

  const state = useSyncExternalStore(
    subscribeToPermission,
    getPermissionSnapshot,
    getPermissionServerSnapshot,
  )

  useEffect(() => {
    const sync = (): void => refreshPermission(read)
    sync()

    const onVisible = (): void => {
      if (document.visibilityState === 'visible') sync()
    }
    document.addEventListener('visibilitychange', onVisible)

    // Safari has historically THROWN on the 'notifications' permission name rather than rejecting, so
    // this is wrapped rather than merely `.catch`ed. It is an enhancement, and NOT the guarantee —
    // the guarantee is that `request()` publishes the result directly, which is what the shared
    // store is for.
    let status: PermissionStatus | undefined
    try {
      void navigator.permissions
        ?.query({ name: 'notifications' as PermissionName })
        .then((result) => {
          status = result
          result.addEventListener('change', sync)
        })
        .catch(() => {})
    } catch {
      /* no Permissions API for this name */
    }

    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      status?.removeEventListener('change', sync)
    }
  }, [read])

  const request = useCallback(async (): Promise<NotificationPermissionState> => {
    const next = await ask()
    // Publish rather than set local state: every other reader — above all the subscribe host — has
    // to learn about the grant in the same commit, not on the next visibility change that may never
    // come.
    publishPermission(next)
    return next
  }, [ask])

  return { state, request }
}
