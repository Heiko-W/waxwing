/**
 * What arrived on a Web Push (M4.0, FR-NOTIF-02) — pure and DOM-free, because it is imported by the
 * SERVICE WORKER (`src/sw/sw.ts`), which compiles in its own program (`tsconfig.sw.json`,
 * `lib: WebWorker`, `types: []`). Nothing here may touch `window`, `document` or React.
 *
 * **The wire shapes are re-declared here instead of imported from `@waxwing/jmap`, and that is not
 * an oversight.** A value import from the package barrel would drag `push/` — the SSE and WebSocket
 * transports — into the worker's *typecheck*, where `EventSource` does not exist, and into `sw.js`,
 * a bundle every visitor downloads. `click-route.ts` declares `MailNotificationData` locally for the
 * same reason; the precedent is deliberate. What keeps the duplication honest is a test that imports
 * BOTH this module and `@waxwing/jmap` (the app program may) and asserts the two agree — so the day
 * the canonical name changes, this file goes red rather than silently reading a type nobody sends.
 *
 * Everything is total: the input came through the browser's push decryption from a server we do not
 * control, so a shape we do not recognise is an ordinary outcome and must never throw. A thrown
 * error inside a `push` handler is a notification the user never sees, with nothing on screen to
 * say so.
 *
 * The one thing it DOES import is `quiet-hours.ts`, which is DOM-free for exactly that purpose. The
 * distinction is worth stating: a type NAME may be restated (a test pins the two together), a RULE
 * may not — a second copy of the midnight-crossing logic would drift, and the failure would be
 * invisible until someone was woken at 3 a.m.
 */

import { inQuietHours, type QuietHours } from './quiet-hours'

export type { QuietHours }

/**
 * The RFC 8620 §7 type name meaning **mail arrived** — as opposed to `Email`, which also moves when
 * another client merely reads or files a message. Canonical copy: `EMAIL_DELIVERY_TYPE` in
 * `@waxwing/jmap`; see the header for why this one exists.
 */
export const EMAIL_DELIVERY = 'EmailDelivery'

/**
 * `draft-ietf-jmap-emailpush-03`'s frame type — the push that carries the mail itself. Canonical
 * copy: `EMAIL_PUSH_TYPE` in `@waxwing/jmap`; see the header for why this one exists, and the same
 * test pins the two together.
 */
export const EMAIL_PUSH = 'EmailPush'

/**
 * One message out of an {@link EMAIL_PUSH} frame, reduced to what a banner can show.
 *
 * Every field is nullable because the server sends only the `properties` the subscription asked for
 * — and because it may send fewer than that: the push body is capped at 4096 bytes and Stalwart
 * drops properties on its own to fit. A missing subject is an ordinary Tuesday, not an error.
 */
export interface PushedMessage {
  readonly sender: string | null
  readonly subject: string | null
  readonly preview: string | null
  /** ms since epoch, or `null` when absent or unparseable. */
  readonly receivedAt: number | null
}

/**
 * What the worker does about a decrypted push frame.
 *
 *  - `delivery` — new mail, raise the banner. **TWO wire shapes reach it**: a `StateChange` naming
 *    `EmailDelivery` (RFC 8620 §7.1) and an `EmailPush` (`draft-ietf-jmap-emailpush-03`), which
 *    REPLACES that `StateChange` rather than accompanying it once the subscription is configured for
 *    content. One `kind` for both is the whole point — see {@link classifyPushFrame}.
 *  - `stateChange` — a `StateChange` without it. Someone read a message on another device, or a
 *    mailbox was renamed. Explicitly NOT `unknown`: it is a frame we understood and decided against,
 *    and the distinction is what a test can pin.
 *  - `verification` — RFC 8620 §7.2.2, the code that must be written back before the server pushes
 *    anything real.
 *  - `unknown` — anything else, including an empty push (some services send one to keep an endpoint
 *    warm) and a payload that is not JSON at all.
 */
export type PushFrame =
  | {
      readonly kind: 'delivery'
      readonly accountIds: readonly string[]
      /**
       * Present only for an `EmailPush`, and possibly empty even then. A `StateChange` carries no
       * message data at all, which is why this is optional rather than an empty array: absent means
       * "this transport cannot say", empty means "it said nothing usable".
       */
      readonly messages?: readonly PushedMessage[]
      /**
       * The account's new state string, when the frame carried one — the `sinceState` of a
       * `Foo/changes`. Only an `EmailPush` has a single unambiguous one (a `StateChange` has one per
       * account per type); nothing consumes it yet, and it is here because the frame that replaced
       * the `StateChange` has to carry everything the `StateChange` did.
       */
      readonly state?: string
    }
  | { readonly kind: 'stateChange' }
  | {
      readonly kind: 'verification'
      readonly pushSubscriptionId: string
      readonly verificationCode: string
    }
  | { readonly kind: 'unknown' }

