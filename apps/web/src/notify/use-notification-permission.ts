/**
 * The permission, as React state (M3.6).
 *
 * It re-reads on `visibilitychange` and — where the browser has it — on the Permissions API's
 * `change` event, because the user can grant or revoke the permission in browser settings, in another
 * tab, entirely outside our knowledge. A section that showed a stale "blocked" note after the user had
 * just unblocked us would be worse than no note at all.
 */

import { useCallback, useEffect, useState } from 'react'
import { type NotificationPermissionState, readPermission, requestPermission } from './permission'

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

  const [state, setState] = useState<NotificationPermissionState>(() => read())

  useEffect(() => {
    const sync = (): void => setState(read())
    sync()

    const onVisible = (): void => {
      if (document.visibilityState === 'visible') sync()
    }
    document.addEventListener('visibilitychange', onVisible)

    // Safari has historically THROWN on the 'notifications' permission name rather than rejecting, so
    // this is wrapped rather than merely `.catch`ed. It is an enhancement; visibilitychange is the
    // guarantee.
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
    setState(next)
    return next
  }, [ask])

  return { state, request }
}
