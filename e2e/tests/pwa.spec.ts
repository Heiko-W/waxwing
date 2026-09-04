import { expect, type Page, test } from '@playwright/test'
import { READ_SUBJECTS, seedReadMail } from '../stalwart/seed-read.mjs'
import { revealPasswordForm, SYNC_BUDGET_MS } from './helpers'

/**
 * M3.10 PWA suite — the first tests in this repo whose subject is the SERVICE WORKER (FR-OFF-01,
 * NFR-SEC-02; handed over from M3.5).
 *
 * WHY ITS OWN FILE. Every other suite runs with a worker quietly active and never looks at it. These
 * tests depend on it, and specifically on a piece of choreography that is easy to get wrong and
 * silent when you do — so it is spelled out once, here, rather than re-derived per test:
 *
 *   **A freshly registered worker does not control the page that registered it.** `sw.ts` calls
 *   neither `skipWaiting()` nor `clientsClaim()`, deliberately (its header explains: claiming a live
 *   tab drops the old precache and the tab's next lazy chunk 404s). So the first load of a fresh
 *   BrowserContext is served entirely by the network, the worker's `fetch` handler never runs, and
 *   an offline assertion made at that point would prove nothing about the precache. Control arrives
 *   only on the NEXT navigation. Hence every test below reloads once, and gates on
 *   `navigator.serviceWorker.controller !== null` — NOT on `navigator.serviceWorker.ready`, which
 *   resolves on an ACTIVE worker and says nothing about this page being controlled. That is the same
 *   distinction `register-sw.ts` encodes as `isStale()`, and getting it wrong yields a test that
 *   passes vacuously.
 *
 * Runs under playwright.read.config.ts: it needs the seeded corpus and the same-origin proxy, and
 * that config is already serial with a per-test reseed. It needs the PRODUCTION bundle too — the
 * worker is registered behind `import.meta.env.PROD` (use-update-prompt.ts) — which `vite preview`
 * satisfies and `pnpm dev` deliberately does not.
 */

const CREDENTIALS = { user: 'alice@waxwing.test', pass: 'waxwing-e2e-Pw1!' }

const messageList = (page: Page) => page.getByRole('region', { name: 'Messages', exact: true })

/**
 * Stalwart's paths, which live at the ORIGIN ROOT and are not the app's own resources. Offline, the
 * app's boot legitimately fails against every one of them; folding those failures into a
 * "did the shell load" assertion would make it permanently red for the wrong reason.
 */
const SERVER_PATHS = /^\/(jmap|\.well-known|auth|login|api|logo)(\/|$)/

async function login(page: Page, options: { stay?: boolean } = {}): Promise<void> {
  await page.goto('/')
  await revealPasswordForm(page)
  await page.getByLabel('Username', { exact: true }).fill(CREDENTIALS.user)
  await page.getByLabel('Password', { exact: true }).fill(CREDENTIALS.pass)
  if (options.stay) await page.getByLabel('Stay signed in').check()
  await page.getByRole('button', { name: 'Sign in with a password', exact: true }).click()
  await expect(page.getByRole('navigation', { name: 'Folders' })).toBeVisible({
    timeout: SYNC_BUDGET_MS,
  })
  await page.getByRole('treeitem', { name: /Inbox/ }).click()
  await expect(messageList(page).getByText(READ_SUBJECTS.plain)).toBeVisible({
    timeout: SYNC_BUDGET_MS,
  })
}

/**
 * Reload, and come back with the page under the worker's control.
 *
 * The assertion is the point — see the file header. Without it a later offline reload could be
 * answered by the HTTP cache rather than the precache, and the test would be measuring Chromium's
 * disk cache instead of our service worker.
 */
async function reloadIntoServiceWorkerControl(page: Page): Promise<void> {
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => {}))
  await page.reload()
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null), {
      timeout: 15_000,
    })
    .toBe(true)
}

/** Failed / 4xx / 5xx responses for the APP's own resources — Stalwart's paths excluded, see above. */
function brokenAppRequests(page: Page): string[] {
  const broken: string[] = []
  const isApp = (url: string) => !SERVER_PATHS.test(new URL(url).pathname)
  page.on('requestfailed', (request) => {
    if (!isApp(request.url())) return
    broken.push(`${request.failure()?.errorText ?? 'failed'} ${request.url()}`)
  })
  page.on('response', (response) => {
    if (!isApp(response.url()) || response.status() < 400) return
    broken.push(`${response.status()} ${response.url()}`)
  })
  return broken
}

