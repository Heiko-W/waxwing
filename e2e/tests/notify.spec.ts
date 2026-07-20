import { type BrowserContext, expect, type Page, test } from '@playwright/test'
import { deliverLiveMail, READ_SUBJECTS, seedReadMail } from '../stalwart/seed-read.mjs'
import { CREDENTIALS, login, messageList, openFolder } from './helpers'
import {
  banners,
  bringForeground,
  enableNotifications,
  goBackground,
  installBannerSpy,
  liveNotifications,
} from './notify-helpers'

/**
 * M3.6's notifications, in a real browser against the live fixture (M3.10 wave 3).
 *
 * FR-NOTIF-01/03 and FR-AUTH-05. Until now every rule in this area was proven only in jsdom against
 * an injected fake: `notifier.test.ts` supplies its own registration, `engine.test.ts` supplies its
 * own lock manager and its own bus. The four invariants that decide whether a user is spammed —
 * leader-only, first-pass silence, the cross-tab foreground veto, and closing the banners at
 * sign-out — are all statements about REAL Web Locks, a REAL BroadcastChannel, REAL window focus and
 * the OS's own notification set. None of them can be observed anywhere but here.
 *
 * ── WHAT THIS SUITE PROVES, AND EXACTLY WHERE IT STOPS ──────────────────────────────────────────
 *
 * **It does not prove a banner is PAINTED.** `showNotification()` resolving and
 * `registration.getNotifications()` listing the result prove the browser accepted the notification
 * and is holding it. Headless has no notification centre and no automation surface exposes one, in
 * any engine. Read every assertion below as "the browser accepted and holds it", never as "the user
 * saw it".
 *
 * **It never drives `visibilityState`.** The engine's foreground guard is
 * `visibilityState === 'visible' && document.hasFocus()`; only the focus half is reachable in
 * headless (see notify-helpers.ts for the four levers that were tried and what each one did). Every
 * test here runs `visible`, so the visibility half of that AND is NEVER exercised. It has dedicated
 * unit coverage for exactly that reason.
 *
 * **There is no background-push test and there must never be one.** Not "hard" — there is no code.
 * ADR-010: Stalwart publishes no VAPID key, so the app contains no `applicationServerKey`, no
 * `PushSubscription/set` and no `push` listener at all. A spec that closed the app and waited for a
 * banner would be asserting behaviour that exists in no browser against any JMAP server. The only
 * legitimate neighbour is the assertion that the app SAYS SO honestly, and it lives in
 * settings.spec.ts (`notify.background.unavailable`) as the guard on the capability probe reaching
 * the UI against a real session.
 *
 * **A notification CLICK is not dispatchable.** No Playwright API and no CDP method fires one. A
 * synthetic `NotificationEvent` fails twice over: `ExtendableEvent.waitUntil` rejects untrusted
 * events, and both `WindowClient.focus()` and `clients.openWindow()` require the transient user
 * activation only a genuine click carries — so `focusOrOpen` (sw/sw.ts) cannot take EITHER branch.
 * What is covered instead is the half a browser can actually check: the SW→page hop and the deep
 * link resolving (see 'the deep link a banner carries…'). The focus-or-openWindow CHOICE remains
 * hand-verified only; that is recorded here rather than dressed up as a passing test.
 *
 * ── WHY THE POSITIVE CONTROLS ARE NOT OPTIONAL ─────────────────────────────────────────────────
 *
 * Three of these six tests assert ABSENCE — no second banner, no storm, no banner while another tab
 * is watched. Absence is exactly what a broken harness produces: permission never granted, no
 * service worker, prefs enabled for no folder, a tab that is really in the foreground. Every one of
 * those makes all three pass while proving nothing. So each of them carries a positive control IN
 * THE SAME TEST that fires the identical wiring and demands a banner, and the shared helpers assert
 * their own effect (`goBackground` fails if focus did not move; `enableNotifications` fails if the
 * Inbox was not armed). The first test in the file is the suite-level control.
 *
 * Runs under playwright.read.config.ts, project `chromium-notify` — a full chromium build, because
 * the headless shell every other project uses denies notifications outright. See that config.
 */

