/**
 * Notification policy (M3.6, FR-NOTIF-03) — pure. No clock, no browser, no replica, no i18next
 * instance: every input is a parameter, so the whole decision surface is unit-testable and the
 * `sync` layer can import it without pulling React in (the `pinned-model.ts` precedent).
 *
 * What this module decides: whether ONE freshly created email may raise a system notification, and
 * what that notification says. What it deliberately does NOT decide: whether this tab is the leader,
 * whether it is in the foreground, and whether the pass is the first of a leadership session — those
 * are engine-session facts, and they live in the engine (see `engine.ts#raiseNewMailNotifications`).
 *
 * **Clock skew cuts both ways, and only one direction is dangerous.** `receivedAt` comes from the
 * SERVER's clock; `sinceMs` comes from the CLIENT's.
 *
 *  - A client running BEHIND the server can let a little pre-session mail past the floor. Harmless:
 *    the engine never notifies on the first pass after taking leadership (which is the catch-up), and
 *    a burst collapses into a single summary. Worst case is one banner too many.
 *  - A client running AHEAD puts the floor in the server's *future*, and then NOTHING ever satisfies
 *    rule 6 — no error, no status, no diagnostic, just silence for the length of the skew. A machine
 *    with a dead RTC battery would simply never notify. That one is not survivable, so the engine
 *    clamps the floor down to the newest `receivedAt` the replica already holds — a timestamp in the
 *    server's own units (`engine.ts#anchorNotifyFloor`). No offset estimation, no moving parts.
 */

import type { Id } from '@waxwing/jmap'
import type { EmailEnvelopeInput } from '../sync/db'
import type { MailNotificationData } from './click-route'
import type { NotificationPermissionState } from './permission'

/** localPrefs key. ONE compound object, like `labels` — the predicate needs all of it at once. */
export const NOTIFY_PREF_KEY = 'notifications'

/**
 * A quiet window in LOCAL minutes since midnight. `fromMinutes` inclusive, `toMinutes` exclusive.
 * `from > to` crosses midnight (22:00 → 07:00). `from === to` is EMPTY, never "always".
 */
export interface QuietHours {
  readonly fromMinutes: number
  readonly toMinutes: number
}

export interface NotificationPrefs {
  /** Master switch. Default false — a permission prompt is never implicit. */
  readonly enabled: boolean
  /** The mailboxes that may notify. Seeded with the Inbox id when the user first enables. */
  readonly mailboxIds: readonly Id[]
  /** `null` = quiet hours off. */
  readonly quietHours: QuietHours | null
  /** Show sender + subject (the FR-NOTIF-03 privacy toggle). */
  readonly preview: boolean
  /** Ask the OS for the notification sound (`silent: !sound`). */
  readonly sound: boolean
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  enabled: false,
  mailboxIds: [],
  quietHours: null,
  preview: true,
  sound: true,
}

/** Default quiet window seeded when the user turns quiet hours on without picking times: 22:00–07:00. */
export const DEFAULT_QUIET_HOURS: QuietHours = { fromMinutes: 22 * 60, toMinutes: 7 * 60 }

/**
 * How many individual banners this app may raise inside {@link NOTIFY_WINDOW_MS}. Beyond it, arrivals
 * collapse into ONE running summary.
 *
 * It is a budget over a rolling WINDOW, not a per-pass limit, and that distinction is the whole point.
 * The engine runs one sync pass per `StateChange`, so a mailing-list flood delivering twenty messages
 * a couple of seconds apart arrives as twenty passes of ONE created id each. A per-pass cap never
 * evaluates true even once, and the user gets twenty banners — the exact storm the cap is named for is
 * the one it cannot see.
 */
export const NOTIFY_BURST_CAP = 3

/** The window the {@link NOTIFY_BURST_CAP} budget is measured over. */
export const NOTIFY_WINDOW_MS = 60_000

const MINUTES_PER_DAY = 24 * 60

function isMinuteOfDay(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < MINUTES_PER_DAY
  )
}

function coerceQuietHours(value: unknown): QuietHours | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (!isMinuteOfDay(v.fromMinutes) || !isMinuteOfDay(v.toMinutes)) return null
  return { fromMinutes: v.fromMinutes, toMinutes: v.toMinutes }
}

/**
 * Tolerant reader for the stored prefs. A localPrefs row is an untyped blob written by some earlier
 * version of this app, so every field is validated and anything unrecognisable falls back to its
 * default — a partial row must degrade, never throw and never notify by accident.
 */
export function coerceNotificationPrefs(value: unknown): NotificationPrefs {
  if (typeof value !== 'object' || value === null) return DEFAULT_NOTIFICATION_PREFS
  const v = value as Record<string, unknown>
  return {
    enabled: v.enabled === true,
    mailboxIds: Array.isArray(v.mailboxIds)
      ? v.mailboxIds.filter((id): id is Id => typeof id === 'string')
      : DEFAULT_NOTIFICATION_PREFS.mailboxIds,
    quietHours: coerceQuietHours(v.quietHours),
    // Both default to ON, so an unset field must not read as "off".
    preview: v.preview !== false,
    sound: v.sound !== false,
  }
}