test.beforeEach(async () => {
  await seedReadMail()
})

test.describe('M3.10 pwa', () => {
  test('offline, a reopen boots the precached shell AND the cached mail behind it (FR-OFF-01)', async ({
    page,
    context,
  }) => {
    // ── WHAT THIS TEST IS, AND WHAT IT USED TO BE ─────────────────────────────────────────────
    //
    // M3.5's hand-over asked for "an offline reopen with an authenticated session, showing cached
    // MAIL behind the offline marker". Until 2026-09-04 the app could not do the second half, and
    // this test was a TRIPWIRE that pinned the gap with `toBeHidden()` on the mail: the precached
    // shell booted, `restore()` succeeded, and then `SessionProvider.boot()` fed the restored
    // session into `connectSession()` — which fetches the JMAP Session document from the network.
    // Offline that threw, and the reader got the sign-in form reading "Could not reach the server"
    // with a fully populated replica sitting behind it, unreachable.
    //
    // R-78 / ADR-041 closed it, and the tripwire did its job: the fix made this file go red, and
    // this is the rewrite it demanded. The Session document is now kept beside the credentials in
    // the encrypted `waxwing-auth` store — NOT in the service-worker cache, whose invariant is
    // still zero bytes from JMAP (the test below this one is what proves that), and not in the
    // replica, which outlives a plain sign-out. A cold start with no network rebuilds its client
    // from it.
    //
    // The four assertions below are the four halves of FR-OFF-01's sentence, in order: the shell
    // loads from the precache, the session comes back, the cached mail is there, and it is clearly
    // marked "offline".
    await login(page, { stay: true })
    await reloadIntoServiceWorkerControl(page)

    // The corpus is on screen and in the replica BEFORE we pull the plug, so "the mail was never
    // there" cannot be confused with "the mail was there and could not be reached".
    await expect(messageList(page).getByText(READ_SUBJECTS.plain)).toBeVisible({
      timeout: SYNC_BUDGET_MS,
    })

    await context.setOffline(true)

    const broken = brokenAppRequests(page)
    await page.reload()

    // 1. The shell booted: the document, the entry chunk and every eager chunk came out of the
    //    precache with no network at all. This is the assertion the precache exists for, and it is
    //    made on the REQUESTS rather than on any one element, so it still means "nothing of ours
    //    went to the network" now that the destination is the app rather than the sign-in form.
    await expect(page.getByRole('navigation', { name: 'Folders' })).toBeVisible({
      timeout: SYNC_BUDGET_MS,
    })
    expect(broken).toEqual([])

    // The guard. Without it this test would pass just as happily against a browser that never went
    // offline, and would be asserting nothing whatsoever about the precache.
    expect(await page.evaluate(() => navigator.onLine)).toBe(false)

    // 2 + 3. The session came back without a server, and the mail behind it is reachable — the
    //        half M3.5 asked for and could not have. The sign-in form is the failure this replaces,
    //        so its absence is asserted too rather than merely implied by the mail being there.
    await expect(page.getByRole('button', { name: 'Sign in with a password' })).toBeHidden()
    await expect(messageList(page).getByText(READ_SUBJECTS.plain)).toBeVisible({
      timeout: SYNC_BUDGET_MS,
    })

    // 4. "clearly marked offline", in the app's own existing words — the same chip a live session
    //    raises when the connection drops (`offline.spec.ts`). No second vocabulary was invented
    //    for this state, and this is what says so.
    await expect(page.getByRole('status').filter({ hasText: 'Offline' })).toBeVisible({
      timeout: SYNC_BUDGET_MS,
    })

    // And the message opens: a list of subjects would be a thinner promise than FR-OFF-01 makes.
    // The body comes out of the replica, through the same reading pane an online session uses.
    await messageList(page).getByText(READ_SUBJECTS.plain).click()
    await expect(page.getByRole('heading', { name: READ_SUBJECTS.plain })).toBeVisible({
      timeout: SYNC_BUDGET_MS,
    })
  })

  test('offline, a reopen without "stay signed in" still lands on the sign-in form', async ({
    page,
    context,
  }) => {
    // The other half of the decision, and it is deliberate (FR-AUTH-04): with the box unticked
    // NOTHING about the session is persisted, so there is no `restore()` — and therefore, by the
    // controller's own guard, no stored Session document either. The reader sees the sign-in form,
    // which is the honest answer: this device was not asked to remember anything.
    //
    // Here rather than in a unit test because the guard spans two modules and one storage boundary,
    // and because a regression would be silent: the failure mode is a session document quietly
    // outliving a session the user asked not to keep.
    // The worker is put in control BEFORE the sign-in here, not after it. Reloading afterwards
    // would end this session by itself — which is exactly what "stay signed in" unticked means —
    // and the test would then be measuring its own setup rather than the offline boot.
    await page.goto('/')
    await reloadIntoServiceWorkerControl(page)
    await login(page)
    await expect(messageList(page).getByText(READ_SUBJECTS.plain)).toBeVisible({
      timeout: SYNC_BUDGET_MS,
    })

    await context.setOffline(true)
    await page.reload()

    // No session: no folder tree, no mail, and onboarding on screen instead.
    //
    // WHICH onboarding step is deliberately not pinned. With no persisted session the boot falls
    // through to the same-origin probe, and offline that probe cannot answer — so this lands on
    // the manual "connect to a server" step ("Welcome to Waxwing") rather than the sign-in step
    // ("Webmail for …"). That is pre-existing behaviour, unchanged by FR-OFF-01, and pinning it
    // here would make this test fail for a reason it is not about.
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      /Welcome to Waxwing|Webmail for/,
      { timeout: SYNC_BUDGET_MS },
    )
    expect(await page.evaluate(() => navigator.onLine)).toBe(false)
    await expect(page.getByRole('navigation', { name: 'Folders' })).toBeHidden()
    await expect(messageList(page).getByText(READ_SUBJECTS.plain)).toBeHidden()
  })

  test('a real read session leaves no JMAP bytes in Cache Storage', async ({ page }) => {
    // NFR-SEC-02 / the sw-routes.ts invariant: the worker caches ZERO bytes from JMAP. Mail is
    // authenticated content — caching it would write plaintext into Cache Storage, outside the
    // AES-GCM secret store, outside M3.4's eviction budget, and it would survive a plain sign-out
    // (only "sign out & remove data" clears Cache Storage).
    //
    // WHAT THIS PROVES, AND WHAT IT DOES NOT. It is a SAMPLE, not a proof. It can only speak for the
    // URLs this particular session happened to fetch — sign-in, an initial sync, opening a message
    // and its body. A route that cached some JMAP path this session never touches would sail past
    // it. The general guarantee is structural and lives where it can be proved exhaustively: the
    // anchored predicates in sw-routes.ts and their unit tests. What this adds is the wiring — that
    // those predicates are the ones actually installed in a running worker, against a real server,
    // with real URLs the fixture chose rather than URLs a test author imagined.
    await login(page, { stay: true })
    await reloadIntoServiceWorkerControl(page)

    // Now do the things that fetch from JMAP while CONTROLLED, so the worker's fetch handler sees
    // them. Before the reload above it saw nothing at all — which is exactly how this assertion
    // could look green while proving nothing.
    await messageList(page).getByText(READ_SUBJECTS.plain).click()
    await expect(page.getByRole('heading', { level: 2 })).toContainText(READ_SUBJECTS.plain, {
      timeout: SYNC_BUDGET_MS,
    })

    const cached = await page.evaluate(async () => {
      const out: { cache: string; url: string }[] = []
      for (const name of await caches.keys()) {
        for (const request of await (await caches.open(name)).keys()) {
          out.push({ cache: name, url: request.url })
        }
      }
      return out
    })

    // THE POSITIVE CONTROL. An empty Cache Storage would satisfy the negative below trivially, and
    // that is a real possibility rather than a paranoid one — it is what a worker that failed to
    // install, or never took control, looks like. Assert the caches are populated first, so the
    // absence assertion is made against a mechanism that is provably live.
    const names = new Set(cached.map((entry) => entry.cache))
    expect([...names].some((name) => name.startsWith('workbox-precache'))).toBe(true)
    expect(names).toContain('waxwing-deploy')
    expect(names).toContain('waxwing-branding')

    // The negative. `isJmapRequest`'s own shape (sw-routes.ts), applied to every cached URL.
    const jmap = cached.filter((entry) => /(^|\/)jmap(\/|$)/.test(new URL(entry.url).pathname))
    expect(jmap).toEqual([])
  })
})
