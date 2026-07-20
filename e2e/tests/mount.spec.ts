import { expect, type Page, test } from '@playwright/test'

/**
 * The app under a `/mail/` MOUNT (M3.10; handed over from M3.5 and M3.6).
 *
 * WHAT THIS IS FOR. Stalwart serves the webmail client under a path prefix, not at the origin
 * root (FR-DEP-02), and until now no E2E suite had ever seen that shape — `vite preview` serves
 * at `/` and nothing else. M3.5's changelog records the defect that lives in the gap: the built
 * `index.html` needs its `<base>` element, and without it a deep-link reload of a route like
 * `/mail/mail/inbox/42` resolved the relative `./assets/index-*.js` (which `base: './'` in
 * vite.config.ts emits on purpose) against the ROUTE path — `/mail/mail/inbox/assets/…` — 404'd
 * the entry chunk and left a WHITE SCREEN.
 *
 * The property that makes this worth a suite of its own: the defect is INVISIBLE at the root and
 * INVISIBLE at the mount root, and fatal only on a deep link under the mount. Both of the cheap
 * places to look are clean. The first test below is that control — it passes with the `<base>`
 * element removed — and it is here precisely to show that the second test is the one carrying
 * the weight.
 *
 * MUTATION-PROVEN (M3.10 wave 0): deleting `<base href="/" />` from apps/web/index.html and
 * rebuilding turns the deep-link test RED (the entry chunk 404s, no heading renders) while the
 * mount-root test stays GREEN. A regression test nobody has watched fail is worth nothing, so
 * that asymmetry was observed, not assumed.
 *
 * No fixture: this is a static-serving property and needs no JMAP server. The app therefore
 * settles on its sign-in screen, which is all the evidence "the bundle booted" requires.
 */

/** Must match MOUNT in ../mount-server.mjs (that file is dependency-free .mjs, so no shared import). */
const MOUNT = '/mail/'

/**
 * A route with several segments below the mount. Depth is the whole point: `./assets/…` resolves
 * against the document's directory, so only a route deeper than the mount can expose a missing
 * `<base>`. `/mail/` + the app's own `/mail/:mailboxId/:emailId` route (app/route/route.ts) is
 * how the two coordinate spaces documented in notify/click-route.ts actually stack up in a URL.
 *
 * It is also, exactly, the href a NOTIFICATION CLICK would open under this mount:
 * `notificationTargetHref(ROOT, { mailboxId: 'inbox', emailId: '42' })` where
 * `ROOT = appRoot(self.location.href)`. That makes the tests below the browser half of M3.6's
 * click-route claim — the string math is unit-covered (click-route.test.ts) and the click itself is
 * not dispatchable from Playwright (see the header of notify.spec.ts), so "the URL the worker would
 * open is one this deployment actually serves" is the part a browser can settle, and this is where
 * it is settled. The service-worker test further down carries the other half: that the worker's own
 * root really IS the mount, which is what `ROOT` is read from.
 */
const DEEP_LINK = `${MOUNT}mail/inbox/42`