/** Local minutes since midnight (0–1439) for an epoch-ms instant. */
export function localMinutesOfDay(now: number): number {
  const date = new Date(now)
  return date.getHours() * 60 + date.getMinutes()
}

/**
 * Is `minutesOfDay` inside the quiet window? `from` inclusive, `to` exclusive.
 *
 * `from > to` CROSSES MIDNIGHT: 22:00 → 07:00 is quiet at 23:00 *and* at 03:00, and loud at noon.
 * `from === to` is an EMPTY range — never quiet, not always quiet: a zero-length window means "off",
 * and "always off" is what the master switch is for.
 */
export function inQuietHours(minutesOfDay: number, range: QuietHours): boolean {
  const { fromMinutes: from, toMinutes: to } = range
  if (from === to) return false
  if (from < to) return minutesOfDay >= from && minutesOfDay < to
  return minutesOfDay >= from || minutesOfDay < to
}

/** `"22:00"` ⇄ minutes, for the native `<input type="time">` in the settings section. */
export function minutesToTimeValue(minutes: number): string {
  const hh = Math.floor(minutes / 60)
    .toString()
    .padStart(2, '0')
  const mm = (minutes % 60).toString().padStart(2, '0')
  return `${hh}:${mm}`
}

/** `null` for anything the time input could not produce (it can be cleared to `""`). */
export function timeValueToMinutes(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value)
  if (match === null) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return hours * 60 + minutes
}

/** The email fields the decision actually reads — so a test does not have to build a whole envelope. */
export type NotifiableEmail = Pick<
  EmailEnvelopeInput,
  'id' | 'mailboxIds' | 'keywords' | 'receivedAt'
>

export interface NotifyDecisionInput {
  readonly email: NotifiableEmail
  readonly prefs: NotificationPrefs
  readonly permission: NotificationPermissionState
  /** Local minutes since midnight at the moment of decision — {@link localMinutesOfDay}. */
  readonly minutesOfDay: number
  /** Mail not strictly newer than this is never notified (the storm floor — see the module header). */
  readonly sinceMs: number
}

/**
 * May this ONE email raise a system notification? In order:
 *
 *  1. permission is not `granted`                          → no
 *  2. the master switch is off                             → no
 *  3. we are inside the quiet window                       → no
 *  4. `$draft` — our own draft save, not an arrival        → no
 *  5. `$seen`  — already read on another device            → no
 *  6. `receivedAt` is not strictly newer than `sinceMs`    → no  (an UNPARSEABLE date lands here too:
 *                                                                 `NaN > x` is false, and an email we
 *                                                                 cannot date is not provably new)
 *  7. it is in none of the enabled mailboxes               → no
 *  8. otherwise                                            → yes
 *
 * Rules 4 and 5 are belt-and-braces under the Inbox-only default; they become load-bearing the moment
 * a user enables Sent or Drafts.
 *
 * `keywords` and `mailboxIds` are read defensively. What arrives here is the RAW `Email/get` result —
 * `delta.ts` filters the created ids out of the port's list, not out of a coerced row — and `db.ts`'s
 * `toEmailRow` already declines to trust the server on exactly these two fields. A `TypeError` thrown
 * in here would be caught by the engine and take the WHOLE pass's notifications down with it, the
 * well-formed ones included, without leaving a trace.
 */
export function shouldNotify(input: NotifyDecisionInput): boolean {
  const { email, prefs, permission, minutesOfDay, sinceMs } = input
  if (permission !== 'granted') return false
  if (!prefs.enabled) return false
  if (prefs.quietHours !== null && inQuietHours(minutesOfDay, prefs.quietHours)) return false
  const keywords = email.keywords ?? {}
  if (keywords.$draft === true) return false
  if (keywords.$seen === true) return false
  if (!(Date.parse(email.receivedAt) > sinceMs)) return false
  const mailboxIds = email.mailboxIds ?? {}
  return prefs.mailboxIds.some((id) => mailboxIds[id] === true)
}

/**
 * Every notifiable email of one delta pass, oldest first. The {@link NOTIFY_BURST_CAP} is applied by
 * the caller — it needs the full count to write "12 new messages".
 */
export function selectNotifiable<T extends NotifiableEmail>(
  created: readonly T[],
  input: Omit<NotifyDecisionInput, 'email'>,
): T[] {
  return created
    .filter((email) => shouldNotify({ ...input, email }))
    .sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt))
}

