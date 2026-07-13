/**
 * Notifications (M3.6, FR-NOTIF-03).
 *
 * System notifications sourced from the LIVE push channel — i.e. whenever the app is running,
 * including a backgrounded or minimised tab. Notifications while the app is fully CLOSED (Web Push,
 * FR-NOTIF-02) are **deferred**: no JMAP server can sign a browser push. See ADR-010; the reason is
 * upstream, not here, and `capability.ts` is what lets the UI say so honestly.
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