/** `deliverLiveMail`'s sender, from seed-read.mjs — the title of a preview-on banner. */
const SENDER = 'Carol Chen'

/** Long enough for a further sync pass and comfortably past FOREGROUND_ACK_MS (100 ms). */
const SETTLE_MS = 4_000

let inboxId = ''

test.beforeEach(async () => {
  const summary = await seedReadMail()
  inboxId = summary.inboxId
})

/**
 * A page that holds window focus so the app tabs can be out of it. It is a THIRD page rather than a
 * stub of the focus primitive, so `isDocumentForeground()` runs for real in every app tab.
 */
async function focusHolder(context: BrowserContext): Promise<Page> {
  const holder = await context.newPage()
  await holder.goto('about:blank')
  return holder
}

/**
 * Sign in, arm notifications through the Settings switch, and come back to the Inbox.
 *
 * The return trip is not cosmetic: `enableNotifications` leaves the tab on the Settings screen,
 * where there is no message list — and the two-tab tests anchor their settle window on the new row
 * appearing. Walked through the nav rail rather than re-navigated, so the engine and its leadership
 * are not restarted underneath a test that is about leadership.
 */
async function signInWithNotifications(page: Page): Promise<void> {
  await login(page, CREDENTIALS.alice, { stay: true })
  await expect(messageList(page).getByText(READ_SUBJECTS.plain)).toBeVisible({ timeout: 30_000 })
  await enableNotifications(page)
  await page.getByRole('link', { name: 'Mail', exact: true }).click()
  await openFolder(page, /Inbox/)
  await expect(messageList(page).getByText(READ_SUBJECTS.plain)).toBeVisible({ timeout: 30_000 })
}