/** The first enabled mailbox the email is actually in — where a click on it should land. */
export function notifyMailboxId(email: NotifiableEmail, prefs: NotificationPrefs): Id | null {
  const mailboxIds = email.mailboxIds ?? {}
  return prefs.mailboxIds.find((id) => mailboxIds[id] === true) ?? null
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

/** i18next's `t`, narrowed to what this module uses — so the model never imports i18next. */
export type Translate = (key: string, vars?: Record<string, unknown>) => string

/**
 * `NotificationOptions` plus the two fields TypeScript's `lib.dom` does not model.
 *
 * Both are real, current members of the Notifications API's `NotificationOptions` dictionary and both
 * are honoured by `ServiceWorkerRegistration.showNotification()`; `lib.dom.d.ts` simply has not caught
 * up (it declares `badge`, `silent`, `tag` and the rest, but not these two). Declaring them is the
 * honest fix. The dishonest one is to let them in through an object spread, which TypeScript does not
 * excess-property-check — that compiles, and silently stops compiling the day someone reads the field
 * back.
 */
export interface MailNotificationOptions extends NotificationOptions {
  /** Re-alert when this notification REPLACES one with the same tag. */
  readonly renotify?: boolean
  /** The moment the notification is *about* (the mail's arrival), not the moment it was shown. */
  readonly timestamp?: number
}

export interface NotificationRenderContext {
  readonly accountId: Id
  /** From `config.branding.productName` — never the literal "Waxwing" (FR-THEME-02). */
  readonly productName: string
  /** FR-NOTIF-03: when false, NOTHING from the message may appear — no sender, no subject. */
  readonly preview: boolean
  readonly sound: boolean
  readonly iconUrl: string
  readonly badgeUrl: string
  readonly t: Translate
}

export interface NotificationContent {
  readonly title: string
  readonly options: MailNotificationOptions
}

/** A tag is unique per message, so N arrivals raise N banners rather than replacing one another. */
function mailTag(accountId: Id, emailId: Id): string {
  return `waxwing:${accountId}:mail:${emailId}`
}

function summaryTag(accountId: Id): string {
  return `waxwing:${accountId}:summary`
}

function senderLabel(email: EmailEnvelopeInput, t: Translate): string {
  const first = email.from?.[0]
  if (first === undefined) return t('notify.message.unknownSender')
  return first.name ?? first.email ?? t('notify.message.unknownSender')
}

/**
 * `timestamp` shows the true arrival time in the OS shade rather than the moment we got around to
 * showing the banner. An unparseable date omits the field entirely — `exactOptionalPropertyTypes`
 * means `{ timestamp: undefined }` is not the same thing as absent, and `NaN` would render as garbage.
 */
function timestampOf(receivedAt: string): Pick<MailNotificationOptions, 'timestamp'> {
  const parsed = Date.parse(receivedAt)
  return Number.isNaN(parsed) ? {} : { timestamp: parsed }
}

/**
 * One arrival → one banner.
 *
 * With `preview` OFF the notification says only that mail arrived: no sender in the title, no subject
 * in the body, nothing in `data` beyond ids. That is the whole point of the toggle — a notification
 * lands on a lock screen and on a shared display, where the user cannot un-see it. There is a test
 * asserting that the sender string and the subject string appear in NEITHER field.
 */
export function buildMailNotification(
  email: EmailEnvelopeInput,
  mailboxId: Id | null,
  ctx: NotificationRenderContext,
): NotificationContent {
  const data: MailNotificationData = {
    kind: 'mail',
    accountId: ctx.accountId,
    mailboxId,
    emailId: email.id,
  }
  return {
    title: ctx.preview ? senderLabel(email, ctx.t) : ctx.productName,
    options: {
      body: ctx.preview
        ? (email.subject ?? ctx.t('notify.message.noSubject'))
        : ctx.t('notify.body.generic'),
      tag: mailTag(ctx.accountId, email.id),
      icon: ctx.iconUrl,
      badge: ctx.badgeUrl,
      silent: !ctx.sound,
      data,
      ...timestampOf(email.receivedAt),
    },
  }
}

/**
 * Once the {@link NOTIFY_BURST_CAP} budget is spent → one banner, not a wall of them.
 *
 * `count` is the RUNNING TOTAL for the current window, not this pass's arrivals. The tag is constant
 * per account, so each summary REPLACES the last one; counting per pass would mean five arrivals then
 * four more leaves a banner reading "4 new messages" when nine came in.
 *
 * This is the only notification that sets `renotify`: a silently replaced banner would leave the user
 * with a stale count they never saw change. `renotify` without a `tag` is a TypeError in Chrome, and
 * it is never combined with `silent` — a "re-alert" that cannot alert is a contradiction the browser
 * is entitled to complain about.
 */
export function buildSummaryNotification(
  count: number,
  mailboxId: Id | null,
  ctx: NotificationRenderContext,
): NotificationContent {
  const data: MailNotificationData = {
    kind: 'summary',
    accountId: ctx.accountId,
    mailboxId,
    emailId: null,
  }
  return {
    title: ctx.productName,
    options: {
      body: ctx.t('notify.body.count', { count }),
      tag: summaryTag(ctx.accountId),
      icon: ctx.iconUrl,
      badge: ctx.badgeUrl,
      silent: !ctx.sound,
      ...(ctx.sound ? { renotify: true } : {}),
      data,
    },
  }
}
