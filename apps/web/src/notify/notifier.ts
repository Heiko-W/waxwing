/**
 * The notifier (M3.6): the impure edge that turns a delta pass's newly created emails into system
 * notifications. Every policy question is answered in `notify-model.ts` (pure); every browser
 * touchpoint is an injectable dep, so the whole thing is testable in jsdom without a Notification API.
 *
 * It is handed to the sync engine as `SyncEngineDeps.notify` and called ONLY by the leader tab, never
 * on the first pass of a leadership session, and never while that tab is in the foreground. Those are
 * engine-session facts and the engine enforces them — see `engine.ts#raiseNewMailNotifications`.
 * This module assumes it is being called at a legitimate moment and decides only *which* mail, if
 * any, is worth a banner.
 */

import type { Id } from '@waxwing/jmap'
import type { EmailEnvelopeInput, ReplicaDb } from '../sync/db'
import { getPref } from '../sync/repo'
import {
  buildMailNotification,
  buildSummaryNotification,
  coerceNotificationPrefs,
  localMinutesOfDay,
  NOTIFY_BURST_CAP,
  NOTIFY_PREF_KEY,
  NOTIFY_WINDOW_MS,
  type NotificationContent,
  notifyMailboxId,
  selectNotifiable,
  type Translate,
} from './notify-model'
import { type NotificationPermissionState, readPermission } from './permission'
import { getNotificationRegistration, type ShowNotificationRegistration } from './registration'

/** What the engine calls. `created` is exactly what `Email/changes` reported as CREATED. */
export type NotifyNewMail = (
  created: readonly EmailEnvelopeInput[],
  ctx: { readonly now: number; readonly sinceMs: number },
) => Promise<void>

export interface MailNotifierDeps {
  readonly db: ReplicaDb
  readonly accountId: Id
  /** `config.branding.productName` — a hoster rebrands it (FR-THEME-02); never hardcode "Waxwing". */
  readonly productName: string
  /** Injected in tests. Defaults to {@link getNotificationRegistration}. */
  readonly registration?: () => Promise<ShowNotificationRegistration | null>
  /** Injected in tests. Defaults to {@link readPermission}. */
  readonly permission?: () => NotificationPermissionState
  /** Injected in tests. Defaults to i18next's `t`. */
  readonly translate?: Translate
  /** Injected in tests. Defaults to resolving against `document.baseURI`. */
  readonly assetUrl?: (file: string) => string
}

/** The hoster-editable, SW-cached branding icon (M3.5's `BRANDING_FILES`) — relative to `<base href>`. */
const ICON_FILE = 'branding/icon-192.png'

/**
 * How long a `null` registration lookup is trusted before we pay for another one.
 *
 * `getNotificationRegistration()` races `serviceWorker.ready`, which NEVER settles when nothing is
 * registered — a 404 on `sw.js` after a bad deploy, or a worker unregistered in devtools. Without a
 * negative cache, every sync pass carrying new mail eats the full 3 s timeout, and because the notify
 * call is awaited inside the pass, and `stop()` awaits the pass, sign-out pays it too.
 */
const NOTIFY_REGISTRATION_RETRY_MS = 60_000

function defaultAssetUrl(file: string): string {
  return new URL(file, document.baseURI).href
}

async function defaultTranslate(): Promise<Translate> {
  const { default: i18n } = await import('../i18n')
  return (key, vars) => i18n.t(key, vars ?? {}) as string
}

export function createMailNotifier(deps: MailNotifierDeps): NotifyNewMail {
  const lookUpRegistration = deps.registration ?? (() => getNotificationRegistration())
  const permissionOf = deps.permission ?? (() => readPermission())
  const assetUrl = deps.assetUrl ?? defaultAssetUrl

  /** A found registration is kept forever; a `null` is negative-cached (see the constant). */
  let cached: ShowNotificationRegistration | null = null
  let cachedNullUntil = 0

  async function registrationOf(now: number): Promise<ShowNotificationRegistration | null> {
    if (cached !== null) return cached
    if (now < cachedNullUntil) return null
    const found = await lookUpRegistration()
    if (found === null) {
      cachedNullUntil = now + NOTIFY_REGISTRATION_RETRY_MS
      return null
    }
    cached = found
    return found
  }

  /**
   * The rolling burst budget. `raisedAt` holds the instants of the individual banners still inside the
   * window; `summaryTotal` is the running count the summary banner reports, and it survives across
   * passes so a replaced summary counts UP rather than resetting to the latest pass's arrivals.
   */
  let raisedAt: number[] = []
  let summaryTotal = 0

  return async (created, ctx) => {
    if (created.length === 0) return

    const prefs = coerceNotificationPrefs(await getPref(deps.db, deps.accountId, NOTIFY_PREF_KEY))
    const permission = permissionOf()

    const notifiable = selectNotifiable(created, {
      prefs,
      permission,
      minutesOfDay: localMinutesOfDay(ctx.now),
      sinceMs: ctx.sinceMs,
    })
    if (notifiable.length === 0) return

    // Only NOW is the registration worth waiting for: resolving it before the predicate would make a
    // muted account pay a `serviceWorker.ready` await on every single sync pass.
    const registration = await registrationOf(ctx.now)
    if (registration === null) return

    const t = deps.translate ?? (await defaultTranslate())
    const icon = assetUrl(ICON_FILE)
    const renderCtx = {
      accountId: deps.accountId,
      productName: deps.productName,
      preview: prefs.preview,
      sound: prefs.sound,
      iconUrl: icon,
      // Deliberately the same asset. A dedicated monochrome badge would mean a new icon in
      // scripts/icons.mjs, public/manifest.json and the worker's BRANDING_FILES warm-up, for a glyph
      // only Android renders; it masks the app icon acceptably. A candidate for M4.5 (theming).
      badgeUrl: icon,
      t,
    }

    // Age the window out first — using the engine's clock, never Date.now(): the engine's clock is
    // injectable and every test in this suite drives it.
    const windowStart = ctx.now - NOTIFY_WINDOW_MS
    raisedAt = raisedAt.filter((at) => at > windowStart)
    if (raisedAt.length === 0) summaryTotal = 0

    const budget = NOTIFY_BURST_CAP - raisedAt.length
    const newest = notifiable[notifiable.length - 1] as EmailEnvelopeInput

    // `summaryTotal` counts everything the window has announced, not just what a summary folded up. So
    // two individual banners followed by two more arrivals give "4 new messages" beside the two that
    // are still on screen: truthful about what came in, which beats a summary that undercounts.
    summaryTotal += notifiable.length

    let contents: NotificationContent[]
    if (notifiable.length > budget) {
      contents = [buildSummaryNotification(summaryTotal, notifyMailboxId(newest, prefs), renderCtx)]
      // The summary spends the REST of the budget: it stands in for many banners, and it must not
      // leave room for individual ones to keep trickling out beside it.
      const spend = Math.max(budget, 1)
      for (let i = 0; i < spend; i++) raisedAt.push(ctx.now)
    } else {
      contents = notifiable.map((email) =>
        buildMailNotification(email, notifyMailboxId(email, prefs), renderCtx),
      )
      for (let i = 0; i < notifiable.length; i++) raisedAt.push(ctx.now)
    }

    // allSettled: one banner the browser refuses (a bad icon URL, a full notification centre) must not
    // swallow the others.
    await Promise.allSettled(
      contents.map((content) => registration.showNotification(content.title, content.options)),
    )
  }
}
