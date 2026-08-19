/**
 * The unread badge on the installed app icon (FR-NOTIF-04, Badging API).
 *
 * Deliberately narrow: **the Inbox's unread count, and nothing else.** A badge is one number on one
 * icon, so it has to mean one thing, and "unread mail waiting for you" is the only reading a user
 * will assume. Summing every folder would count Junk and Archive; summing every account would make
 * the number depend on a delegation the reader may not think of as theirs.
 *
 * Three failure modes this file exists to avoid:
 *
 * - **Clearing the badge on every start.** `useLocalPref` yields `undefined` for a tick before the
 *   stored preferences arrive, which collapses to "notifications off" (defect B29). A badge that
 *   reacted to that would blink off on every launch, so nothing is written until the preferences
 *   have actually loaded.
 * - **Writing a badge the user did not ask for.** It follows the notifications master switch: a
 *   reader who turned notifications off did not ask to be counted at either.
 * - **Assuming the API exists.** Badging is unimplemented on Firefox and on iOS Safari outside an
 *   installed PWA. Every call is guarded, and an unsupported browser simply gets nothing.
 */

import { useEffect, useRef } from 'react'
import { useLocalPrefOptional, useMailboxByRoleOptional } from '../sync'
import { coerceNotificationPrefs, NOTIFY_PREF_KEY } from './notify-model'

/**
 * The Badging API, which is not in `lib.dom`.
 *
 * Declared as optional members on a local type rather than by augmenting `Navigator` globally: this
 * is a capability we probe for, and a global augmentation would let any other file call it without
 * a guard.
 */
interface BadgingNavigator {
  setAppBadge?: (contents?: number) => Promise<void>
  clearAppBadge?: () => Promise<void>
}

/** Whether this browser implements the Badging API at all. */
export function badgingSupported(navigatorLike: BadgingNavigator = navigator): boolean {
  return typeof navigatorLike.setAppBadge === 'function'
}

/**
 * Applies `count` to the app icon. `0` clears it rather than showing a zero.
 *
 * Rejections are swallowed on purpose: the spec allows the platform to refuse (not installed, no
 * permission), and a badge that cannot be set is not a problem worth surfacing to a reader.
 */
export async function applyAppBadge(
  count: number,
  navigatorLike: BadgingNavigator = navigator,
): Promise<void> {
  try {
    if (count > 0) await navigatorLike.setAppBadge?.(count)
    else await navigatorLike.clearAppBadge?.()
  } catch {
    // Deliberately ignored — see above.
  }
}

export function useAppBadge(): void {
  const inbox = useMailboxByRoleOptional('inbox')
  const storedPrefs = useLocalPrefOptional<unknown>(NOTIFY_PREF_KEY)
  const lastWritten = useRef<number | null>(null)

  useEffect(() => {
    if (!badgingSupported()) return
    // `undefined` here means "preferences have not loaded yet", NOT "no preferences". Writing in
    // that window is what makes the badge flicker off on every launch.
    if (storedPrefs === undefined) return

    const prefs = coerceNotificationPrefs(storedPrefs)
    const unread = inbox?.unreadEmails ?? 0
    const target = prefs.enabled ? unread : 0

    // The count changes on every read; the badge only needs writing when the NUMBER changes.
    if (lastWritten.current === target) return
    lastWritten.current = target
    void applyAppBadge(target)
  }, [inbox?.unreadEmails, storedPrefs])
}
