/**
 * Keeps the Web Push subscription in step with what the user asked for (M4.0, FR-NOTIF-02).
 *
 * Mounted inside the connected shell, beside the sync engine. It runs on every start, which is not
 * an optimisation but the mechanism: Stalwart grants a subscription **seven days at a time and
 * refuses to grant more** (measured — a 90-day request returns seven), and only a running client can
 * renew. A user who opens the app once a week stays covered; one who does not, does not, and the
 * settings copy says so rather than letting it lapse in silence (ADR-017).
 *
 * The state it reconciles has three inputs, and two of them can change without us being told:
 *  - the master switch (`localPrefs`), which the settings screen writes,
 *  - the browser's Notification permission, which the user can revoke in site settings at any time,
 *  - whether the server advertises RFC 9749 at all, which follows the session.
 * Any of them going false must TEAR THE SUBSCRIPTION DOWN, not merely stop creating one: a server
 * still pushing to an endpoint after the user switched notifications off is the same broken promise
 * as one that never pushes, only louder.
 */

import { type ReactNode, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useConfig } from '../app/config-context'
import { useSession } from '../app/session/context'
import { useLocalPref } from '../sync'
import { useBackgroundPushSupport } from './capability'
import {
  coerceNotificationPrefs,
  DEFAULT_NOTIFICATION_PREFS,
  NOTIFY_PREF_KEY,
} from './notify-model'
import { isPushVerificationMessage } from './push-frame'
import { reconcilePushSubscription } from './push-reconcile'
import { clearPendingVerification } from './push-store'
import { submitPushVerification } from './push-subscribe'
import { getPushRegistration } from './registration'
import { useNotificationPermission } from './use-notification-permission'

/** The SW-cached branding icon, the same asset the live channel uses (M3.5's `BRANDING_FILES`). */
const ICON_FILE = 'branding/icon-192.png'

/**
 * Reconcile on every change of intent, and complete any verification the worker parked.
 *
 * It renders its children and nothing of its own. Failures are deliberately not surfaced as UI:
 * "we could not subscribe" is indistinguishable, to a reader, from "your browser said no", and the
 * settings screen already states what background push can and cannot do. What must never happen is
 * a *claim* that it works — that is why the settings string is driven by the capability probe and
 * not by this component's outcome.
 */
export function PushSubscriptionHost({ children }: { children?: ReactNode }): ReactNode {
  const { connected } = useSession()
  const config = useConfig()
  const { t } = useTranslation()
  const permission = useNotificationPermission()
  const serverSupports = useBackgroundPushSupport()
  const stored = useLocalPref<unknown>(NOTIFY_PREF_KEY)

  const prefs = stored === undefined ? DEFAULT_NOTIFICATION_PREFS : coerceNotificationPrefs(stored)
  const productName = config.branding.productName
  const client = connected?.client ?? null
  const session = connected?.client.session ?? null

  const wanted =
    prefs.enabled && permission.state === 'granted' && serverSupports && client !== null

  // Each of these travels INTO the worker's handover record, so a change to any of them has to
  // rewrite it. They are listed as individual dependencies rather than as `prefs`, which is a fresh
  // object on every liveQuery emission and would re-run this effect on every unrelated sync.
  const quietFrom = prefs.quietHours?.fromMinutes ?? null
  const quietTo = prefs.quietHours?.toMinutes ?? null
  const sound = prefs.sound

  useEffect(() => {
    let cancelled = false

    void (async () => {
      const registration = await getPushRegistration()
      if (cancelled) return
      await reconcilePushSubscription({
        registration,
        client,
        session,
        wanted,
        // Exactly what the live channel says with preview OFF. A closed-app banner is contentless by
        // construction (ADR-017), so both paths use one wording — there is nothing here to drift.
        title: productName,
        body: t('notify.body.generic'),
        iconUrl: new URL(ICON_FILE, document.baseURI).href,
        badgeUrl: new URL(ICON_FILE, document.baseURI).href,
        quietHours:
          quietFrom === null || quietTo === null
            ? null
            : { fromMinutes: quietFrom, toMinutes: quietTo },
        sound,
      })
    })()

    // `cancelled` guards only the step BEFORE the pass, deliberately. Once reconciliation has begun
    // it must finish: it is a sequence of server writes, and abandoning it halfway is how a
    // subscription ends up existing on one side and not the other. Unmounting a host is not a reason
    // to leave the server pushing to an endpoint we just replaced.
    return () => {
      cancelled = true
    }
    // `t` carries the LANGUAGE dependency, and that is load-bearing: the worker renders strings it
    // cannot translate, so switching language has to rewrite the handover record. react-i18next
    // hands back a new `t` on `languageChanged`, which is what re-runs this. A test pins it, because
    // if that ever stopped holding the symptom would be a German user getting English banners with
    // nothing anywhere to explain why.
  }, [wanted, client, session, productName, t, quietFrom, quietTo, sound])

  // The worker relays a verification code the moment it arrives — the fast path, which saves a
  // reload. It is NOT the reliable one: the worker also parks every code in `waxwing-push`, and the
  // reconcile pass above picks it up. Both exist because a `postMessage` can arrive before this
  // listener is attached, and that is exactly what happened on the first hand-check.
  useEffect(() => {
    if (client === null) return
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
    const listeners = new AbortController()
    navigator.serviceWorker.addEventListener(
      'message',
      (event: MessageEvent) => {
        const data: unknown = event.data
        if (!isPushVerificationMessage(data)) return
        void submitPushVerification(client, data.pushSubscriptionId, data.verificationCode).then(
          (accepted) => (accepted ? clearPendingVerification() : undefined),
        )
      },
      { signal: listeners.signal },
    )
    // **Mandatory with `addEventListener`, and easy to miss.** A ServiceWorkerContainer only starts
    // dispatching messages once `onmessage` is assigned OR `startMessages()` is called; anything the
    // worker posted before that sits in a queue that is never drained. Assigning `onmessage` would
    // have hidden the problem — and would also have clobbered any other listener on the container.
    navigator.serviceWorker.startMessages()
    return () => {
      listeners.abort()
    }
  }, [client])

  return children
}