test.describe('/mail/ mount', () => {
  test('the mount root boots the app', async ({ page }) => {
    const broken = brokenRequests(page)

    await page.goto(MOUNT)

    await expect(page.getByRole('heading', { level: 1 })).toContainText('Sign in to')
    expect(broken).toEqual([])

    // The mount prefix reached the document, so every relative URL in the app — assets,
    // config.json, theme.css, the service-worker scope — resolves under it.
    expect(await page.evaluate(() => document.baseURI)).toBe(new URL(MOUNT, page.url()).toString())
  })

  test('a deep-link reload under the mount boots the app, not a white screen', async ({ page }) => {
    const heading = page.getByRole('heading', { level: 1 })

    // The COLD load: a document fetched straight at the deep route, with no client-side routing
    // to set anything up. This is already the failing case for the missing-`<base>` defect.
    const cold = brokenRequests(page)
    await page.goto(DEEP_LINK)
    // The heading is the proof of boot: it only exists if the entry chunk resolved, executed and
    // mounted React. Under the missing-`<base>` mutation this is a blank document instead.
    await expect(heading).toContainText('Sign in to')
    // Assert the failure MECHANISM too, not just the symptom. A future regression that white-
    // screens for some other reason should not be mistaken for this one, and a 404 on the entry
    // chunk is the fingerprint M3.5 actually recorded.
    expect(cold).toEqual([])

    // Then the literal RELOAD from the bug report. It gets its OWN collector, started only once
    // the cold load has settled — and that ordering is load-bearing rather than tidiness.
    // Reloading a document that is still fetching cancels its in-flight modulepreloads, and those
    // surface as `requestfailed` with `net::ERR_ABORTED`, which this helper would then count as a
    // broken resource. That is a harness artefact with nothing to do with the defect under test,
    // whose fingerprint is a 404 on a path that swallowed the route — and it is timing-dependent,
    // so the test passed on the machine that wrote it and failed on the next one. Settling first
    // also makes this a genuine reload of a loaded page, which is what "deep-link reload" means.
    const reloaded = brokenRequests(page)
    await page.reload()
    await expect(heading).toContainText('Sign in to')
    expect(reloaded).toEqual([])

    // The deep route did not become the base. This is the assertion that would have caught the
    // original defect at its source rather than at its consequence.
    expect(await page.evaluate(() => document.baseURI)).toBe(new URL(MOUNT, page.url()).toString())
  })

  /**
   * The SERVICE WORKER half of the mount (M3.10 wave 2). The two tests above prove the bundle is
   * SERVED correctly under a prefix; these prove it is CACHED correctly under one, which is a
   * separate property with its own separate way of breaking.
   *
   * Everything the worker does is anchored to `appRoot(self.location)` (sw-routes.ts) rather than to
   * `/`, and the precache is keyed by URL. Under a mount that anchoring is load-bearing in two
   * places, and at the root it is invisible in both — `/` and the mount prefix are the same string
   * there, so every leading-slash literal a developer might reach for happens to work. This is the
   * same asymmetry the `<base>` tests above exist for, one layer down.
   */
  test('offline, a deep link under the mount is answered from the precache', async ({
    page,
    context,
  }) => {
    const heading = page.getByRole('heading', { level: 1 })

    await page.goto(DEEP_LINK)
    await expect(heading).toContainText('Sign in to')

    // From here on the assertion is `booted()`, not a specific heading — see its comment. The
    // onboarding branch the app picks depends on a network probe, so it CHANGES when we go offline,
    // and pinning the online wording would make these tests red for a reason that is not the defect.

    // Gain control. A freshly registered worker never controls the page that registered it —
    // `sw.ts` calls neither `skipWaiting()` nor `clientsClaim()`, deliberately — so until this
    // reload the worker's fetch handler has not run once and an offline assertion would be
    // measuring Chromium's HTTP cache. Gate on `controller`, not on `ready`: `ready` resolves on an
    // ACTIVE worker and says nothing about THIS page being controlled.
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => {}))
    await page.reload()
    await expect
      .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null), {
        timeout: 15_000,
      })
      .toBe(true)

    // The worker registered under the MOUNT, not at the origin root. If this were `/` the precache
    // would be keyed off the wrong scope and every assertion below would be about a different app.
    expect(await page.evaluate(() => navigator.serviceWorker.ready.then((r) => r.scope))).toBe(
      new URL(MOUNT, page.url()).toString(),
    )

    await context.setOffline(true)
    const broken = brokenRequests(page)
    await page.reload()

    // The whole point: with no network at all, a deep route several segments below the mount is
    // still answered with the precached shell. `sw.ts` gets this right by resolving
    // `createHandlerBoundToURL('index.html')` against the WORKER's own location — a leading-slash
    // '/index.html' literal would look identical at the root and miss the precache entirely here.
    await booted(page)
    expect(broken).toEqual([])

    // The guard: this test must not be able to pass while the browser is online.
    expect(await page.evaluate(() => navigator.onLine)).toBe(false)
  })

  test('offline, a mailbox Id that is a reserved word still gets the shell', async ({
    page,
    context,
  }) => {
    // RFC 8620 Ids are `[A-Za-z0-9_-]`, so a server is free to hand out a mailbox Id of `api` or
    // `auth`. Stacked under a Stalwart mount the two coordinate spaces documented in
    // notify/click-route.ts give `/mail/` (the MOUNT) + `mail/api` (the APP's own route for that
    // mailbox) = `/mail/mail/api`. `navigateDenylist` anchors the reserved words to the app root so
    // only the FIRST segment below it counts; matched anywhere in the path, that URL would be read
    // as Stalwart's `/api` and denied the shell, and reloading that mailbox offline would show the
    // browser's error page instead of the app.
    //
    // Getting this URL shape right is the whole test, and it is easy to get wrong: `/mail/api` —
    // the obvious guess — is a DIFFERENT case, one the denylist denies on purpose, because directly
    // below the mount root is exactly where the server's own paths live. Unit-covered from both
    // sides in sw-routes.test.ts ("does not mistake a MAILBOX for a server path" and "anchors to
    // the mount prefix"); this is the wiring in a real worker.
    await page.goto(MOUNT)
    await booted(page)
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => {}))
    await page.reload()
    await expect
      .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null), {
        timeout: 15_000,
      })
      .toBe(true)

    await context.setOffline(true)

    // The reserved-word mailbox, and a SEARCH URL — the second is the `HAS_EXTENSION`-stops-at-`?`
    // case: Workbox matches the denylist against `pathname + search`, so an entry that ran past the
    // query string would swallow this one too.
    for (const path of [`${MOUNT}mail/api`, `${MOUNT}mail/inbox?q=from:a.b@c.de`]) {
      const broken = brokenRequests(page)
      await page.goto(path)
      await booted(page)
      expect(broken, `navigating to ${path} offline`).toEqual([])
    }

    expect(await page.evaluate(() => navigator.onLine)).toBe(false)
  })
})