test.describe('M3.10 notifications (M3.6 handover)', () => {
  /**
   * THE SUITE-LEVEL POSITIVE CONTROL. If this fails, every absence assertion below is worthless and
   * should be read as "the harness is broken", not as "the app is quiet".
   *
   * Both observers are asserted, because they answer different questions and the difference is the
   * reason this project's config had to change: the `addInitScript` spy records a call even in the
   * browser that REFUSES to show anything (measured — the headless shell records 1 while
   * `getNotifications()` returns 0). The spy proves what the app asked for; `getNotifications()`
   * proves the browser accepted it and is holding it.
   *
   * MUTATION-PROVEN: deleting the `await notify(created, …)` call in
   * engine.ts#raiseNewMailNotifications turns this RED (0 banners, both observers) — observed, not
   * assumed.
   */
  test('a live delivery raises a banner while the tab is in the background', async ({
    page,
    context,
  }) => {
    await installBannerSpy(context)
    const holder = await focusHolder(context)
    await signInWithNotifications(page)
    await goBackground(page, holder)

    const subject = await deliverLiveMail('t-notify')

    await expect
      .poll(async () => (await banners(page)).length, { timeout: 30_000 })
      .toBeGreaterThan(0)

    // The app asked for the right banner: sender in the title, subject in the body, and `data`
    // carrying the ids a click would route on (never content — it outlives the session in the OS
    // shade). Preview is on by default, which is what makes the sender/subject assertion meaningful.
    const [banner] = await banners(page)
    expect(banner?.title).toBe(SENDER)
    expect(banner?.body).toBe(subject)
    expect(banner?.data?.kind).toBe('mail')
    expect(banner?.data?.mailboxId).toBe(inboxId)
    expect(banner?.data?.emailId).toBeTruthy()

    // …and the BROWSER accepted it and is holding it. This is the genuine browser-level observation
    // and the one the spy cannot stand in for.
    const live = await liveNotifications(page)
    expect(live.map((n) => n.body)).toContain(subject)
  })

  /**
   * The coverable half of the click route.
   *
   * The click ITSELF cannot be dispatched (see the file header). What can be driven is everything
   * downstream of it: the worker posting `NOTIFY_CLICK` to a page, `useNotificationClickNavigation`
   * receiving it, and the router landing on the message. That hop had zero browser coverage and is
   * not reproducible in jsdom, because the message crosses a real `navigator.serviceWorker` boundary
   * from a real worker.
   *
   * The ids are taken from the REAL banner's `data` rather than from a fixture, so this pins the ids
   * the notifier actually put on the notification to ids the router can actually resolve — the half
   * `click-route.test.ts` cannot see, since it only ever asserts string math against literals.
   *
   * WHAT IT DOES **NOT** COVER, stated because a passing test here could easily be read as more:
   * `notificationTargetPath` / `notificationTargetHref` are NOT exercised. Only `focusOrOpen` calls
   * them, and reaching `focusOrOpen` needs the click that cannot be dispatched — so the route below
   * is composed by the test, not by the worker. This was verified rather than assumed: mutating
   * `notificationTargetPath` to drop the `emailId` leaves this test GREEN. That math is unit-covered
   * (click-route.test.ts, at the root, under `/mail/` and under an arbitrary mount); what is covered
   * HERE is everything from the worker's `postMessage` onwards.
   *
   * The `/mail/` MOUNT half of the coordinate-space claim lives in mount.spec.ts, where the app is
   * actually served under a prefix: `notificationTargetHref` builds on `appRoot(self.location.href)`,
   * so the fact under test there is that the worker's own root really is the mount.
   *
   * MUTATION-PROVEN: dropping `navigate(data.path)` from
   * notify/use-notification-click.ts#useNotificationClickNavigation turns this RED — the worker posts
   * the route, nothing receives it, and the app never leaves the list. Observed.
   */
  test('the deep link a banner carries opens the message it names', async ({ page, context }) => {
    await installBannerSpy(context)
    const holder = await focusHolder(context)
    await signInWithNotifications(page)
    await goBackground(page, holder)

    const subject = await deliverLiveMail('t-click')
    await expect
      .poll(async () => (await banners(page)).length, { timeout: 30_000 })
      .toBeGreaterThan(0)
    const data = (await banners(page))[0]?.data
    expect(data?.emailId).toBeTruthy()

    // Bring the tab back before asserting on navigation: this is the state a real click leaves the
    // app in (the worker focuses the window first), and it keeps the assertion about routing rather
    // than about a background tab's rendering.
    await bringForeground(page)

    // The worker → page hop, driven from the REAL service worker of this deployment. `matchAll` with
    // `includeUncontrolled` is the same lookup `focusOrOpen` performs; what cannot be reached is the
    // `focus()` that would precede this postMessage, because it needs a genuine click's activation.
    const worker = context.serviceWorkers()[0]
    expect(worker, 'the built bundle must have registered a service worker').toBeDefined()
    await worker?.evaluate(async (path: string) => {
      const clients = await (
        self as unknown as {
          clients: { matchAll(o: object): Promise<{ postMessage(m: unknown): void }[]> }
        }
      ).clients.matchAll({ type: 'window', includeUncontrolled: true })
      for (const client of clients) client.postMessage({ type: 'NOTIFY_CLICK', path })
    }, `/mail/${data?.mailboxId}/${data?.emailId}`)

    // The app navigated in place — no reload, no second tab — and the named message is open.
    await expect(page).toHaveURL(new RegExp(`/mail/${data?.mailboxId}/${data?.emailId}$`), {
      timeout: 15_000,
    })
    await expect(page.getByRole('heading', { name: subject })).toBeVisible({ timeout: 20_000 })
  })

  /**
   * LEADER-ONLY, across two real tabs and one real Web Lock.
   *
   * WHY THE ASSERTION COUNTS CALLS AND NOT BANNERS. `notify-model.ts` tags a banner per MESSAGE, so
   * two tabs announcing the same arrival issue two `showNotification` calls carrying the SAME tag,
   * and the browser REPLACES rather than stacks. `getNotifications()` returns 1 either way — a test
   * built on it would pass under its own mutation. The per-page spy is the only instrument that can
   * tell the leader from the follower.
   *
   * ⚠ NOT MUTATION-PROVEN, AND THE REASON IS WORTH MORE THAN THE TEST. Four mutations were tried,
   * all of them run against this test and all of them observed, not reasoned about:
   *
   *   1. delete `if (!this.isLeader …) return` in `raiseNewMailNotifications` → GREEN;
   *   2. …and additionally delete `sync()`'s own leadership guard → still GREEN;
   *   3. `mode: 'exclusive'` → `'shared'` in leader.ts, so both tabs hold the lock → still GREEN
   *      (it DID redden the cross-tab-veto test below, with 13 banners, so the mutation was live);
   *   4. call `onLeadership(true)` before the lock is requested, making the second tab a full leader
   *      with its own push channel and safety sweep → still GREEN.
   *
   * "Exactly one banner" turns out to be OVER-DETERMINED by three independent mechanisms, and no
   * mutation of the notification path can defeat all of them at once:
   *
   *   - the `waxwing-sync` Web Lock, which is what the code intends to be doing;
   *   - a follower has no sync TRIGGER at all — `openPush()` and `scheduleSafetySweep()` are both
   *     called only from `onLeadership`, so removing the guards gives a follower permission to do
   *     something nothing ever asks it to do; and, decisively,
   *   - the Email sync cursor is ONE ROW in the shared replica (`db.syncState`, keyed
   *     `[accountId, type]`). Whichever tab syncs first advances it, so `Email/changes` reports the
   *     arrival as created to exactly ONE tab however many tabs are looking.
   *
   * So this is a REGRESSION NET rather than a proof: it pins the two-tab outcome for the class of
   * future change that would break it (a per-tab sync cursor, a follower push channel), and it is a
   * second positive control for the two-tab configuration the veto test depends on. It is recorded
   * here as not-mutation-proven rather than dressed in a mutation that was tried and did not hold.
   */
  test('two backgrounded tabs raise exactly one notification between them', async ({
    page,
    context,
  }) => {
    test.setTimeout(120_000)
    await installBannerSpy(context)
    const holder = await focusHolder(context)

    // Tab A signs in first and therefore takes the `waxwing-sync` lock: leadership is whoever gets
    // there first, and a test cannot choose it any other way.
    await signInWithNotifications(page)

    // Tab B restores the same session in the SAME context — same IndexedDB, same Web Lock, same
    // BroadcastChannel. A second `browser.newContext()` would share none of them and this test would
    // pass vacuously. Navigated straight to the Inbox route rather than clicked there, so B can be
    // backgrounded before it ever loads: an input action re-pins focus (see notify-helpers.ts).
    const b = await context.newPage()
    await goBackground(b, holder)
    await b.goto(`/mail/${inboxId}`)
    await expect(messageList(b).getByText(READ_SUBJECTS.plain)).toBeVisible({ timeout: 30_000 })

    await goBackground(page, holder)
    await goBackground(b, holder)

    const subject = await deliverLiveMail('t-leader')

    // ANCHOR on a positive event, not on a sleep: both tabs showing the new row means the pass that
    // would have notified has completed in each of them. Only then is "exactly one" a settled fact
    // rather than a race the follower might still win.
    await expect(messageList(page).getByText(subject)).toBeVisible({ timeout: 30_000 })
    await expect(messageList(b).getByText(subject)).toBeVisible({ timeout: 30_000 })
    await page.waitForTimeout(SETTLE_MS)

    const fromA = await banners(page)
    const fromB = await banners(b)
    // The POSITIVE half: the wiring is live, one tab did announce it. Without this the test would be
    // satisfied by two silent tabs.
    expect(fromA.map((x) => x.body)).toEqual([subject])
    // The invariant: the follower announced nothing.
    expect(fromB).toEqual([])
  })

  /**
   * NO NOTIFICATION STORM when the app reopens onto mail that arrived while it was gone.
   *
   * NOT "a fresh sign-in with a full inbox", which is what the plan asked for and would be VACUOUS:
   * `syncEmails` returns `[]` outright when there is no stored Email sync state (delta.ts), so a
   * cold replica hands the notifier an empty array and the test would stay green with the arm guard
   * deleted. The storm the guard exists for needs a WARM replica: sign in with "Stay signed in", let
   * mail arrive while the tab is gone, reopen — now `Email/changes` reports every one of them as
   * created, and only `notifyArmed === false` on the first pass of the new leadership session keeps
   * the machine quiet.
   *
   * The `receivedAt` floor does NOT cover this case and cannot stand in for it: `anchorNotifyFloor`
   * clamps the floor DOWN to the newest `receivedAt` already in the replica, which is older than the
   * mail that arrived while the tab was closed. Two separate mechanisms; only the arm guard is under
   * test here.
   *
   * The reopened tab is backgrounded BEFORE it navigates, which is load-bearing rather than tidy: the
   * catch-up pass runs moments after the session restores, and a tab that were still in the
   * foreground then would be silenced by the foreground veto instead — so the test would pass under
   * its own mutation, for the wrong reason. (Backgrounding survives navigation and reload; verified.)
   *
   * MUTATION-PROVEN: deleting `if (!wasArmed) return` from engine.ts#raiseNewMailNotifications turns
   * this RED — observed at 13 banners, i.e. the catch-up announcing everything the pass carried, not
   * merely the four deliveries. That is the storm, in the shape the guard exists to prevent.
   */
  test('reopening onto mail that arrived while it was closed raises nothing', async ({
    page,
    context,
  }) => {
    test.setTimeout(120_000)
    await installBannerSpy(context)
    const holder = await focusHolder(context)

    // Warm the replica: a completed sync stores the Email sync state, which is what makes the next
    // session's first pass carry created ids at all.
    await signInWithNotifications(page)
    await page.close()

    const subjects: string[] = []
    for (const tag of ['t-storm-1', 't-storm-2', 't-storm-3', 't-storm-4']) {
      subjects.push(await deliverLiveMail(tag))
    }

    const reopened = await context.newPage()
    await goBackground(reopened, holder)
    await reopened.goto(`/mail/${inboxId}`)

    // ANCHOR: all four rows visible means the catch-up pass ran and handed the notifier four created
    // ids. Asserting zero before that would only prove nothing had happened yet.
    for (const subject of subjects) {
      await expect(messageList(reopened).getByText(subject)).toBeVisible({ timeout: 40_000 })
    }
    await reopened.waitForTimeout(SETTLE_MS)

    expect(await banners(reopened)).toEqual([])

    // POSITIVE CONTROL, same tab, same wiring, one line later: the session is now ARMED, so the very
    // next arrival must be announced. This is what separates "the guard worked" from "notifications
    // were never going to fire in this tab anyway" — and it is the exact failure mode that would
    // otherwise make this test green forever.
    const live = await deliverLiveMail('t-storm-armed')
    await expect
      .poll(async () => (await banners(reopened)).map((x) => x.body), { timeout: 30_000 })
      .toEqual([live])
  })

  /**
   * THE CROSS-TAB FOREGROUND VETO: a hidden leader stays silent while another tab of the same app is
   * being watched.
   *
   * This is the one notification rule that is un-fakeable anywhere else. The leader asks over a real
   * `BroadcastChannel` (`foreground?`), every other tab answers for itself only if its own
   * `isDocumentForeground()` is true (`foreground!`), and silence inside FOREGROUND_ACK_MS is the
   * "no". Leadership is sticky, so the leader is usually the tab opened FIRST — meaning the normal
   * configuration is exactly this one: the user works in tab B while tab A, hidden, is the leader.
   * Without the query/ack, A banners mail the user is watching land.
   *
   * MUTATION-PROVEN: deleting the `if (message.type === 'foreground?') … postForegroundAck()` branch
   * in engine.ts#start turns this RED — tab B stops answering, the leader concludes nobody is
   * watching, and a banner appears while the user is looking straight at the arrival.
   */
  test('a hidden leader stays silent while another tab is focused', async ({ page, context }) => {
    test.setTimeout(120_000)
    await installBannerSpy(context)
    const holder = await focusHolder(context)

    await signInWithNotifications(page)

    const b = await context.newPage()
    await goBackground(b, holder)
    await b.goto(`/mail/${inboxId}`)
    await expect(messageList(b).getByText(READ_SUBJECTS.plain)).toBeVisible({ timeout: 30_000 })

    // The leader is hidden; the OTHER tab is the one the user is looking at. Both states are real
    // window focus and both helpers assert their own effect, so a lever that silently stopped working
    // fails here rather than turning the assertion below into a tautology.
    await goBackground(page, holder)
    await bringForeground(b)

    const quiet = await deliverLiveMail('t-veto')

    // ANCHOR on the arrival reaching both tabs: the pass that would have notified is complete, so
    // "no banner" is a settled outcome and not a race with the delivery.
    await expect(messageList(page).getByText(quiet)).toBeVisible({ timeout: 30_000 })
    await expect(messageList(b).getByText(quiet)).toBeVisible({ timeout: 30_000 })
    await page.waitForTimeout(SETTLE_MS)

    expect(await banners(page)).toEqual([])
    expect(await banners(b)).toEqual([])

    // POSITIVE CONTROL: change ONLY the thing under test — take focus away from tab B — and the same
    // delivery path must now produce a banner. Everything else (leadership, prefs, permission, the
    // service worker, the push channel) is identical, so this isolates the veto rather than merely
    // demonstrating that notifications work somewhere in this file.
    await goBackground(b, holder)
    const loud = await deliverLiveMail('t-veto-control')
    await expect
      .poll(async () => (await banners(page)).map((x) => x.body), { timeout: 30_000 })
      .toEqual([loud])
    expect(await banners(b)).toEqual([])
  })

  /**
   * SIGNING OUT CLOSES THE BANNERS IT LEFT ON THE SCREEN (FR-AUTH-05).
   *
   * A notification is local data this app put on the OPERATING SYSTEM's screen, and the OS keeps it
   * there across sign-out, reload and browser restart. Without this, "sign out and remove data" wipes
   * IndexedDB while banners carrying subject lines sit in the notification centre for the next person
   * at the machine.
   *
   * THIS TEST MUST NOT USE THE SPY, and that is the whole reason it is worth running in a browser: a
   * spy records what was ASKED FOR and can never distinguish "closed" from "never shown".
   * `registration.getNotifications()` is a real read of what the browser is holding right now — the
   * only genuinely OS-adjacent observation in the area — and it is asserted non-empty BEFORE the
   * sign-out, so the emptiness afterwards is a change and not a starting condition.
   *
   * One variant only: both menu entries call the same `endSession(wipeData)`, and
   * `closeAllNotifications()` sits on the shared path. A second variant would re-run the same line.
   *
   * MUTATION-PROVEN: deleting `await closeAllNotifications()` from SessionProvider#endSession turns
   * this RED — the notification is still listed after the sign-in screen is back.
   */
  test('signing out closes the banners it left on screen', async ({ page, context }) => {
    await installBannerSpy(context)
    const holder = await focusHolder(context)
    await signInWithNotifications(page)
    await goBackground(page, holder)

    const subject = await deliverLiveMail('t-signout')
    await expect
      .poll(async () => (await liveNotifications(page)).map((n) => n.body), { timeout: 30_000 })
      .toContain(subject)

    await bringForeground(page)
    await page.getByRole('button', { name: 'Account' }).click()
    await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click()

    // The session really ended — otherwise "no notifications" could just mean the click missed.
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Sign in to', {
      timeout: 20_000,
    })
    await expect
      .poll(async () => (await liveNotifications(page)).length, { timeout: 15_000 })
      .toBe(0)
  })
})
