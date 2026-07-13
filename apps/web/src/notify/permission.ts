/**
 * The Notification permission (M3.6) — the browser seam, isolated so everything above it is pure and
 * jsdom (which has no `Notification` at all) can test the rest without a shim.
 *
 * **`requestPermission()` is called from exactly ONE place: the settings master switch's click.**
 * Never on load, never from an effect. Chrome and Firefox auto-deny a prompt that did not follow a
 * user gesture, and that denial is not a "not now" — it is a `denied` that sticks to the origin and
 * that no API can take back. An unsolicited prompt therefore does not merely annoy: it permanently
 * destroys the feature for that user.
 */

/** `unsupported` is a fourth state the DOM does not have — a browser with no Notification API at all. */
export type NotificationPermissionState = 'unsupported' | 'default' | 'granted' | 'denied'

/**
 * The slice of the global `Notification` constructor we read. Injected in tests.
 *
 * `requestPermission` may return `undefined`, not just a promise: that is the legacy callback form,
 * which older Safari still uses. It is the reason the result is read back from `.permission` rather
 * than awaited from the return value.
 */
export interface NotificationApiLike {
  readonly permission: string
  requestPermission(): Promise<string> | undefined
}

function globalNotification(): NotificationApiLike | null {
  if (typeof window === 'undefined') return null
  const api = (window as { Notification?: unknown }).Notification
  if (typeof api !== 'function') return null
  return api as unknown as NotificationApiLike
}

export function notificationsSupported(): boolean {
  return globalNotification() !== null
}

function toState(value: unknown): NotificationPermissionState {
  return value === 'granted' || value === 'denied' ? value : 'default'
}

export function readPermission(
  api: NotificationApiLike | null = globalNotification(),
): NotificationPermissionState {
  if (api === null) return 'unsupported'
  return toState(api.permission)
}

/**
 * Ask — from a user gesture. The result is read back from `Notification.permission` rather than
 * trusted from the return value: the legacy callback form (older Safari) returns `undefined`, and a
 * client that believed that would treat every grant as a dismissal.
 */
export async function requestPermission(
  api: NotificationApiLike | null = globalNotification(),
): Promise<NotificationPermissionState> {
  if (api === null) return 'unsupported'
  try {
    await api.requestPermission()
  } catch {
    // A browser that rejects the request (an insecure context, a policy) has not granted anything.
  }
  return toState(api.permission)
}
