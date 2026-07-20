import { type BrowserContext, expect, type Page } from '@playwright/test'

/**
 * The two instruments the M3.10 notification suite is built on, and the one lever that makes any of
 * it observable. Everything here was measured in a real browser before a single spec was written —
 * the numbers in the comments are observations, not expectations.
 *
 * WHY TWO OBSERVERS. They answer different questions and neither one answers both:
 *
 *  - {@link banners} reads a PASS-THROUGH spy on `ServiceWorkerRegistration.prototype.showNotification`,
 *    installed per PAGE. It is the only way to count *calls*, which is the only way to tell a leader
 *    from a follower: `notify-model.ts` tags a banner per MESSAGE, so two tabs announcing the same
 *    arrival issue two calls with the same tag and the browser REPLACES rather than stacks. Counting
 *    banners cannot see the second tab at all.
 *  - {@link liveNotifications} reads `registration.getNotifications()` — the browser's own record of
 *    what it is holding. It is per REGISTRATION, so it is shared across tabs, and it is the genuine
 *    browser-level observation: verified that `close()` really empties it, that a repeated tag
 *    replaces and a fresh tag stacks. It is what the sign-out test must use, because sign-out's whole
 *    claim is about what the OS is still holding — a spy could not distinguish "closed" from "never
 *    shown".
 *
 * The spy alone is NOT sufficient evidence and this is the trap that shaped the config: under
 * Playwright's default browser (the chromium headless shell) the spy records a call even though
 * `showNotification` then throws and `getNotifications()` returns 0. See the `chromium-notify`
 * project in playwright.read.config.ts.
 *
 * WHAT NONE OF THIS PROVES. Whether a banner is PAINTED. `showNotification()` resolving and
 * `getNotifications()` listing the result prove the browser accepted the notification and holds it;
 * there is no notification centre in headless and no automation surface for one anywhere. Nothing
 * below should be read as evidence about pixels.
 */

/** One recorded `showNotification(title, options)` call, flattened to what a spec asserts on. */
export interface BannerRecord {
  readonly title: string
  readonly body: string | null
  readonly tag: string | null
  readonly data: {
    readonly kind?: string
    readonly accountId?: string
    readonly mailboxId?: string | null
    readonly emailId?: string | null
  } | null
}

/** What the browser is actually holding, read back through a standard API. */
export interface LiveNotification {
  readonly title: string
  readonly body: string
  readonly tag: string
}

declare global {
  interface Window {
    __waxwingBanners?: BannerRecord[]
  }
}

/**
 * Install the pass-through spy for every page this context opens from now on. Call BEFORE the first
 * navigation — `addInitScript` only applies to documents created after it is registered.
 *
 * PASS-THROUGH, deliberately: the original is still called and still awaited, so the browser really
 * shows the notification and {@link liveNotifications} can corroborate the spy. A stubbing spy would
 * make every positive assertion in the suite a statement about the spy.
 *
 * It patches the PAGE realm, which is where the call happens: `notifier.ts` calls
 * `registration.showNotification(...)` on the object `getNotificationRegistration()` returns. The
 * service worker never calls it itself, so there is nothing to intercept on the worker side.
 */
export async function installBannerSpy(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    window.__waxwingBanners = []
    const proto = ServiceWorkerRegistration.prototype
    const original = proto.showNotification
    proto.showNotification = function patched(
      this: ServiceWorkerRegistration,
      title: string,
      options?: NotificationOptions,
    ): Promise<void> {
      window.__waxwingBanners?.push({
        title,
        body: options?.body ?? null,
        tag: options?.tag ?? null,
        data: (options?.data as BannerRecord['data']) ?? null,
      })
      return original.call(this, title, options)
    }
  })
}

/** Every `showNotification` call THIS page made, in order. */
export async function banners(page: Page): Promise<BannerRecord[]> {
  return await page.evaluate(() => window.__waxwingBanners ?? [])
}

/**
 * What the browser is holding for this app's service-worker registration.
 *
 * The mapping is not tidiness: a `Notification` is all prototype getters, so it does not survive
 * Playwright's structured clone — returning the objects themselves yields a list of `{}`.
 */
export async function liveNotifications(page: Page): Promise<LiveNotification[]> {
  return await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready
    const shown = await registration.getNotifications()
    return shown.map((n) => ({ title: n.title, body: n.body, tag: n.tag }))
  })
}

/**
 * Sessions are kept, never detached, and that is not a leak — it is the mechanism.
 *
 * A CDP override lives as long as the client that set it: detaching the session REVERTS
 * `setFocusEmulationEnabled`, focus emulation snaps back on, and `document.hasFocus()` returns to
 * being pinned true. Measured — the first version of this helper detached, and every page reported
 * itself focused a moment later. Playwright disposes the sessions with the context.
 */
const focusSessions = new WeakMap<Page, Promise<void>>()

async function disableFocusEmulation(page: Page): Promise<void> {
  let pending = focusSessions.get(page)
  if (pending === undefined) {
    pending = (async () => {
      const cdp = await page.context().newCDPSession(page)
      await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false })
    })()
    focusSessions.set(page, pending)
  }
  await pending
}

