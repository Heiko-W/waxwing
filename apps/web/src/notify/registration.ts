/**
 * How the page reaches a `ServiceWorkerRegistration` to show a notification through (M3.6).
 *
 * **It must be the registration — `new Notification()` is not a fallback.** Android Chrome throws
 * `TypeError: Illegal constructor` for the page-side constructor; a "graceful" fallback to it would
 * be a crash on the single most important platform for this feature. When there is no registration,
 * there is no notification, and that is the whole story.
 *
 * **There is no service worker under `pnpm dev`** (`devOptions.enabled: false` in pwa-options.ts, and
 * `useUpdatePrompt` only registers under `import.meta.env.PROD`), so notifications are inert in the
 * dev server. Verify them against a built bundle (`pnpm --filter @waxwing/web build && … preview`).
 * This is written down because the alternative is the next person losing an afternoon to it.
 */

import { getActiveSwRegistration } from '../pwa/register-sw'
import type { MailNotificationOptions } from './notify-model'

/** The slice of `ServiceWorkerRegistration` the notifier uses — a fake supplies it in tests. */
export interface ShowNotificationRegistration {
  showNotification(title: string, options?: MailNotificationOptions): Promise<void>
  getNotifications(filter?: { tag?: string }): Promise<{ close(): void }[]>
}

/** `serviceWorker.ready` never settles when nothing is registered, so it is never awaited unbounded. */
const READY_TIMEOUT_MS = 3000

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms)
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

/**
 * `showNotification()` rejects with a `TypeError` when the registration has **no active worker**, and
 * M3.5 publishes the registration the moment `register()` resolves — which is *before* the worker
 * activates. The published one is therefore only usable once `.active` is set; until then we fall
 * through to `navigator.serviceWorker.ready`, which by definition resolves with an ACTIVE worker.
 *
 * Getting this backwards is invisible: `notifier.ts` shows its banners under `Promise.allSettled`, so
 * the `TypeError` is swallowed and the first mail of a fresh session is simply never announced.
 */
function hasActiveWorker(registration: ServiceWorkerRegistration | null): boolean {
  return registration !== null && registration.active !== null
}

/**
 * The registration to show notifications through, or `null` when notifications are unavailable on
 * this page — in which case the caller shows nothing and does NOT reach for the `Notification`
 * constructor.
 */
export async function getNotificationRegistration(
  timeoutMs: number = READY_TIMEOUT_MS,
): Promise<ShowNotificationRegistration | null> {
  const published = getActiveSwRegistration()
  if (hasActiveWorker(published)) return published
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null
  try {
    return await withTimeout(navigator.serviceWorker.ready, timeoutMs)
  } catch {
    return null
  }
}

/**
 * Close every notification this app has on screen (M3.6, FR-AUTH-05).
 *
 * A notification is local data the app put on the OPERATING SYSTEM's screen, and the OS keeps it
 * there across sign-out, reload and browser restart. Without this, "sign out and delete local data"
 * wipes IndexedDB while three banners reading *"Alice Weber — Kündigung Arbeitsvertrag"* sit in the
 * notification centre for the next person at the machine — and clicking one still deep-links into the
 * previous user's mailbox. Never throws: a sign-out must complete regardless.
 */
export async function closeAllNotifications(): Promise<void> {
  try {
    const registration = await getNotificationRegistration()
    if (registration === null) return
    const shown = await registration.getNotifications()
    for (const notification of shown) notification.close()
  } catch {
    /* a sign-out is never blocked by the notification centre */
  }
}
