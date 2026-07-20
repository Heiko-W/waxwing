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
})

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