/**
 * Take real window focus away from `page` — the single lever the whole suite depends on.
 *
 * WHAT WAS TRIED AND REJECTED, all of it measured in this browser rather than reasoned about:
 *
 *  - **`page.bringToFront()` on its own does nothing here.** Playwright turns FOCUS EMULATION on for
 *    every page it creates, which pins `document.hasFocus()` to `true` no matter which target the
 *    browser considers active. Every page in a context reports itself focused simultaneously — an
 *    impossible state, and one under which the engine's guard vetoes every banner forever.
 *  - **`Emulation.setPageVisibilityOverride` does not exist** in this CDP version, and
 *    `visibilityState` could not be driven to `hidden` by ANY lever, `Page.setWebLifecycleState`
 *    included. It is `'visible'` in headless, always. See the note below on what that costs.
 *  - **Disabling focus emulation once, up front, is not enough.** A Playwright INPUT ACTION re-pins
 *    the page: after a single `click()` both pages report `hasFocus: true` again, and re-sending
 *    `enabled: false` does not recover it. Since every spec here must click through sign-in and the
 *    Settings switch before it can background anything, a helper that only disabled emulation would
 *    have worked in a spike and failed in every real test — and failed OPEN, with the tab counting as
 *    foreground and the absence assertions passing for nothing.
 *
 * WHAT WORKS, and why it is shaped like this: disable the emulation on both pages, then BOUNCE the
 * activation — bring `page` to the front and only then the holder. The bounce is load-bearing, not
 * superstition: after an input action the browser already considers `page` active, so activating the
 * holder directly is a no-op, and it takes a real transition away from `page` to move focus. With the
 * bounce it TRACKS: exactly one page is focused at a time, two app tabs can be backgrounded at once
 * (which is what the leader-only test needs), and clicking a backgrounded page pins it true again —
 * i.e. this reads focus, it does not blanket-stub it.
 *
 * CONSEQUENCE FOR SPECS: interacting with a backgrounded page silently foregrounds it. Any spec that
 * clicks a tab it has already backgrounded must background it again afterwards.
 *
 * WHAT IS THEREFORE NEVER EXERCISED. The engine's guard is
 * `document.visibilityState === 'visible' && document.hasFocus()`
 * (engine.ts#isDocumentForeground) and only the `hasFocus` half is reachable here — every spec in
 * this file runs with `visibilityState === 'visible'`. The visibility half has its own unit coverage,
 * added precisely because dropping it left the whole suite green. Nothing below is evidence about it.
 *
 * Crucially this stubs NOTHING the engine reads. `isDocumentForeground` still runs and still calls
 * the real `document.hasFocus()`; the cross-tab `EngineBus` `foreground?`/`foreground!` query/ack is
 * untouched and entirely real — which is the thing a browser is here to prove.
 *
 * The assertion at the end is the point of putting this in a helper: when the lever stops working
 * THIS fails, loudly, instead of four absence assertions quietly passing for nothing.
 */
export async function goBackground(page: Page, focusHolder: Page): Promise<void> {
  await disableFocusEmulation(page)
  await disableFocusEmulation(focusHolder)
  await page.bringToFront()
  await focusHolder.bringToFront()
  await expect.poll(() => page.evaluate(() => document.hasFocus()), { timeout: 5_000 }).toBe(false)
}

/**
 * Give real window focus back to `page` and prove it landed.
 *
 * Used for the cross-tab veto's second tab, where "foreground" has to be true for the RIGHT reason:
 * the tab answers the leader's `foreground?` query only when its own `isDocumentForeground()` is
 * true, so a page whose focus was merely emulated would answer for a reason the production code
 * never sees.
 */
export async function bringForeground(page: Page): Promise<void> {
  await disableFocusEmulation(page)
  await page.bringToFront()
  await expect.poll(() => page.evaluate(() => document.hasFocus()), { timeout: 5_000 }).toBe(true)
}

/**
 * Turn notifications on the way a user does: Settings → "Notify me about new mail".
 *
 * There is no shortcut worth taking here. The switch is the ONLY place the app may call
 * `Notification.requestPermission()` and the only place the Inbox id is seeded into
 * `mailboxIds` — and `DEFAULT_NOTIFICATION_PREFS` is `{ enabled: false, mailboxIds: [] }`, so a spec
 * that wrote the pref row straight into Dexie could easily enable notifications for NO folder and
 * then assert absence against a mailbox that was never armed. Driving the switch covers the seeding
 * defect it exists to prevent.
 *
 * The context already holds the `notifications` permission (see the `chromium-notify` project), so
 * `permission.state` is 'granted' and the switch takes its no-prompt branch — headless has no way to
 * answer a real permission prompt.
 */
export async function enableNotifications(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible()
  const master = page.getByLabel('Notify me about new mail')
  await expect(master).toBeVisible({ timeout: 15_000 })
  await master.click()
  await expect(master).toHaveAttribute('aria-checked', 'true', { timeout: 15_000 })
  // The dependent controls only render once the pref is written AND permission is granted
  // (`showDetails` in NotificationsSection.tsx), so their appearance is the acknowledgement that the
  // pref round-tripped through Dexie — not just that a checkbox flipped in the DOM.
  await expect(page.getByLabel('Show sender and subject')).toBeVisible({ timeout: 15_000 })
  // …and the Inbox really is armed. This is the seeding defect made visible: without it, every
  // absence assertion in the suite would hold for the wrong reason.
  await expect(
    page.getByRole('group', { name: 'Notify for these folders' }).getByRole('checkbox', {
      name: 'Inbox',
    }),
  ).toBeChecked()
}