/**
 * The app's entry chunk resolved, executed and mounted React — which is the only thing the offline
 * tests need to know, and the most they can honestly assert.
 *
 * NOT a text match on the heading, deliberately. Which onboarding screen the app settles on is
 * decided by `SessionProvider`'s same-origin `services.probe()`: reachable → the sign-in form
 * ("Sign in to <host>"), unreachable → the connect screen ("Welcome to Waxwing"). Going offline
 * flips that probe, so the wording the two ONLINE tests above assert is not the wording an offline
 * test sees. Pinning it anyway is how this test first went red — for the app changing screens, not
 * for the precache failing, which is the only thing under test here. The white screen these tests
 * exist to catch has no `<h1>` at all, so presence is the discriminating signal and the text is
 * noise.
 */
async function booted(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('heading', { level: 1 })).not.toBeEmpty()
}

/**
 * Collects failed / 4xx / 5xx requests for the app's OWN resources under the mount, so a boot
 * failure can be attributed to the resource that caused it. Returns a live array — read it after
 * the navigation settles.
 *
 * Scoped to the mount prefix on purpose. Stalwart's paths (`/.well-known`, `/jmap`, …) live at
 * the ORIGIN ROOT, not under the mount — the JMAP server owns the origin and the app is a guest
 * in a subdirectory — and this suite runs with no fixture, so the same-origin probe in
 * SessionProvider gets a 502 from the mount server's proxy every time. That 502 is the harness
 * working as designed, not a defect, and folding it into the assertion would mean either a
 * permanently-failing test or a Docker dependency this suite does not otherwise need. What the
 * mount suite is actually about is whether the app's own assets resolve, and that is exactly the
 * set this filter keeps.
 */
function brokenRequests(page: Page): string[] {
  const broken: string[] = []
  const underMount = (url: string) => new URL(url).pathname.startsWith(MOUNT)
  page.on('requestfailed', (request) => {
    if (!underMount(request.url())) return
    broken.push(`${request.failure()?.errorText ?? 'failed'} ${request.url()}`)
  })
  page.on('response', (response) => {
    if (!underMount(response.url()) || response.status() < 400) return
    broken.push(`${response.status()} ${response.url()}`)
  })
  return broken
}
