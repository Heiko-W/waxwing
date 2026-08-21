/**
 * Notifications (M3.6, FR-NOTIF-03).
 *
 * Two transports, one policy layer. The LIVE push channel raises the rich banner — sender, subject,
 * per-folder filtering — whenever the app is running, a backgrounded or minimised tab included.
 * **Web Push (FR-NOTIF-02) covers the app being fully CLOSED.** It said that mail had arrived and
 * nothing more, because a JMAP `StateChange` carries no sender and no subject and fetching them
 * would have needed an authenticated call from the service worker (M4.0, owner decision D6a,
 * ADR-017). Since the amendment of 2026-08-21 it names the sender and the subject **when the server
 * offers `draft-ietf-jmap-emailpush-03` and the user's preview toggle is on** — the data rides in
 * the push, so the worker still asks nobody for anything. `capability.ts` probes the live session
 * for both URNs so the settings state which of the three shapes applies rather than hardcoding one.
 *
 * **Four modules here are deliberately NOT re-exported from this barrel** — `click-route.ts`,
 * `push-frame.ts`, `push-store.ts` and `quiet-hours.ts`. All four are imported by the service
 * worker, which compiles under `lib: WebWorker` and must never reach the React/Dexie modules this
 * barrel pulls in; the worker imports them by module path. `push-subscribe.ts` is left out for the
 * opposite reason: it is the page-side half, and keeping it off the barrel makes an accidental
 * import from worker-adjacent code visible in review.
 */

export {
  serverSupportsBackgroundPush,
  serverSupportsEmailPush,
  useBackgroundPushSupport,
  useEmailPushSupport,
} from './capability'
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
export { applyAppBadge, badgingSupported, useAppBadge } from './use-app-badge'
export { useNotificationClickNavigation } from './use-notification-click'
export {
  type NotificationPermissionApi,
  useNotificationPermission,
} from './use-notification-permission'
export { PushSubscriptionHost } from './use-push-subscription'