const UNKNOWN: PushFrame = { kind: 'unknown' }

/**
 * SW → page: "the server pushed a verification code; write it back."
 *
 * The worker cannot do it itself — that is an authenticated JMAP call, and keeping those out of the
 * worker is the whole security argument for the contentless banner (ADR-017). Declared here rather
 * than in `click-route.ts` so the two message contracts stay separate, and here rather than in
 * `push-store.ts` so the worker's message path does not depend on its database path.
 */
export const PUSH_VERIFICATION = 'PUSH_VERIFICATION'

export interface PushVerificationMessage {
  readonly type: typeof PUSH_VERIFICATION
  readonly pushSubscriptionId: string
  readonly verificationCode: string
}

export function isPushVerificationMessage(value: unknown): value is PushVerificationMessage {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    v.type === PUSH_VERIFICATION &&
    typeof v.pushSubscriptionId === 'string' &&
    typeof v.verificationCode === 'string'
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Which accounts in this frame reported a delivery.
 *
 * A subscription is bound to CREDENTIALS, not to an account (RFC 8620 §7.2), so one push can carry
 * several accounts at once — and the `changed` map is attacker-adjacent data: a server may put
 * anything in it. Values are checked to be objects before they are read, and a `changed` that is not
 * a record yields no accounts rather than an exception.
 */
function deliveringAccounts(changed: unknown): string[] {
  if (!isRecord(changed)) return []
  const accounts: string[] = []
  for (const [accountId, typeStates] of Object.entries(changed)) {
    if (!isRecord(typeStates)) continue
    if (Object.hasOwn(typeStates, EMAIL_DELIVERY)) accounts.push(accountId)
  }
  return accounts
}

/** A string that is worth showing: present, a string, and not blank. */
function text(value: unknown): string | null {
  if (typeof value !== 'string') return null
  // Collapse the whitespace a header may legitimately carry (folded `Subject:` lines arrive with
  // embedded newlines). A banner is one or two lines; a raw `\n` in it renders as a blank gap.
  const collapsed = value.replace(/\s+/g, ' ').trim()
  return collapsed === '' ? null : collapsed
}

/**
 * The display name for an `Email`'s `from` — the first address's `name`, else its `email`.
 *
 * Mirrors `senderLabel` in `notify-model.ts`, which does the same for the live channel. It is NOT
 * imported: that module reaches the replica types and React, and this one is compiled into `sw.js`.
 * The rule is three lines and has no state; the RULE that may not be duplicated is quiet hours,
 * which is imported (see the header).
 */
function senderOf(from: unknown): string | null {
  if (!Array.isArray(from)) return null
  const first: unknown = from[0]
  if (!isRecord(first)) return null
  return text(first.name) ?? text(first.email)
}

function pushedMessages(emails: unknown): PushedMessage[] {
  if (!Array.isArray(emails)) return []
  const messages: PushedMessage[] = []
  for (const entry of emails) {
    if (!isRecord(entry)) continue
    const receivedAt = typeof entry.receivedAt === 'string' ? Date.parse(entry.receivedAt) : NaN
    messages.push({
      sender: senderOf(entry.from),
      subject: text(entry.subject),
      preview: text(entry.preview),
      receivedAt: Number.isNaN(receivedAt) ? null : receivedAt,
    })
  }
  return messages
}

/** Classify one decrypted push payload. Never throws. */
export function classifyPushFrame(value: unknown): PushFrame {
  if (!isRecord(value)) return UNKNOWN

  if (value['@type'] === 'StateChange') {
    const accountIds = deliveringAccounts(value.changed)
    return accountIds.length > 0 ? { kind: 'delivery', accountIds } : { kind: 'stateChange' }
  }

  /**
   * `draft-ietf-jmap-emailpush-03`. **It is a `delivery`, the same `kind` a `StateChange` produces,
   * and that is the single most important line in this file.**
   *
   * The server sends one notification per delivery: an `EmailPush` when the subscription has a
   * matching `emailPush` config, a `StateChange` when it has not — never both (measured against
   * Stalwart v0.16.18). So the moment Waxwing configures `emailPush`, every `StateChange` that used
   * to arrive on this channel stops arriving. Giving this frame a `kind` of its own would mean every
   * existing consumer of `delivery` — today the banner, tomorrow anything that wakes a sync — went
   * quiet on the day the feature was switched on, with the server behaving exactly as documented and
   * nothing in the client to point at. A new OPTIONAL field is additive; a new `kind` is a fork.
   *
   * A frame with an unusable `accountId` still raises the banner with no account named: the `@type`
   * alone establishes that mail arrived, `userVisibleOnly: true` was promised at subscribe time, and
   * a silent push is a worse answer to a malformed frame than a banner that says less than usual.
   */
  if (value['@type'] === EMAIL_PUSH) {
    const accountId = value.accountId
    const state = value.state
    return {
      kind: 'delivery',
      accountIds: typeof accountId === 'string' && accountId !== '' ? [accountId] : [],
      messages: pushedMessages(value.emails),
      ...(typeof state === 'string' && state !== '' ? { state } : {}),
    }
  }

  if (value['@type'] === 'PushVerification') {
    const id = value.pushSubscriptionId
    const code = value.verificationCode
    // Both must be present AND non-empty: an empty code written back would be indistinguishable from
    // never having verified, and the subscription would sit silent with nothing to explain it.
    if (typeof id === 'string' && id !== '' && typeof code === 'string' && code !== '') {
      return { kind: 'verification', pushSubscriptionId: id, verificationCode: code }
    }
    return UNKNOWN
  }

  return UNKNOWN
}

/**
 * Parse a push payload's text into a frame. `null`/absent data is an ordinary empty push.
 *
 * Kept beside {@link classifyPushFrame} rather than inlined at the call site so the worker's handler
 * stays glue — nothing in `src/sw/` can have a test.
 */
export function parsePushFrame(text: string | null | undefined): PushFrame {
  if (text === null || text === undefined || text === '') return UNKNOWN
  try {
    return classifyPushFrame(JSON.parse(text))
  } catch {
    return UNKNOWN
  }
}

/** Why a push did not become a banner — so a test can tell the four silences apart. */
export type PushBannerDecision =
  | { readonly show: true }
  | {
      readonly show: false
      readonly because: 'notADelivery' | 'noState' | 'quietHours' | 'visible'
    }

export interface PushBannerInput {
  readonly frame: PushFrame
  /** Did the page leave a handover record? Without one there is no text to show. */
  readonly hasState: boolean
  /** Is a window of OURS visible right now? Then the live channel already said it, and better. */
  readonly hasVisibleClient: boolean
  readonly quietHours: QuietHours | null
  /** Local wall-clock minutes since midnight, from the worker's own clock. */
  readonly minutesOfDay: number
}

/**
 * Should this push raise a banner? Pure, so the worker's handler stays glue and every branch of it
 * has a test — nothing in `src/sw/` can have one.
 *
 * **Four of the five outcomes are silent, and it is worth saying so plainly rather than singling one
 * out.** `userVisibleOnly: true` was promised at subscribe time, so EVERY `show: false` below is a
 * push the worker accepts and answers with no notification: a frame that is not a delivery, no
 * handover state to render from, quiet hours, and a visible window. `visible` is only the most
 * deliberate of the four — a visible window means the live channel has ALREADY raised the richer
 * banner, with sender and subject, and two banners for one message is worse than one.
 *
 * What a user agent does about an unanswered push is UA POLICY, not spec, and we have measured one
 * point of it: the B29 hand-check (Chrome/FCM, app fully closed, 2026-07-24) recorded quiet hours
 * suppressing the banner with no generic "site was updated in the background" notice and no
 * observable demotion. Firefox, Safari and the effect of REPEATED silence are untested; the exposure
 * there is a generic banner or a dropped subscription, not a wrong decision here. `silent: true` is
 * not the escape hatch it looks like — it still pops a banner on macOS and Windows, i.e. it would be
 * LOUDER than staying silent, which is precisely what quiet hours may not be.
 *
 * Order is load-bearing: `visible` is checked BEFORE quiet hours, because during quiet hours with
 * the app open the live channel is the one that decided to stay silent, and this path must not
 * second-guess it either way.
 */
export function shouldRaisePushBanner(input: PushBannerInput): PushBannerDecision {
  if (input.frame.kind !== 'delivery') return { show: false, because: 'notADelivery' }
  // No state ⇒ the page never completed a subscribe pass, or was signed out and wiped. A banner
  // would mean inventing its text, and an untranslated string is not a fallback.
  if (!input.hasState) return { show: false, because: 'noState' }
  if (input.hasVisibleClient) return { show: false, because: 'visible' }
  // `inQuietHours` is IMPORTED, not restated. `quiet-hours.ts` is DOM-free precisely so both paths
  // can share it: a second copy of the midnight-crossing rule would drift, and the symptom would be
  // quiet hours working with the app open and failing with it closed — silently, at 3 a.m.
  if (input.quietHours !== null && inQuietHours(input.minutesOfDay, input.quietHours)) {
    return { show: false, because: 'quietHours' }
  }
  return { show: true }
}

/**
 * The already-translated strings the worker renders a banner from, handed over by the page through
 * `push-store.ts` (the worker can run neither i18next nor a locale detector).
 *
 * `preview` is the FR-NOTIF-03 privacy toggle, and it is carried here as well as being honoured at
 * subscribe time. That is belt and braces on purpose: the server-side `emailPush` config is only
 * removed on the app's next start, so a push carrying a subject can legitimately be in flight when
 * the user has just turned the toggle off. The push is already delivered — but the banner is ours,
 * and it must obey the switch the user last touched, not the one the server last heard about.
 */
export interface PushBannerStrings {
  /** The product name — the title of a contentless banner. */
  readonly title: string
  /** "New message" — the body of a contentless banner. */
  readonly body: string
  /** Shown as the title when a message carries no usable `from`. */
  readonly unknownSender: string
  /** Shown as the first body line when a message carries no subject. */
  readonly noSubject: string
  /** FR-NOTIF-03: `false` ⇒ nothing from the message may appear, whatever the frame carries. */
  readonly preview: boolean
}

export interface PushBannerContent {
  readonly title: string
  readonly body: string
  /** The moment the mail ARRIVED, for `NotificationOptions.timestamp`. `null` ⇒ omit the field. */
  readonly timestamp: number | null
}

/**
 * What the closed-app banner says.
 *
 * The shape is the one Apple's Mail uses on a lock screen, and it is not decoration: sender on the
 * first line (every platform renders `title` bold), subject on the second, preview after it. The
 * Notifications API has no `subtitle`, so subject and preview share `body` separated by a newline —
 * Chromium, Firefox and Android render that as two lines and collapse to one when the shade is
 * closed; Safari folds it to a single line, which is a graceful loss rather than a wrong banner.
 * There is no fourth element, no count and no ornament: a notification is read in half a second.
 *
 * **Falling back is the normal case, not the error case.** A `StateChange` frame, a server without
 * `draft-ietf-jmap-emailpush-03`, a push truncated to fit 4096 bytes, and the preview toggle being
 * off all land on exactly the wording M4.0 shipped — which is why the contentless strings stay in
 * the handover record rather than being replaced by these.
 */
export function pushBannerContent(frame: PushFrame, strings: PushBannerStrings): PushBannerContent {
  const generic: PushBannerContent = { title: strings.title, body: strings.body, timestamp: null }
  if (!strings.preview) return generic
  if (frame.kind !== 'delivery') return generic

  const message = newestMessage(frame.messages ?? [])
  if (message === null) return generic

  const subject = message.subject ?? strings.noSubject
  return {
    title: message.sender ?? strings.unknownSender,
    body: message.preview === null ? subject : `${subject}\n${message.preview}`,
    timestamp: message.receivedAt,
  }
}

/**
 * The one message a banner is about, when the server bundled several into one push.
 *
 * Newest wins, because a single banner replaces the last (they share one `tag`) and the newest is
 * the one the user is about to act on — the same choice iOS makes. Ties and undated messages fall
 * back to array order, where the server put the latest arrival last.
 */
function newestMessage(messages: readonly PushedMessage[]): PushedMessage | null {
  let best: PushedMessage | null = null
  for (const message of messages) {
    if (message.sender === null && message.subject === null && message.preview === null) continue
    if (best === null) {
      best = message
      continue
    }
    if (message.receivedAt === null) {
      if (best.receivedAt === null) best = message
      continue
    }
    if (best.receivedAt === null || message.receivedAt >= best.receivedAt) best = message
  }
  return best
}
