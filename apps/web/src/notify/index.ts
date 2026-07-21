/**
 * Notifications (M3.6, FR-NOTIF-03).
 *
 * System notifications sourced from the LIVE push channel — i.e. whenever the app is running,
 * including a backgrounded or minimised tab. Notifications while the app is fully CLOSED (Web Push,
 * FR-NOTIF-02) are **deferred** — and since 2026-07-20 the reason is ours, not upstream's. Stalwart
 * v0.16.14 ships RFC 9749 and auto-generates a VAPID keypair, so a server that can sign a browser
 * push now exists; Waxwing's client half (subscribe, `PushSubscription/set`, a `push` listener) was
 * never built, and reversing ADR-010 is an open owner decision. `capability.ts` probes the live
 * session so the UI states which of those two is true instead of hardcoding either.
 *
 * `click-route.ts` is deliberately NOT re-exported from this barrel: it is imported by the service
 * worker, which compiles under `lib: WebWorker` and must never reach the React/Dexie modules this
 * barrel pulls in. The worker imports it by its module path.
 */

export { serverSupportsBackgroundPush, useBackgroundPushSupport } from './capability'
export { createMailNotifier, type MailNotifierDeps, type NotifyNewMail } from './notifier'
export {
  buildMailNotification,
  buildSummaryNotification,
  coerceNotificationPrefs,
  DEFAULT_NOTIFICATION_PREFS,
  DEFAULT_QUIET_HOURS,
  inQuietHours,
  localMinutesOfDay,
  minutesToTimeValue,
  NOTIFY_BURST_CAP,
  NOTIFY_PREF_KEY,
  type NotificationPrefs,
  type QuietHours,
  selectNotifiable,
  shouldNotify,
  timeValueToMinutes,
} from './notify-model'
export {
  type NotificationApiLike,
  type NotificationPermissionState,
  notificationsSupported,
  readPermission,
  requestPermission,
} from './permission'
export { closeAllNotifications, getNotificationRegistration } from './registration'
export { useNotificationClickNavigation } from './use-notification-click'
export {
  type NotificationPermissionApi,
  useNotificationPermission,
} from './use-notification-permission'
