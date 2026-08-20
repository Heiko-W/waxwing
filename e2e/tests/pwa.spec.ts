import { expect, type Page, test } from '@playwright/test'
import { READ_SUBJECTS, seedReadMail } from '../stalwart/seed-read.mjs'
import { revealPasswordForm } from './helpers'

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
  await expect(page.getByRole('navigation', { name: 'Folders' })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('treeitem', { name: /Inbox/ }).click()
  await expect(messageList(page).getByText(READ_SUBJECTS.plain)).toBeVisible({ timeout: 30_000 })
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
  test('offline, a reopen boots the precached shell — and gets no further than sign-in', async ({
    page,
    context,
  }) => {
    // ── WHAT THIS TEST FOUND, WHICH IS NOT WHAT IT WAS COMMISSIONED TO ASSERT ──────────────────
    //
    // M3.5's hand-over asked for "an offline reopen with an authenticated session, showing cached
    // MAIL behind the offline marker". That is NOT what the app does today, and the gap is a
    // product defect rather than a harness limitation. Measured here before this test was written:
    //
    //   * The precached shell boots offline. That half works, and is what this test asserts.
    //   * `AuthController.restore()` also works offline exactly as its doc-comment claims
    //     ("Restores a session on cold boot without a fresh login (offline start, FR-AUTH-03)"): it
    //     only reads the AES-GCM secret store in IndexedDB, and with "Stay signed in" ticked the
    //     record is there.
    //   * But `SessionProvider.boot()` step B does not stop there — it feeds the restored session
    //     straight into `connectSession()`, which calls `services.connect()` and FETCHES the JMAP
    //     session object from the network. `jmapSession` is held in memory only; it is persisted
    //     nowhere. Offline that fetch throws, `boot()`'s outer catch turns it into `goToLogin(…,
    //     errToOnboard(error))`, and the user lands on the sign-in screen reading "Could not reach
    //     the server" — with a fully populated local replica sitting behind it, unreachable.
    //
    // So FR-OFF-01's promise stops one step short: the shell opens offline and then shows a form
    // that cannot be submitted offline. Note the fix cannot be "cache the session document": the
    // session object lives at a JMAP path, and sw-routes.ts's central invariant is that the worker
    // caches ZERO bytes from JMAP. It would have to be persisted into the encrypted replica beside
    // everything else, which is a product change, not a test change.
    //
    // THIS TEST IS THEREFORE A TRIPWIRE AS WELL AS A REGRESSION GATE. The `toBeHidden()` assertion
    // at the bottom pins the CURRENT limit deliberately. When the session gap is closed it will go
    // RED, and whoever closes it must come here and rewrite this test to assert the cached mail the
    // hand-over originally asked for. A silent pass would let the fix ship with the coverage still
    // claiming the old behaviour.
    await login(page, { stay: true })
    await reloadIntoServiceWorkerControl(page)

    // The corpus is on screen and in the replica BEFORE we pull the plug, so "the mail was never
    // there" cannot be confused with "the mail was there and could not be reached".
    await expect(messageList(page).getByText(READ_SUBJECTS.plain)).toBeVisible({ timeout: 30_000 })

    await context.setOffline(true)

    const broken = brokenAppRequests(page)
    await page.reload()

    // The shell booted: the document, the entry chunk and every eager chunk came out of the
    // precache with no network at all. This is the assertion the precache exists for.
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Webmail for', {
      timeout: 30_000,
    })
    expect(broken).toEqual([])

    // The guard. Without it this test would pass just as happily against a browser that never went
    // offline, and would be asserting nothing whatsoever about the precache.
    expect(await page.evaluate(() => navigator.onLine)).toBe(false)

    // The tripwire — see the block comment above. Today the cached mail is NOT reachable offline.
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
      timeout: 30_000,
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
