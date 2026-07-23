/**
 * The Notification permission as ONE shared value (M4.0 fix), not one copy per component.
 *
 * **This exists because of a defect the B29 hand-check found on its first run.** The permission was
 * `useState` inside `useNotificationPermission`, so every caller had its own. The settings screen
 * asked the browser and updated ITS copy; `PushSubscriptionHost` — the component that actually
 * subscribes — kept its own, still `default`, and therefore never subscribed. The user granted
 * permission, the switch went on, and nothing happened, with nowhere to see why.
 *
 * The two escape hatches that were supposed to cover it both missed:
 *  - `visibilitychange` never fired, because the tab was visible the whole time; and
 *  - the Permissions API `change` event is exactly what `permission.ts` documents Safari as not
 *    delivering reliably for `notifications`. Safari is where it was found.
 *
 * The fix is not another listener. **The permission is a property of the browser, not of a
 * component**, so there is one store and every reader subscribes to it. A grant is published the
 * moment it is known — by whoever asked — and everyone sees the same value in the same commit.
 */

import type { NotificationPermissionState } from './permission'
import { readPermission } from './permission'

type Listener = () => void

const listeners = new Set<Listener>()
let current: NotificationPermissionState | null = null

/**
 * `useSyncExternalStore` requires a CACHED snapshot: returning a freshly computed value on every
 * call makes React re-render forever. So the browser is read once and the result memoised until
 * something says it changed.
 */
export function getPermissionSnapshot(): NotificationPermissionState {
  current ??= readPermission()
  return current
}

/** The server snapshot — jsdom and SSR have no Notification API at all. */
export function getPermissionServerSnapshot(): NotificationPermissionState {
  return 'unsupported'
}

export function subscribeToPermission(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Publish a new value to every reader. Called after `requestPermission()` resolves, and by the
 * re-read paths (visibility, Permissions API) — a no-op when nothing actually changed, so a
 * `visibilitychange` storm cannot cause a render storm.
 */
export function publishPermission(next: NotificationPermissionState): void {
  if (current === next) return
  current = next
  for (const listener of listeners) listener()
}

/** Re-read the browser and publish if it moved. */
export function refreshPermission(read: () => NotificationPermissionState = readPermission): void {
  publishPermission(read())
}

/** Test seam: forget the memoised snapshot and every listener. */
export function resetPermissionStore(): void {
  current = null
  listeners.clear()
}
